/**
 * Plugin config for the local Qwen adapter: one frozen configuration surface
 * (validated at plugin load) plus one explicit resolve step that re-judges
 * every bound, so programmatic construction cannot bypass the schema
 * silently.
 *
 * Design points:
 * - `multimodal` is a per-model CLAIM about the endpoint (declaration, not a
 *   check): nothing interrogates the server. Under-claiming costs a pre-send
 *   refusal naming the model; over-claiming costs a provider refusal mid-turn.
 * - Reasoning efforts are adapter-owned opaque ids with a configurable wire
 *   spelling per level, so any vLLM/Qwen `reasoning_effort` vocabulary is
 *   expressible. `off` is the canonical "no thinking" level: its default
 *   wire spelling is `none` (vLLM's accepted no-thinking value, sent
 *   alongside the offMode kwarg), and a `null` wire (send no
 *   `reasoning_effort` at all; kwargs only) is still legal for it. How
 *   `off` is expressed on the wire is `offMode`.
 *
 * @module dsh-llm-qwen-local/config
 */

// Type-only: the `z<T>` annotation below declares Config's public type as the
// schemastery schema shape so the settings service's `installSection` accepts
// it unchanged. `import type` is erased at build time (isolatedModules), so
// the published plugin never loads @deepseek-ai/schemastery — the runtime
// stand-in is the hand-owned callable + frozen envelope below.
import type z from '@deepseek-ai/schemastery'

/** Default endpoint for a local vLLM instance. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1'
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 262_144
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 32_768
/** Default maximum idle interval while a stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/**
 * Default request-image pixel budget (width × height, aspect-preserving).
 * Matches the harness's canonical request-image default (also llm-deepseek's),
 * so a local deployment gets the same deterministic projection as the
 * official adapters; raise per model for detail-critical vision work.
 */
export const DEFAULT_IMAGE_MAX_PIXELS = 640_000
/**
 * Default per-request-image encoded-byte cap before base64 inlining. Matches
 * the harness canonical default; images above it are re-encoded down by the
 * attachment provider's request-image projection.
 */
export const DEFAULT_IMAGE_MAX_BYTES = 1024 * 1024

/**
 * One selectable reasoning effort. `id` is the opaque value the harness
 * carries in `GenerateOptions.reasoningEffort`; `wire` is the spelling sent
 * as `reasoning_effort`. `off`'s wire is `none` by convention (vLLM's
 * canonical no-thinking spelling) and `null` for a deployment whose vLLM
 * predates the parameter (send nothing; the offMode kwarg carries the
 * expression).
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
   * unique-id rule caps it at one): the adapter's own "no thinking" selector
   * level — wire `none` by convention (vLLM's canonical no-thinking value),
   * `null` on a build that predates the `reasoning_effort` parameter (then
   * only the offMode kwargs express off). Omit it for deployments with no
   * way to disable thinking.
   */
  efforts: QwenLocalReasoningEffort[]
  /** Default level materialized when callers omit an effort; absent = provider default. */
  defaultEffort?: string
  /**
   * Template-side expression of `off`, sent alongside the off level's wire
   * value (`none` by convention; `null` on a pre-parameter build):
   * `chat-template-kwargs` (default) sends
   * `chat_template_kwargs: { enable_thinking: false }` for the vLLM Qwen
   * chat template; `omit` sends nothing extra.
   */
  offMode?: 'chat-template-kwargs' | 'omit'
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
  /**
   * Request-image pixel budget (width × height) after aspect-preserving
   * projection; omitted = {@link DEFAULT_IMAGE_MAX_PIXELS}. Resolved through
   * the durable attachment service's request-image pipeline when the mounted
   * provider supports it, raw normalized bytes otherwise.
   */
  imageMaxPixels?: number
  /**
   * Per-request-image encoded-byte cap before base64 inlining; omitted =
   * {@link DEFAULT_IMAGE_MAX_BYTES}.
   */
  imageMaxBytes?: number
  /** Reasoning capability; absent = the model exposes no selectable efforts. */
  reasoning?: QwenLocalReasoning
}

/**
 * Plugin config, validated by the same-named schemastery schema. Every field
 * is optional in yml: a missing base URL defaults to the loopback vLLM
 * endpoint, a missing API key env name sends no Authorization header (local
 * deployments usually take no credential), a missing (or empty) model list
 * leaves the route dormant, and missing capacities fall back to the route
 * defaults below.
 */
