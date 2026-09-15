/**
 * Local, dependency-free copies of the harness branded-identifier constructors.
 *
 * In `@deepseek-ai/dsh-llm` these are pure identity branders: the string is
 * returned unchanged and the brand is a compile-time fiction (a nominal
 * `Branded<...>` type). The published plugin carries no runtime dependency on
 * the package, so the constructors are reproduced here verbatim as runtime
 * identity functions while keeping the EXACT harness branded return types
 * (imported type-only, so the import is erased from the build). Values are
 * branded only where the plugin itself produces them (tool-call ids it
 * assembles, a provider request id it parses, a reasoning-effort id it
 * advertises); the harness never round-trips them through an identity check.
 *
 * @module dsh-llm-qwen-local/harness/brand
 */

import type {
  ProviderRequestId as ProviderRequestIdBrand,
  ReasoningEffortId as ReasoningEffortIdBrand,
  ToolCallId as ToolCallIdBrand,
} from '@deepseek-ai/dsh-llm'

/** Brand a string as a harness tool-call id (identity at runtime). */
export function ToolCallId(id: string): ToolCallIdBrand {
  return id as ToolCallIdBrand
}

/** Brand a string as a harness provider request id (identity at runtime). */
export function ProviderRequestId(id: string): ProviderRequestIdBrand {
  return id as ProviderRequestIdBrand
}

/** Brand a string as a harness reasoning-effort id (identity at runtime). */
export function ReasoningEffortId(id: string): ReasoningEffortIdBrand {
  return id as ReasoningEffortIdBrand
}
