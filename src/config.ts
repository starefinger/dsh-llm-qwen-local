/**
 * Plugin config for the local Qwen adapter: one schemastery schema (validated
 * at plugin load) plus one explicit resolve step that re-judges every bound,
 * so programmatic construction cannot bypass the schema silently.
 *
 * Design points:
 * - `multimodal` is a per-model CLAIM about the endpoint (declaration, not a
 *   check): nothing interrogates the server. Under-claiming costs a pre-send
 *   refusal naming the model; over-claiming costs a provider refusal mid-turn.
 * - Reasoning efforts are adapter-owned opaque ids with a configurable wire
 *   spelling per level, so any vLLM/Qwen `reasoning_effort` vocabulary is
 *   expressible. `off` is the one level whose wire may be `null` (send
 *   nothing); how `off` is expressed beyond that is `offMode`.
 *
 * @module dsh-llm-qwen-local/config
 */

import z from '@deepseek-ai/schemastery'

/** Default endpoint for a local vLLM instance. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1'
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 262_144
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 32_768
/** Default maximum idle interval while a stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * One selectable reasoning effort. `id` is the opaque value the harness
 * carries in `GenerateOptions.reasoningEffort`; `wire` is the spelling sent as
 * `reasoning_effort` (or `null` for `off`: send nothing).
 */
export interface QwenLocalReasoningEffort {
  /** Opaque stable effort id (unique within the model). */
  id: string
  /** Display name for selectors; defaults to {@link id}. */
  name?: string
  /** Wire spelling for `reasoning_effort`; `null` is legal for `off` only. */
  wire: string | null
}

/** Configured reasoning capability of one model. */
export interface QwenLocalReasoning {
  /**
   * Selectable levels in display order. `off` is OPTIONAL (0 or 1 entry; the
   * unique-id rule caps it at one): it is the adapter's own "no thinking"
   * selector level, not a wire value — selecting it sends no
   * `reasoning_effort` at all. Omit it for deployments with no way to disable
   * thinking.
   */
  efforts: QwenLocalReasoningEffort[]
  /** Default level materialized when callers omit an effort; absent = provider default. */
  defaultEffort?: string
  /**
   * Wire expression of `off` beyond omitting `reasoning_effort`:
   * `chat-template-kwargs` (default) sends
   * `chat_template_kwargs: { enable_thinking: false }` for the vLLM Qwen
   * chat template; `omit` sends nothing extra.
   */
  offMode: 'chat-template-kwargs' | 'omit'
}

/** One configured model of the local deployment. */
export interface QwenLocalModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted = route default. */
  contextWindow?: number
  /** Per-request output cap for this model; omitted = route default. */
  maxTokens?: number
  /**
   * Multimodal switch. Qwen3.8-27B is a native vision-language model, so a
   * deployment serving it should set this to `true`; `false` (schema default)
   * declares a text-only model: the harness refuses images before send, and
   * the adapter refuses again at serialization time. `true` declares `image`
   * input and resolves image bytes through the durable attachment service.
   */
  multimodal?: boolean
  /**
   * Whether the deployment preserves thinking blocks from historical messages
   * (Qwen3.8's `preserve_thinking`, template default ON). `false` sends
   * `chat_template_kwargs: { preserve_thinking: false }` and the adapter stops
   * replaying assistant reasoning into history.
   */
  preserveThinking?: boolean
  /** Reasoning capability; absent = the model exposes no selectable efforts. */
  reasoning?: QwenLocalReasoning
}

/**
 * Plugin config, validated by the same-named schemastery schema. Every field
 * is optional in yml except `models`: a missing base URL defaults to the
 * loopback vLLM endpoint, a missing API key env name sends no Authorization
 * header (local deployments usually take no credential), and missing
 * capacities fall back to the route defaults below.
 */
export interface Config {
  /** Endpoint base; `/chat/completions` is appended. Defaults to {@link DEFAULT_BASE_URL}. */
  baseURL?: string
  /**
   * Environment-variable name holding an optional bearer token, read per
   * request. Absent or unset = no Authorization header.
   */
  apiKeyEnv?: string
  /** Models served by this deployment; at least one. */
  models: QwenLocalModel[]
  /** Positive context capacity used when a model has no exact value. */
  defaultContextWindow?: number
  /** Default per-request output cap; explicit request values and model caps win. */
  maxTokens?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
}

const reasoningEffortSchema: z<QwenLocalReasoningEffort> = z.object({
  id: z.string().required(),
  name: z.string(),
  wire: z.union([z.string(), z.const(null)]).required(),
})

const reasoningSchema: z<QwenLocalReasoning> = z.object({
  efforts: z.array(reasoningEffortSchema).min(1).required(),
  defaultEffort: z.string(),
  offMode: z.union(['chat-template-kwargs', 'omit']).default('chat-template-kwargs'),
})

const modelSchema: z<QwenLocalModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  multimodal: z.boolean().default(false),
  preserveThinking: z.boolean().default(true),
  reasoning: reasoningSchema,
})