export interface Config {
  /** Endpoint base; `/chat/completions` is appended. Defaults to {@link DEFAULT_BASE_URL}. */
  baseURL?: string
  /**
   * Environment-variable name holding an optional bearer token, read per
   * request. Absent or unset = no Authorization header.
   */
  apiKeyEnv?: string
  /**
   * Models served by this deployment; may be empty (absent = empty). An empty
   * list leaves the route mounted but dormant — no selectable models — and the
   * settings page can re-populate it via "discover models from endpoint" or a
   * manual add.
   */
  models?: QwenLocalModel[]
  /** Positive context capacity used when a model has no exact value. */
  defaultContextWindow?: number
  /** Default per-request output cap; explicit request values and model caps win. */
  maxTokens?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
}

// ── Frozen schemastery envelope for the llm-qwen-local namespace ─────────
// The EXACT uid/refs serialization the schemastery Config schema produced
// (captured once from Config.toJSON()), frozen as a plain object so the
// published plugin carries no runtime dependency on
// @deepseek-ai/schemastery. The settings service exposes it to the web form
// renderer via schema.toJSON(); the Cordis loader validates the composition
// entry via the ~standard surface below. Keep in sync if the Config shape
// changes (regenerate with scripts/extract-envelope.mjs).
const ENVELOPE = {
  uid: 56,
  refs: {
    "1": {
      type: "string",
      meta: {
        required: true
      }
    },
    "2": {
      type: "string",
      meta: {}
    },
    "3": {
      type: "string",
      meta: {}
    },
    "4": {
      type: "const",
      meta: {},
      value: null
    },
    "6": {
      type: "union",
      meta: {
        required: true
      },
      list: [
        3,
        4
      ]
    },
    "7": {
      type: "object",
      meta: {
        default: {}
      },
      dict: {
        id: 1,
        name: 2,
        wire: 6
      }
    },
    "10": {
      type: "array",
      meta: {
        default: [],
        min: 1,
        required: true
      },
      inner: 7
    },
    "11": {
      type: "string",
      meta: {}
    },
    "14": {
      type: "const",
      meta: {
        required: true
      },
      value: "chat-template-kwargs"
    },
    "16": {
      type: "const",
      meta: {
        required: true
      },
      value: "omit"
    },
    "17": {
      type: "union",
      meta: {
        default: "chat-template-kwargs"
      },
      list: [
        14,
        16
      ]
    },
    "18": {
      type: "object",
      meta: {
        default: {}
      },
      dict: {
        efforts: 10,
        defaultEffort: 11,
        offMode: 17
      }
    },
    "20": {
      type: "string",
      meta: {
        required: true
      }
    },
    "21": {
      type: "string",
      meta: {}
    },
    "22": {
      type: "string",
      meta: {}
    },
    "25": {
      type: "number",
      meta: {
        step: 1,
        min: 1
      }
    },
    "28": {
      type: "number",
      meta: {
        step: 1,
        min: 1
      }
    },
    "30": {
      type: "boolean",
      meta: {
        default: false
      }
    },
    "32": {
      type: "boolean",
      meta: {
        default: true
      }
    },
    "35": {
      type: "number",
      meta: {
        step: 1,
        min: 1
      }
    },
    "38": {
      type: "number",
      meta: {
        step: 1,
        min: 1
      }
    },
    "39": {
      type: "object",
      meta: {
        default: {}
      },
      dict: {
        id: 20,
        name: 21,
        description: 22,
        contextWindow: 25,
        maxTokens: 28,
        multimodal: 30,
        preserveThinking: 32,
        imageMaxPixels: 35,
        imageMaxBytes: 38,
        reasoning: 18
      }
    },
    "41": {
      type: "string",
      meta: {
        default: "http://127.0.0.1:8000/v1"
      }
    },
    "42": {
      type: "string",
      meta: {}
    },
    "44": {
      type: "array",
      meta: {
        default: []
      },
      inner: 39
    },
    "48": {
      type: "number",
      meta: {
        step: 1,
        min: 1,
        default: 262144
      }
    },
    "52": {
      type: "number",
      meta: {
        step: 1,
        min: 1,
        default: 32768
      }
    },
    "55": {
      type: "number",
      meta: {
        min: 1,
        default: 300000
      }
    },
    "56": {
      type: "object",
      meta: {
        default: {}
      },
      dict: {
        baseURL: 41,
        apiKeyEnv: 42,
        models: 44,
        defaultContextWindow: 48,
        maxTokens: 52,
        streamIdleTimeoutMs: 55
      }
    }
  }
}

