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
 * Request-image projection: image bytes go through the durable attachment
 * service's request-image pipeline (`readImageRequest`) when the mounted
 * provider implements it — deterministic aspect-preserving projection to the
 * model's pixel/byte budget plus cached variants — and fall back to the
 * normalized master bytes (`readImage`) when the provider cannot project.
 * Harness note: since the LLM runtime now projects images to text
 * placeholders for models whose `inputModalities` exclude `image`, the
 * text-only gate below is a direct-adapter defense; the harness path replaces
 * the image before the adapter ever sees it.
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
 * content. An image inside a tool result is SPLIT for a multimodal model:
 * the tool message keeps its text (or the `(no output)` placeholder), and the
 * image part(s) re-emerge in a follow-up `role: 'user'` multimodal message
 * carrying a caption — the strict-OpenAI placement of tool-returned media
 * (the QwenLM `qwen-code` `splitToolMedia` fix; their backends accept
 * `image_url` parts in `user` messages only). A text-only model still refuses
 * with `UNSUPPORTED_CONTENT` (defense in depth — the runtime projects such
 * images to text placeholders before the adapter sees them).
 *
 * @module dsh-llm-qwen-local/serialize
 */

import {
  contentHasImage,
  offloadRequestImagesWithPolicy,
  offloadedImageText,
} from './harness/content.js'
import { LlmError } from './harness/llm-error.js'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type {
  AttachmentStore,
  ImageAttachmentRef,
  ImageMediaType,
  ImageRequestPolicy,
} from '@deepseek-ai/dsh-attachment'
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_PIXELS,
} from './config.js'
import type { QwenLocalModel, QwenLocalReasoning } from './config.js'
import type { WireImagePart, WireMessage, WireRequest, WireTextPart, WireTool } from './wire.js'

/** Minimal text-only model record for unlisted ids (advisory catalog). */
export function unlistedModel(id: string): QwenLocalModel {
  return { id, multimodal: false }
}

/** One serializable request image: bytes plus the media type to declare. */
export interface RequestImageBytes {
  data: Uint8Array
  mediaType: ImageMediaType
}

/**
 * The attachment store's request-image capability is marked by the
 * `ATTACHMENT_PROJECTION_UNSUPPORTED` code (the base-class default rejection).
 */
const PROJECTION_UNSUPPORTED = 'ATTACHMENT_PROJECTION_UNSUPPORTED'

/**
 * Resolve one durable image to request bytes: the attachment provider's
 * deterministic request-image projection when it implements one (cached
 * variants, aspect-preserving downscale to the model's pixel budget, encoded
 * byte cap), otherwise the normalized master bytes. A provider that cannot
 * project refuses with `ATTACHMENT_PROJECTION_UNSUPPORTED`; that specific
 * rejection falls back, every other failure propagates.
 * @param attachments - durable byte resolver (required whenever an image is present).
 * @param ref - the durable image reference from the session log.
 * @param policy - pixel and encoded-byte budgets for the request version.
 * @param signal - cancellation for the backend work.
 * @returns request bytes and their media type.
 */
export async function resolveRequestImageBytes(
  attachments: AttachmentStore,
  ref: ImageAttachmentRef,
  policy: ImageRequestPolicy,
  signal?: AbortSignal,
): Promise<RequestImageBytes> {
  if (typeof attachments.readImageRequest === 'function') {
    try {
      const projected = await attachments.readImageRequest(ref, policy, signal)
      return { data: projected.data, mediaType: projected.mediaType }
    } catch (error: unknown) {
      // Duck-type the rejection by its `code` OWN property, not by class
      // identity: the attachment store is mounted by the harness and throws
      // the package's AttachmentError, whose own `code` property is the
      // stable contract. A local class copy could never match it by
      // `instanceof`, so the code check is the only portable test.
      if (error === null
        || typeof error !== 'object'
        || (error as { code?: unknown }).code !== PROJECTION_UNSUPPORTED) {
        throw error
      }
    }
  }
  const stored = await attachments.readImage(ref, signal)
  return { data: stored.data, mediaType: stored.ref.mediaType }
}

/**
 * The request-image policy one resolved model contributes: pixel and encoded
 * byte budgets with the harness canonical defaults, overridable per model.
 */