export const Config: z<Config> = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  apiKeyEnv: z.string(),
  models: z.array(modelSchema).min(1).required(),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
})

/**
 * Validated, detached request facts for the adapter. The adapter trusts this
 * value; re-resolution happens per request so a configuration change reaches
 * the next request without re-registration.
 */
export interface QwenLocalOptions {
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /** Optional environment-variable name holding a bearer token. */
  apiKeyEnv?: string
  /** Validated models with display names materialized. */
  models: QwenLocalModel[]
  /** Context capacity fallback. */
  defaultContextWindow: number
  /** Per-request output-cap fallback. */
  maxTokens: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
}

const PKG = 'dsh-llm-qwen-local'

/** Validate one effort list and materialize display names. */
function resolveReasoning(raw: QwenLocalReasoning, modelId: string): QwenLocalReasoning {
  const seen = new Set<string>()
  const efforts = raw.efforts.map(effort => {
    if (effort.id.length === 0) throw new Error(`${PKG}: model "${modelId}" declares an effort with an empty id`)
    if (seen.has(effort.id)) throw new Error(`${PKG}: model "${modelId}" declares duplicate reasoning effort "${effort.id}"`)
    seen.add(effort.id)
    if (effort.wire === null && effort.id !== 'off') {
      throw new Error(
        `${PKG}: model "${modelId}" effort "${effort.id}" may not use a null wire; only "off" sends nothing`,
      )
    }
    if (effort.wire !== null && effort.wire.length === 0) {
      throw new Error(
        `${PKG}: model "${modelId}" effort "${effort.id}" declares an empty wire spelling; use null only for "off"`,
      )
    }
    return {
      id: effort.id,
      ...effort.name === undefined || effort.name.length === 0 ? {} : { name: effort.name },
      wire: effort.wire,
    }
  })
  // `off` is optional: 0 or 1 (the duplicate-id check above already caps it
  // at one). A model without `off` simply cannot disable thinking via effort
  // selection.
  if (raw.defaultEffort !== undefined && !seen.has(raw.defaultEffort)) {
    throw new Error(
      `${PKG}: model "${modelId}" defaultEffort "${raw.defaultEffort}" is not among its declared efforts`,
    )
  }
  return {
    efforts,
    ...raw.defaultEffort === undefined ? {} : { defaultEffort: raw.defaultEffort },
    offMode: raw.offMode,
  }
}

/** Validate one model entry. */
function resolveModel(raw: QwenLocalModel, index: number): QwenLocalModel {
  if (raw.id.length === 0) throw new Error(`${PKG}: models[${index}] has an empty id`)
  if (raw.name !== undefined && raw.name.length === 0) {
    throw new Error(`${PKG}: model "${raw.id}" has an empty name`)
  }
  if (raw.contextWindow !== undefined
    && (!Number.isInteger(raw.contextWindow) || raw.contextWindow <= 0)) {
    throw new Error(`${PKG}: model "${raw.id}" contextWindow must be a positive integer`)
  }
  if (raw.maxTokens !== undefined
    && (!Number.isInteger(raw.maxTokens) || raw.maxTokens <= 0)) {
    throw new Error(`${PKG}: model "${raw.id}" maxTokens must be a positive integer`)
  }
  return {
    id: raw.id,
    ...raw.name === undefined ? {} : { name: raw.name },
    ...raw.description === undefined ? {} : { description: raw.description },
    ...raw.contextWindow === undefined ? {} : { contextWindow: raw.contextWindow },
    ...raw.maxTokens === undefined ? {} : { maxTokens: raw.maxTokens },
    multimodal: raw.multimodal === true,
    preserveThinking: raw.preserveThinking !== false,
    ...raw.reasoning === undefined ? {} : { reasoning: resolveReasoning(raw.reasoning, raw.id) },
  }
}

/**
 * The one explicit resolve step from raw config to validated request facts.
 * Programmatic construction may bypass Schemastery normalization, so every
 * default and bound is re-judged here.
 * @param config - raw plugin config.
 * @returns validated request facts.
 */
export function resolveConfig(config: Config): QwenLocalOptions {
  if (config.models === undefined || config.models.length === 0) {
    throw new Error(`${PKG}: at least one model must be configured`)
  }
  const seen = new Set<string>()
  const models = config.models.map((model, index) => {
    if (seen.has(model.id)) throw new Error(`${PKG}: duplicate model "${model.id}"`)
    seen.add(model.id)
    return resolveModel(model, index)
  })
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error(`${PKG}: defaultContextWindow must be a positive integer`)
  }
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`${PKG}: maxTokens must be a positive safe integer`)
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error(`${PKG}: streamIdleTimeoutMs must be a positive finite number`)
  }
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  if (baseURL.length === 0) throw new Error(`${PKG}: baseURL must be a non-empty string`)
  return {
    baseURL,
    ...config.apiKeyEnv === undefined || config.apiKeyEnv.length === 0
      ? {}
      : { apiKeyEnv: config.apiKeyEnv },
    models,
    defaultContextWindow,
    maxTokens,
    streamIdleTimeoutMs,
  }
}
