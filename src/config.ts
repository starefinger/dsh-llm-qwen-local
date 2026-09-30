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
// schemastery schema shape. On DSH >= 0.2.0 the settings service walks the
// exported `Config` as a live schemastery node (reading `.meta.volatile`,
// `.type`, `.dict`, …) and rehydrates each volatile field through
// `toJSON()`, so the runtime stand-in below spreads the dereferenced node
// tree of the frozen envelope onto the callable. `import type` is erased at
// build time (isolatedModules), so the published plugin never loads
// @deepseek-ai/schemastery.
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
//
// DSH >= 0.2.0: each top-level field's `meta` also carries `volatile: true`.
// The 0.2.0 settings service exposes only volatile fields of a plugin's
// `Config` schema in its projected settings form, and the 0.2.0 loader hands
// the volatile fields of the composition entry to `apply()` as live
// references that the runtime updates in place when a settings write commits
// (the 0.1.2 `settings.installSection` seam was removed — see src/index.ts).
// Marking all six route fields volatile keeps every field editable from the
// web settings page and every fact live per request.
// Regenerated from scripts/envelope-source.ts (schemastery 3.18.4) via
// scripts/dump-envelope.mjs — every builder call (including each `.volatile()`)
// allocates one schema node, so the six route fields sit at uids 42/44/47/52/
// 57/61 under root uid 62. Regenerate with `node scripts/dump-envelope.mjs`
// and re-run `node scripts/extract-envelope.mjs --check` after any shape or
// mark change.
const ENVELOPE = {
  uid: 62,
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
    "42": {
      type: "string",
      meta: {
        default: "http://127.0.0.1:8000/v1",
        volatile: true
      }
    },
    "44": {
      type: "string",
      meta: {
        volatile: true
      }
    },
    "47": {
      type: "array",
      meta: {
        default: [],
        volatile: true
      },
      inner: 39
    },
    "52": {
      type: "number",
      meta: {
        step: 1,
        min: 1,
        default: 262144,
        volatile: true
      }
    },
    "57": {
      type: "number",
      meta: {
        step: 1,
        min: 1,
        default: 32768,
        volatile: true
      }
    },
    "61": {
      type: "number",
      meta: {
        min: 1,
        default: 300000,
        volatile: true
      }
    },
    "62": {
      type: "object",
      meta: {
        default: {}
      },
      dict: {
        baseURL: 42,
        apiKeyEnv: 44,
        models: 47,
        defaultContextWindow: 52,
        maxTokens: 57,
        streamIdleTimeoutMs: 61
      }
    }
  }
}

// ── Dereferenced live-node view of the frozen envelope (DSH >= 0.2.0) ─────
// The 0.2.0 settings service (dsh-settings' SettingsForms.describe / write)
// treats a runtime `Config` as a LIVE schemastery schema node: it reads
// `schema.meta.volatile`, `schema.type`, `schema.dict` and rehydrates each
// volatile subtree with `new z(schema.toJSON())` using the HOST's own
// schemastery. The 0.1.2 contract — a callable the service invoked and
// registered through `installSection` — is gone, and a bare callable has no
// `.meta`, so `describe()` threw `TypeError: Cannot read properties of
// undefined (reading 'volatile')`, failed every `settings/describe` RPC, and
// aborted the desktop cold-start welcome.
//
// Each dereferenced node below carries the original ref's `type`/`meta`
// (including the volatile marks) and its children — `dict`, `inner`,
// `list` — already dereferenced, mirroring how schemastery materializes a
// schema from its envelope, and a `toJSON()` answering the sub-envelope
// reachable from that node, so the settings service can rebuild any volatile
// field with its own schemastery. The Cordis loader is unaffected: it only
// reads the `~standard` surface, which funnels through `resolveConfig`.
type EnvelopeRef = {
  type: string
  meta: Record<string, unknown>
  value?: unknown
  dict?: Record<string, number>
  inner?: number
  list?: number[]
}
type NodeChild = { type: string; meta: Record<string, unknown> } & Partial<Record<'value' | 'dict' | 'inner' | 'list', unknown>>
type NodeTree = NodeChild & { toJSON: () => { uid: number; refs: Record<string, EnvelopeRef> } }

/** The sub-envelope reachable from one ref (itself plus every nested child). */
function subEnvelope(envelope: { uid: number; refs: Record<string, EnvelopeRef> }, rootRef: number): { uid: number; refs: Record<string, EnvelopeRef> } {
  const reachable = new Set<number>()
  const visit = (ref: number): void => {
    if (reachable.has(ref)) return
    reachable.add(ref)
    const node = envelope.refs[String(ref)]
    if (node === undefined) return
    const children: number[] = []
    if (node.dict !== undefined) children.push(...Object.values(node.dict))
    if (node.inner !== undefined) children.push(node.inner)
    if (node.list !== undefined) children.push(...node.list)
    for (const child of children) visit(child)
  }
  visit(rootRef)
  const refs: Record<string, EnvelopeRef> = {}
  for (const ref of reachable) {
    const node = envelope.refs[String(ref)]
    if (node !== undefined) refs[String(ref)] = node
  }
  return { uid: rootRef, refs }
}

/** Dereference one ref into a live node, recursively, with a `toJSON()`. */
function derefNode(envelope: { uid: number; refs: Record<string, EnvelopeRef> }, ref: number): NodeTree {
  const node = envelope.refs[String(ref)]
  if (node === undefined) throw new Error(`dsh-llm-qwen-local: missing envelope ref ${ref}`)
  const out: NodeChild = { type: node.type, meta: { ...node.meta } }
  if (node.value !== undefined) out.value = node.value
  if (node.dict !== undefined) {
    out.dict = Object.fromEntries(Object.entries(node.dict).map(([key, childRef]) => [key, derefNode(envelope, childRef)]))
  }
  if (node.inner !== undefined) out.inner = derefNode(envelope, node.inner)
  if (node.list !== undefined) out.list = node.list.map((childRef) => derefNode(envelope, childRef))
  return Object.assign(out, { toJSON: () => subEnvelope(envelope, ref) })
}

/** The dereferenced view of the whole envelope, rooted at the Config object. */
const NODE_TREE: NodeTree = derefNode(ENVELOPE, ENVELOPE.uid)

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
 * The configuration surface the plugin exposes to its consumers: the Cordis
 * loader (reads `Config["~standard"].validate`) and, on DSH >= 0.2.0, the
 * settings service (walks it as a live schemastery node — `.meta.volatile`,
 * `.type`, `.dict` — and rehydrates volatile subtrees via `toJSON()`).
 *
 * The callable is the explicit resolve step (loader validation funnels
 * through it); the dereferenced node tree built above is spread onto it so
 * the 0.2.0 node-walking contract is served by the same hand-owned facts;
 * and `toJSON()` answers the full frozen envelope for the web form renderer.
 * The public type is the schemastery schema shape (`z<Config>`); the runtime
 * stand-in is cast to it because every member a harness code path touches —
 * the call signature, the node-tree members, `toJSON()`, and `["~standard"]`
 * — is implemented here.
 */
export const Config: z<Config> = Object.assign(
  (config: Config): QwenLocalOptions => resolveConfig(config),
  NODE_TREE,
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
