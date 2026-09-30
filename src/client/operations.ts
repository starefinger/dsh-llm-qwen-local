/**
 * The Host reads and writes the configuration page performs, as callbacks built
 * in the plugin body. The page component receives these instead of a context
 * or a client API: the outcomes name what the form renders — a stored-or-
 * removed credential, or a candidate list — so the failure codes and Remote
 * namespaces stay in the apply world.
 *
 * The settings section itself is NOT one of these callbacks: the page is
 * injected with the shared `ConfigForm` scope for the `llm-qwen-local`
 * namespace (from the settings domain's `configForms` service), which owns the
 * staged reads, the ordered revision-fenced writes, and the recovery reload.
 *
 * Every typed `ctx.remote.*` method returns the `RemoteResult` envelope
 * (`{ ok, value } | { ok, error }`); the callbacks flatten it into the outcome
 * types below. `settingsNs` is a separate argument to `llm.discoverModels` in
 * the 0.1.2 remote-namespace model, not a field of the request body.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  CredentialInfo, LlmDiscoveredModel, LlmModelDiscoveryRequest,
} from '@deepseek-ai/dsh-api-remotes/client'

/** What one credential write (store or remove) answered. */
export type CredentialWriteOutcome =
  /** Committed. */
  | { readonly kind: 'done' }
  /** Any refusal, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one endpoint interrogation answered. */
export type ModelDiscoveryOutcome =
  /** The candidates the provider disclosed, in its own order. */
  | { readonly kind: 'found'; readonly models: readonly LlmDiscoveredModel[] }
  /** The interrogation was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** The Host operations the Qwen (local) configuration page invokes. */
export interface QwenLocalOperations {
  /**
   * Read one credential reference's state.
   * @param ref - credential reference name.
   * @returns the state, or undefined when the reference is unknown or the read was refused.
   */
  describeCredential(ref: string): Promise<CredentialInfo | undefined>
  /**
   * Store one credential literal under its reference.
   * @param ref - credential reference name.
   * @param value - the literal to store.
   * @returns the refusal, or done.
   */
  storeCredential(ref: string, value: string): Promise<CredentialWriteOutcome>
  /**
   * Remove one credential reference (idempotent).
   * @param ref - credential reference name.
   * @returns the refusal, or done.
   */
  removeCredential(ref: string): Promise<CredentialWriteOutcome>
  /**
   * Ask the route's provider endpoint what models it serves.
   * @param settingsNs - namespace whose adapter family answers.
   * @param request - endpoint facts as the form currently shows them.
   * @returns the candidates, or the refusal.
   */
  discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<ModelDiscoveryOutcome>
}

/**
 * Bind the page's Host operations to the plugin's own Remote namespaces.
 * @param ctx - the page plugin's context, which declares `remote.credentials`
 * and `remote.llm` in its own `inject`.
 * @returns the callbacks the page is injected with.
 */
export function createQwenLocalOperations(ctx: ClientContext): QwenLocalOperations {
  return {
    describeCredential: async (ref) => {
      const response = await ctx.remote.credentials.describe([ref])
      return response.ok ? response.value[ref] : undefined
    },
    storeCredential: async (ref, value) => {
      const response = await ctx.remote.credentials.set(ref, value)
      return response.ok ? { kind: 'done' } : { kind: 'refused', message: response.error.message }
    },
    removeCredential: async (ref) => {
      const response = await ctx.remote.credentials.unset(ref)
      return response.ok ? { kind: 'done' } : { kind: 'refused', message: response.error.message }
    },
    discoverModels: async (settingsNs, request) => {
      const response = await ctx.remote.llm.discoverModels(settingsNs, request)
      return response.ok
        ? { kind: 'found', models: response.value }
        : { kind: 'refused', message: response.error.message }
    },
  }
}