export function imagePolicy(model: QwenLocalModel): ImageRequestPolicy {
  return {
    maxPixels: model.imageMaxPixels ?? DEFAULT_IMAGE_MAX_PIXELS,
    maxBytes: model.imageMaxBytes ?? DEFAULT_IMAGE_MAX_BYTES,
  }
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

/**
 * Caption of the follow-up user message that carries images split out of
 * tool results. The strict OpenAI placement the vLLM/Qwen wire enforces:
 * tool-returned media cannot ride a `role: 'tool'` message (text-only
 * content), so they re-emerge as `image_url` parts of a `role: 'user'`
 * message directly after the tool message.
 */
const TOOL_IMAGE_CAPTION = 'Images returned by the tool call above are attached.'

/**
 * Split image parts out of tool results for a multimodal model: the
 * tool message serializes text-only and the images re-emerge as parts of
 * one follow-up `role: 'user'` multimodal message (caption first, then the
 * image parts in tool-result order). Mirrors the QwenLM `qwen-code`
 * `splitToolMedia` fix for strict OpenAI-compatible backends.
 * @param result - one tool result from the harness history.
 * @param model - the resolved model configuration.
 * @param attachments - durable byte resolver, required when an image is present.
 * @param signal - cancellation for attachment reads.
 * @returns the text-only tool message plus the follow-up image message when any image was split.
 * @throws LlmError `UNSUPPORTED_CONTENT` when an image is present without the attachment service.
 */
async function splitToolResultImages(
  result: Extract<ContentBlock, { type: 'tool-result' }>,
  model: QwenLocalModel,
  attachments: AttachmentStore | undefined,
  signal: AbortSignal | undefined,
): Promise<WireMessage[]> {
  const hasImage = result.content.some(block => block.type === 'image')
  if (!hasImage) {
    return [{
      role: 'tool',
      tool_call_id: result.toolCallId,
      // Empty tool output still needs SOME content on the wire.
      content: flattenText(result.content) || '(no output)',
    }]
  }
  if (attachments === undefined) {
    throw new LlmError(
      `image input for model "${model.id}" requires the durable attachment service`,
      'UNSUPPORTED_CONTENT',
    )
  }
  const images = result.content.filter((block): block is ContentBlock & { type: 'image' } => block.type === 'image')
  const parts = await serializeParts(
    [{ type: 'text', text: TOOL_IMAGE_CAPTION }, ...images],
    model,
    attachments,
    signal,
  )
  return [
    {
      role: 'tool',
      tool_call_id: result.toolCallId,
      // The tool's text survives the split; an image-only result gets the
      // placeholder (a tool message always carries SOME content on the wire).
      content: flattenText(result.content) || '(no output)',
    },
    { role: 'user', content: parts },
  ]
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
      const requestImage = await resolveRequestImageBytes(
        attachments,
        block.attachment,
        imagePolicy(model),
        signal,
      )
      const base64 = Buffer.from(requestImage.data).toString('base64')
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${requestImage.mediaType};base64,${base64}` },
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
  messages: readonly Message[],
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
      if (model.multimodal) {
        // Strict-OpenAI placement: the image parts split into a follow-up
        // user message, the tool message stays text-only. A text-only tool
        // result needs no attachment service at all.
        wire.push(...await splitToolResultImages(result, model, attachments, signal))
      } else {
        // Defense in depth for direct (non-runtime) use: the runtime
        // projects images to text placeholders before a text-only adapter
        // sees them, so this gate catches out-of-runtime histories only.
        assertNoImage(result.content, model, 'inside tool results')
        wire.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          // Empty tool output still needs SOME content on the wire.
          content: flattenText(result.content) || '(no output)',
        })
      }
    }
  }
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * deployment defaults apply. When `maxRequestImageBytes` bounds the route's
 * total inlined payload, the OLDEST images are replaced with a deterministic
 * text placeholder first (the harness `offloadRequestImages` policy), so a
 * history-heavy vision request still fits the endpoint's input cap.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param model - the resolved model configuration.
 * @param attachments - durable byte resolver; `undefined` refuses any image.
 * @param maxRequestImageBytes - route-level total inlined base64 payload bound; absent = keep every image.
 * @returns the chat-completions request body.
 */
export async function serializeRequest(
  options: GenerateOptions,
  model: QwenLocalModel,
  attachments: AttachmentStore | undefined,
  maxRequestImageBytes?: number,
): Promise<WireRequest> {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  const history = maxRequestImageBytes === undefined
    || !options.messages.some(message => contentHasImage(message.content))
    ? options.messages
    : offloadRequestImagesWithPolicy(options.messages, {
      representation: 'base64',
      maxBytes: maxRequestImageBytes,
      byteQuantum: 1,
      placeholder: (ref) => offloadedImageText(ref),
    })
  messages.push(...await serializeMessages(history, model, attachments, options.signal))

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
