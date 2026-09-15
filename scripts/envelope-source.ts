/**
 * Reference copy of the ORIGINAL schemastery `Config` schema, kept only so the
 * frozen `ENVELOPE` constant in `src/config.ts` can be drift-checked.
 *
 * The frozen envelope was captured once from this schema's `toJSON()` output.
 * `node scripts/extract-envelope.mjs --check` bundles this file and
 * `src/config.ts`, then diffs their `Config.toJSON()` results — so if the
 * Config shape (field set, defaults, or schemastery constraints) ever changes,
 * the check fails loudly and the frozen constant must be regenerated with
 * `node scripts/extract-envelope.mjs` (run against the pre-refactor tree, or
 * by updating both files together).
 *
 * This file is NOT imported by the build or the published plugin: it is a
 * dev-only reference, which is why it may keep a runtime `@deepseek-ai/
 * schemastery` import even though the published plugin has none.
 */
import z from '@deepseek-ai/schemastery'
import type {
  Config as ConfigType,
  QwenLocalModel,
  QwenLocalReasoning,
  QwenLocalReasoningEffort,
} from '../src/config.ts'

// Mirrors the exported defaults in src/config.ts (kept in sync by the check).
const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1'
const DEFAULT_CONTEXT_WINDOW = 262_144
const DEFAULT_MAX_TOKENS = 32_768
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

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
  imageMaxPixels: z.number().step(1).min(1),
  imageMaxBytes: z.number().step(1).min(1),
  reasoning: reasoningSchema,
})

export const Config: z<ConfigType> = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  apiKeyEnv: z.string(),
  models: z.array(modelSchema).min(1).required(),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxRequestImageBytes: z.number().step(1).min(1),
})
