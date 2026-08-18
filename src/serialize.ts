/**
 * Serialize harness messages into vLLM chat-completions requests for local
 * Qwen models.
 *
 * Multimodal policy: a user message with image parts serializes to a
 * `content` array of `text` and `image_url` (data URL) parts ONLY when the
 * selected model declares `multimodal: true`. The gate runs before any
 * network I/O: a text-only model (or a missing attachment service) with an
 * image in flight is refused with `UNSUPPORTED_CONTENT`, naming the model.
 * Image bytes are resolved through the durable attachment service, so a
 * session log reference is the only image address this adapter understands.
 *
 * Reasoning policy: the selected effort (`GenerateOptions.reasoningEffort`,
 * else the model's configured `defaultEffort`) maps through the model's
 * configured effort table to a wire `reasoning_effort` spelling
 * (Qwen3.8-27B's official levels: `xhigh` (default), `medium`, `low`). The
 * `off` level (wire `none` by convention; `null` on a pre-parameter build)
  * sends its wire value plus the `offMode` expression: `chat-template-kwargs` appends
 * `chat_template_kwargs: { enable_thinking: false }` (the model's documented
 * non-thinking mode; thinking is ON by default); `omit` appends nothing.
 * `session-title` auxiliary calls are forced to `off`: a short title never
 * needs thinking.
 *
 * Preserved thinking: Qwen3.8 retains thinking blocks from historical
 * messages by default (`preserve_thinking` ON). The adapter replays assistant
 * reasoning as `reasoning_content` on tool-call-free history turns — the
 * shape the official Qwen3.8 example reconstructs — and sends
 * `chat_template_kwargs: { preserve_thinking: false }` when the model entry
 * sets `preserveThinking: false` (in which case no reasoning is replayed).
 *
 * History replay: tool results become `role: 'tool'` messages with text-only
 * content (an image inside a tool result is refused, not silently erased).
 *
 * @module dsh-llm-qwen-local/serialize
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { QwenLocalModel, QwenLocalReasoning } from './config.js'
import type { WireImagePart, WireMessage, WireRequest, WireTextPart, WireTool } from './wire.js'

/** Minimal text-only model record for unlisted ids (advisory catalog). */
export function unlistedModel(id: string): QwenLocalModel {
  return { id, multimodal: false }
}

/** The request-level wire control fields one resolved model contributes. */
interface ResolvedWireControl {
  reasoningEffort?: string
  chatTemplateKwargs?: { enable_thinking?: false; preserve_thinking?: false }
}

/**
 * The off level's canonical wire value. vLLM's accepted `reasoning_effort`
 * vocabulary is `none`/`minimal`/`low`/`medium`/`high`/`xhigh` — `none` is
 * the "no thinking" spelling (verified against a live Qwen3.8 vLLM build;
 * `off` itself is a 400). It is sent together with
 * `chat_template_kwargs: { enable_thinking: false }`: the effort value tells
 * the reasoning parser to discard thinking tokens, the template kwarg stops
 * the model from generating them. A deployment whose vLLM predates
 * `none` (400s on it) expresses off the old way — `wire: null` plus
 * `offMode: chat-template-kwargs` without the effort, or a custom
 * non-null wire spelling.
 */
const OFF_WIRE_EFFORT = 'none'

/**
 * Map the selected (or configured-default) effort and the model's
 * `preserveThinking` flag to wire control fields. Only kwargs that deviate
 * from the template defaults (both on) are sent.
 * @throws LlmError `UNSUPPORTED_REASONING_EFFORT` for a level the model does not declare.
 */
