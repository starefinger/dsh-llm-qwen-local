/**
 * The Host reads and writes the settings page performs, as callbacks built in
 * the plugin body (0.1.2 remote-namespace model). The section component
 * receives these instead of a context or a client API: the outcomes name
 * what the form renders — a stored view, a stored-or-removed credential, a
 * candidate list, or a refusal message — so the failure codes and Remote
 * namespaces stay in the apply world.
 *
 * Every typed `ctx.remote.*` method returns the `RemoteResult` envelope
 * (`{ ok, value } | { ok, error }`); the callbacks flatten it into the
 * outcome types below. `settingsNs` is a separate argument to
 * `llm.discoverModels` in 0.1.2, not a field of the request body.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  CredentialInfo, LlmDiscoveredModel, LlmModelDiscoveryRequest,
  SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** What one credential write (store or remove) answered. */
export type CredentialWriteOutcome =
  /** Committed. */
  | { readonly kind: 'done' }
  /** Any refusal, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What the section describe answered. */
export type SectionDescribeOutcome =
  /** The section's redacted view (value and the revision to fence writes). */
  | { readonly kind: 'view'; readonly view: SettingsNamespaceView }
  /** The plugin's settings section is not registered (node side absent). */
  | { readonly kind: 'missing' }
  /** The describe was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one section write answered. */
export type SectionWriteOutcome =
  /** Committed; the view carries the stored value and the new revision. */
  | { readonly kind: 'written'; readonly view: SettingsNamespaceView }
  /**
   * The stored revision moved after the form read it, so the draft is stale.
   * The message stays for callers that report the Host diagnostic as it is.
   */
  | { readonly kind: 'conflict'; readonly message: string }
  /** Any other refusal, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one endpoint interrogation answered. */
export type ModelDiscoveryOutcome =
  /** The candidates the provider disclosed, in its own order. */
  | { readonly kind: 'found'; readonly models: readonly LlmDiscoveredModel[] }
  /** The interrogation was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** The Host operations the Qwen (local) settings page invokes. */
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
   * Read the settings namespaces; the caller picks its own section.
   * @param ns - the settings namespace this page edits.
   * @returns the view, missing, or the refusal.
   */
  describeSection(ns: string): Promise<SectionDescribeOutcome>
  /**
   * Replace one namespace's stored user section wholesale, revision-fenced.
   * @param ns - settings namespace key.
   * @param section - complete replacement user section.
   * @param expectedRevision - revision the form read; undefined writes unfenced.
   * @returns the write outcome.
   */
  replaceSection(
    ns: string,
    section: Record<string, unknown>,
    expectedRevision: number | undefined,
  ): Promise<SectionWriteOutcome>
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
 * @param ctx - the page plugin's context, which declares `remote.credentials`,
 * `remote.llm`, and `remote.settings` in its own `inject`.
 * @param sectionNs - the settings namespace this page edits.
 * @returns the callbacks the section is injected with.
 */
export function createQwenLocalOperations(ctx: ClientContext, sectionNs: string): QwenLocalOperations {
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
    describeSection: async () => {
      const response = await ctx.remote.settings.describe()
      if (!response.ok) return { kind: 'refused', message: response.error.message }
      const view = response.value.namespaces.find(entry => entry.ns === sectionNs)
      return view === undefined ? { kind: 'missing' } : { kind: 'view', view }
    },
    replaceSection: async (ns, section, expectedRevision) => {
      // The form's draft is JSON-shaped but tolerant (unknown leaves); the wire
      // vocabulary is JsonValue. The section came from a parsed JSON record, so
      // this is a shape assertion at the one place both meet.
      const response = await ctx.remote.settings.replace(
        ns,
        section as Record<string, JsonValue>,
        expectedRevision,
      )
      if (response.ok) return { kind: 'written', view: response.value }
      const { code, message } = response.error
      return code === 'settings/conflict' ? { kind: 'conflict', message } : { kind: 'refused', message }
    },
    discoverModels: async (settingsNs, request) => {
      const response = await ctx.remote.llm.discoverModels(settingsNs, request)
      return response.ok
        ? { kind: 'found', models: response.value }
        : { kind: 'refused', message: response.error.message }
    },
  }
}
