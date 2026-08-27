/**
 * vLLM chat-completions wire format (OpenAI-compatible) for locally deployed
 * Qwen models. Types only — request serialization lives in `serialize.ts`,
 * streaming translation in `translate.ts`.
 *
 * Wire dialect notes (vLLM + Qwen3 chat template):
 * - Thinking content streams as `delta.reasoning_content` (Qwen dialect).
 * - `reasoning_effort` is accepted by vLLM for Qwen3; the accepted value set
 *   is deployment-dependent, so this adapter sends whatever wire spelling the
 *   plugin config declares for a level.
 * - Disabling thinking additionally requires `chat_template_kwargs:
 *   { enable_thinking: false }` on the Qwen chat template; omitting
 *   `reasoning_effort` alone keeps the template's thinking default.
 * - Vision models accept `image_url` parts with data-URL values inside a
 *   user message's `content` array ONLY — strict OpenAI placement.
 *   `role: 'tool'` content is text-only, so tool-returned media re-emerge in
 *   a follow-up `role: 'user'` multimodal message (the QwenLM `qwen-code`
 *   `splitToolMedia` shape; `serialize.ts` performs the split).
 * - `stream_options: { include_usage: true }` puts the usage block on a
 *   trailing chunk before `[DONE]`.
 *
 * @module dsh-llm-qwen-local/wire
 */

/** Request body for `POST {baseURL}/chat/completions`. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  /** Selectable-reasoning wire spelling; absent = the deployment's own default. */
  reasoning_effort?: string
  /**
   * Qwen3.8 chat-template switches, each sent only when it deviates from the
   * template default: `enable_thinking` defaults on (the `off` level turns it
   * off), `preserve_thinking` defaults on (retains historical thinking
   * blocks across the conversation).
   */
  chat_template_kwargs?: {
    enable_thinking?: false
    preserve_thinking?: false
  }
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  /** Stop sequences (OpenAI `stop`). Mapped from `GenerateOptions.stop`. */
  stop?: string[]
}

/** A text part of a multimodal user message. */
export interface WireTextPart {
  type: 'text'
  text: string
}

/** A raster image part of a multimodal user message; the data URL is inlined. */
export interface WireImagePart {
  type: 'image_url'
  image_url: { url: string }
}

/** System-role message: a single string of instructions. */
export interface WireSystemMessage {
  role: 'system'
  content: string
}

/** Text-only user message (text-only models and plain turns). */
export interface WireTextUserMessage {
  role: 'user'
  content: string
}

/** Multimodal user message: ordered text and image parts. */
export interface WireMultimodalUserMessage {
  role: 'user'
  content: (WireTextPart | WireImagePart)[]
}

/** Tool-role message: the result of one tool call, keyed by its call id. */
export interface WireToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

/**
 * Assistant-role history message. Text-less turns send `""` (never null):
 * pure tool-call turns replay `content: ""` plus `tool_calls`. With
 * `preserve_thinking` at its template default (ON), tool-call-free turns
 * replay their thinking as `reasoning_content`.
 */
export interface WireAssistantMessage {
  role: 'assistant'
  content: string
  tool_calls?: WireToolCall[]
  reasoning_content?: string
}

/** One entry of the request `messages` array, discriminated on `role`. */
export type WireMessage =
  | WireSystemMessage
  | WireTextUserMessage
  | WireMultimodalUserMessage
  | WireAssistantMessage
  | WireToolMessage

/** A completed tool call replayed on an assistant history message; `arguments` is the raw JSON string. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One entry of the request `tools` array; `parameters` is a JSON Schema object. */
export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** One parsed SSE `data:` payload (a chat.completion.chunk). */
export interface WireChunk {
  choices?: WireChoice[]
  /** Arrives attached to the finish chunk and/or as a trailing usage-only chunk. */
  usage?: WireUsage | null
  /** In-band provider failure (vLLM error events / mid-stream error payloads). */
  error?: WireErrorBody | null
}

/** One streamed choice (requests always ask for a single one); `finish_reason` is non-null only on its terminal chunk. */
export interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}

/** The incremental content of one streamed choice; any subset of fields may be present per chunk. */
export interface WireDelta {
  role?: string
  /** Visible text. Null/empty on reasoning/tool-call chunks. */
  content?: string | null
  /** Qwen thinking channel. May arrive as an empty string on the first chunk. */
  reasoning_content?: string | null
  /**
   * Alternate thinking-channel spelling some frameworks emit (the official
   * Qwen3.8 example reads both); vLLM with `--reasoning-parser qwen3` emits
   * `reasoning_content`.
   */
  reasoning?: string | null
  tool_calls?: WireToolCallDelta[]
}

/** A streamed fragment of one tool call; fragments sharing an `index` concatenate into one call. */
export interface WireToolCallDelta {
  /** Disambiguates parallel tool calls; stable across a call's deltas. */
  index: number
  /** Present on the first delta of each call only. */
  id?: string
  type?: 'function'
  function?: {
    /** Present on the first delta of each call only. */
    name?: string
    /** Argument JSON fragment (concatenate across deltas). */
    arguments?: string
  }
}

/**
 * Wire token accounting. `prompt_tokens` may INCLUDE cache hits depending on
 * the deployment; `mapUsage` subtracts `prompt_tokens_details.cached_tokens`
 * to keep the harness convention of disjoint counts.
 */
export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** Non-2xx (and in-band) error body, OpenAI-shaped. */
export interface WireError {
  error?: WireErrorBody | null
}

export interface WireErrorBody {
  message?: string
  type?: string
  code?: string | number
}