function resolveWireControl(options: GenerateOptions, model: QwenLocalModel): ResolvedWireControl {
  const kwargs: { enable_thinking?: false; preserve_thinking?: false } = {}
  if (model.preserveThinking === false) kwargs.preserve_thinking = false
  const reasoning: QwenLocalReasoning | undefined = model.reasoning
  if (reasoning === undefined) {
    if (options.reasoningEffort !== undefined) {
      throw new LlmError(
        `model "${model.id}" does not expose selectable reasoning efforts`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
    return Object.keys(kwargs).length > 0 ? { chatTemplateKwargs: kwargs } : {}
  }
  // A short title must be produced fast and visible: force the off level —
  // only when the model actually declares one; a model without `off` cannot
  // disable thinking at all, so the title call keeps the ordinary default.
  const hasOff = reasoning.efforts.some(entry => entry.id === 'off')
  const selected = options.purpose === 'session-title' && hasOff
    ? 'off'
    : options.reasoningEffort ?? reasoning.defaultEffort
  if (selected === undefined) {
    return Object.keys(kwargs).length > 0 ? { chatTemplateKwargs: kwargs } : {}
  }
  const effort = reasoning.efforts.find(entry => entry.id === selected)
  if (effort === undefined) {
    throw new LlmError(
      `model "${model.id}" does not support reasoning effort "${selected}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (effort.wire === null) {
    // The off level sends the canonical `none` effort so the reasoning
    // parser drops thinking tokens, plus the offMode expression:
    // `chat-template-kwargs` appends `enable_thinking: false` (the model's
    // documented non-thinking mode); `omit` appends nothing.
    kwargs.enable_thinking = false
    if (reasoning.offMode === 'omit') delete kwargs.enable_thinking
    return { reasoningEffort: OFF_WIRE_EFFORT, ...(Object.keys(kwargs).length > 0 ? { chatTemplateKwargs: kwargs } : {}) }
  }
  return {
    reasoningEffort: effort.wire,
    ...(Object.keys(kwargs).length > 0 ? { chatTemplateKwargs: kwargs } : {}),
  }
}

/** Join the text blocks of a content list. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Refuse image content on a path the wire format cannot carry for this model. */
function assertNoImage(blocks: readonly ContentBlock[], model: QwenLocalModel, where: string): void {
  if (contentHasImage(blocks)) {
    throw new LlmError(
      `model "${model.id}" does not accept images ${where}`,
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** Serialize one multimodal user message's parts, resolving image bytes durably. */
async function serializeParts(
  blocks: readonly ContentBlock[],
  model: QwenLocalModel,
  attachments: AttachmentStore,
  signal: AbortSignal | undefined,
): Promise<(WireTextPart | WireImagePart)[]> {
  const parts: (WireTextPart | WireImagePart)[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      const stored = await attachments.readImage(block.attachment, signal)
      const base64 = Buffer.from(stored.data).toString('base64')
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${stored.ref.mediaType};base64,${base64}` },
      })
      continue
    }
    // tool-result blocks are expanded by the caller, never nested here.
  }
  return parts
}

/**
 * Serialize one assistant history message. With `preserve_thinking` at its
 * template default (ON), assistant reasoning is replayed as
 * `reasoning_content` on tool-call-free turns — the exact reconstruction the
 * official Qwen3.8 example performs (`if not has_tool_calls:
 * msg['reasoning_content'] = thinking`). Tool-call turns and
 * `preserveThinking: false` models send no reasoning.
 */
function serializeAssistant(message: Message, model: QwenLocalModel): WireMessage {
  assertNoImage(message.content, model, 'in assistant history')
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))
  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null: pure tool-call turns replay
    // content: "" plus tool_calls, and some gateways reject null outright.
    content: text,
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
    ...toolCalls.length === 0 && reasoning.length > 0 && model.preserveThinking !== false
      ? { reasoning_content: reasoning }
      : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text (and
 * image parts) first and its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @param model - the resolved model configuration (multimodal gate).
 * @param attachments - durable byte resolver, required whenever an image is present.
 * @param signal - cancellation for attachment reads.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export async function serializeMessages(
  messages: Message[],
  model: QwenLocalModel,
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      assertNoImage(message.content, model, 'in system content')
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message, model))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but the wire wants them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const rest = message.content.filter(block => block.type !== 'tool-result')
    const hasImage = rest.some(block => block.type === 'image')
    if (hasImage) {
      if (!model.multimodal) {
        throw new LlmError(
          `model "${model.id}" is configured text-only (multimodal: false); remove the image `
          + 'or enable the model\'s multimodal switch',
          'UNSUPPORTED_CONTENT',
        )
      }
      if (attachments === undefined) {
        throw new LlmError(
          `image input for model "${model.id}" requires the durable attachment service`,
          'UNSUPPORTED_CONTENT',
        )
      }
      wire.push({ role: 'user', content: await serializeParts(rest, model, attachments, signal) })
    } else {
      const text = flattenText(rest)
      if (text.length > 0 || toolResults.length === 0) {
        wire.push({ role: 'user', content: text })
      }
    }
    for (const result of toolResults) {
      assertNoImage(result.content, model, 'inside tool results')
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * deployment defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param model - the resolved model configuration.
 * @param attachments - durable byte resolver; `undefined` refuses any image.
 * @returns the chat-completions request body.
 */
export async function serializeRequest(
  options: GenerateOptions,
  model: QwenLocalModel,
  attachments: AttachmentStore | undefined,
): Promise<WireRequest> {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...await serializeMessages(options.messages, model, attachments, options.signal))

  const tools: WireTool[] | undefined = options.tools === undefined || options.tools.length === 0
    ? undefined
    : options.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
  const control = resolveWireControl(options, model)

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...control.reasoningEffort !== undefined ? { reasoning_effort: control.reasoningEffort } : {},
    ...control.chatTemplateKwargs !== undefined ? { chat_template_kwargs: control.chatTemplateKwargs } : {},
    ...tools !== undefined ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}