/**
 * Standard-schema v1 surface the Cordis loader applies to the composition
 * config entry at plugin load (Cordis resolveConfig calls
 * Config["~standard"].validate). It funnels through resolveConfig — the
 * same explicit resolve step the settings service uses — so the load-time
 * and runtime judgments can never diverge.
 */
const CONFIG_STANDARD = {
  version: 1 as const,
  vendor: 'dsh-llm-qwen-local' as const,
  validate(input: unknown):
    | { value: QwenLocalOptions; issues?: undefined }
    | { value?: undefined; issues: readonly { message: string }[] } {
    try {
      return { value: resolveConfig((input ?? {}) as Config) }
    } catch (error) {
      return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
    }
  },
}

/**
 * The configuration surface the plugin exposes to its two consumers: the
 * settings service (invokes it as `schema(mergedValue)` and reads
 * `schema.toJSON()`) and the Cordis loader (reads
 * `Config["~standard"].validate`). The callable IS the explicit resolve step,
 * and `toJSON()` answers the frozen envelope for the web form renderer.
 *
 * Owning the callable and the envelope as hand-written facts (instead of a
 * live schemastery instance) is what lets the published plugin drop the
 * schemastery dependency entirely. The public type is still the schemastery
 * schema shape (`z<Config>`) so the settings service's `installSection`
 * accepts it unchanged and the exported surface is byte-compatible with the
 * original; the runtime stand-in is cast to that type because the only
 * members the harness actually touches — the call signature, `toJSON()`, and
 * `["~standard"]` — are all implemented here, and no harness code path
 * reaches the remaining schemastery-only members.
 */
export const Config: z<Config> = Object.assign(
  (config: Config): QwenLocalOptions => resolveConfig(config),
  {
    toJSON: () => ENVELOPE,
    '~standard': CONFIG_STANDARD,
  },
) as unknown as z<Config>
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
  // `offMode` keeps its schemastery default here: the schema's
  // `z.union([...]).default('chat-template-kwargs')` used to fill it before
  // this step ran, so re-applying it is what keeps the resolved output
  // identical now that resolveConfig IS the load-time validator. An out-of-
  // vocabulary value is refused like the schema's union did.
  const offMode = raw.offMode ?? 'chat-template-kwargs'
  if (offMode !== 'chat-template-kwargs' && offMode !== 'omit') {
    throw new Error(
      `${PKG}: model "${modelId}" offMode must be "chat-template-kwargs" or "omit"`,
    )
  }
  return {
    efforts,
    ...raw.defaultEffort === undefined ? {} : { defaultEffort: raw.defaultEffort },
    offMode,
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
  if (raw.imageMaxPixels !== undefined
    && (!Number.isInteger(raw.imageMaxPixels) || raw.imageMaxPixels <= 0)) {
    throw new Error(`${PKG}: model "${raw.id}" imageMaxPixels must be a positive integer`)
  }
  if (raw.imageMaxBytes !== undefined
    && (!Number.isInteger(raw.imageMaxBytes) || raw.imageMaxBytes <= 0)) {
    throw new Error(`${PKG}: model "${raw.id}" imageMaxBytes must be a positive integer`)
  }
  return {
    id: raw.id,
    ...raw.name === undefined ? {} : { name: raw.name },
    ...raw.description === undefined ? {} : { description: raw.description },
    ...raw.contextWindow === undefined ? {} : { contextWindow: raw.contextWindow },
    ...raw.maxTokens === undefined ? {} : { maxTokens: raw.maxTokens },
    multimodal: raw.multimodal === true,
    preserveThinking: raw.preserveThinking !== false,
    ...raw.imageMaxPixels === undefined ? {} : { imageMaxPixels: raw.imageMaxPixels },
    ...raw.imageMaxBytes === undefined ? {} : { imageMaxBytes: raw.imageMaxBytes },
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
  // An empty (or absent) model list is legal: the route stays mounted with no
  // selectable models (dormant), and the settings page can re-populate it.
  const seen = new Set<string>()
  const models = (config.models ?? []).map((model, index) => {
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
