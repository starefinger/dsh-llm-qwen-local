/**
 * Local, dependency-free copy of the harness API-key usability check.
 *
 * Reproduced field-for-field from `@deepseek-ai/dsh-llm`'s `normalizeApiKey`
 * and `assertUsableApiKey` so the published plugin needs no runtime
 * dependency on the package. The transport invariant is identical: a key is
 * usable only if it is non-blank after trimming AND contains only printable
 * ASCII (space excluded) — characters outside that set cannot reach any
 * provider because `fetch` refuses to build the header.
 *
 * @module dsh-llm-qwen-local/harness/api-key
 */

import { INVALID_CREDENTIAL_CODE, LlmError } from './llm-error.js'

/**
 * Characters an HTTP header value carries verbatim and every known provider
 * key uses: printable ASCII, space excluded.
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/**
 * Accept one supplied credential, or refuse it as unusable with a
 * `LlmError` coded `INVALID_CREDENTIAL`.
 *
 * A stored key arrives from the credentials seam, a `.env` line, or a shell
 * export, all of which pick up surrounding whitespace, so trimming is silent.
 * @param raw - the key exactly as configured, stored, or typed.
 * @param pkg - the package name reported in the refusal.
 * @param ref - the credential reference or env name the key resolved from.
 * @returns the trimmed key.
 * @throws LlmError `INVALID_CREDENTIAL` when the key is blank or unsendable.
 */
export function assertUsableApiKey(raw: string, pkg: string, ref: string): string {
  const value = raw.trim()
  if (value.length > 0 && LEGAL_API_KEY.test(value)) return value
  throw new LlmError(
    value.length === 0
      ? `${pkg}: the API key resolved from ${ref} is blank; set ${ref} to the raw key`
        + ' (the web Models page writes it) or export it in the launching environment'
      : `${pkg}: the API key resolved from ${ref} contains characters no HTTP header can carry;`
        + ` set ${ref} to the raw key alone (the web Models page writes it)`,
    INVALID_CREDENTIAL_CODE,
  )
}
