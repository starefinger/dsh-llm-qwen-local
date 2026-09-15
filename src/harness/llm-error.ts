/**
 * Local, dependency-free copy of the harness LLM failure contract.
 *
 * The published plugin carries no runtime dependency on
 * `@deepseek-ai/dsh-llm`. Instead of importing `LlmError` (a class whose
 * identity the harness never checks — `normalizeLlmFailure` trusts a thrown
 * Error's OWN `code` and `failure` data properties when they agree), this
 * module reproduces the same shape: a `LlmError` whose `failure` snapshot
 * retains the serializable provider facts beside the live Error. Throwing it
 * is therefore indistinguishable, to the harness's failure normalizer, from
 * throwing the package's `LlmError`.
 *
 * Kept field-for-field in sync with `@deepseek-ai/dsh-llm`'s `LlmError`
 * constructor validation and `failureSnapshot` retention set
 * (message, code, status, providerRetryAfterMs, requestId).
 *
 * @module dsh-llm-qwen-local/harness/llm-error
 */

/** Serializable provider facts retained beside a thrown LlmError. */
export interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
  readonly requestId?: string
}

/** A thrown LLM-adapter failure carrying its own serializable `failure` facts. */
export class LlmError extends Error {
  /**
   * Stable machine-routable failure class. Must be an OWN data property: the
   * harness `normalizeLlmFailure` reads `code` and `failure` through
   * `Object.getOwnPropertyDescriptor` (own data properties only) and trusts the
   * carried snapshot only when both agree. A prototype-inherited `code` would
   * make it fall through to the `UNKNOWN` fallback.
   */
  readonly code: string
  /** Serializable facts retained beside this live Error. */
  readonly failure: LlmFailure

  constructor(
    message: string,
    code: string,
    options?: {
      cause?: unknown
      status?: number
      providerRetryAfterMs?: number
      requestId?: string
    },
  ) {
    if (typeof message !== 'string' || message.length === 0) {
      throw new Error('LlmError message must be a non-empty string')
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error('LlmError code must be a non-empty string')
    }
    if (
      options?.status !== undefined
      && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)
    ) {
      throw new Error('LlmError status must be an integer from 100 through 599')
    }
    if (
      options?.providerRetryAfterMs !== undefined
      && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)
    ) {
      throw new Error('LlmError providerRetryAfterMs must be a positive finite number')
    }
    if (
      options?.requestId !== undefined
      && (typeof options.requestId !== 'string' || options.requestId.length === 0)
    ) {
      throw new Error('LlmError requestId must be a non-empty string')
    }
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LlmError'
    this.code = code
    this.failure = Object.freeze({
      message,
      code,
      ...options?.status === undefined ? {} : { status: options.status },
      ...options?.providerRetryAfterMs === undefined
        ? {}
        : { providerRetryAfterMs: options.providerRetryAfterMs },
      ...options?.requestId === undefined ? {} : { requestId: options.requestId },
    })
  }
}

/** Model returned a completed response with no content. */
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
/** A supplied credential is blank or carries characters no HTTP header can carry. */
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'
/** The combined request/response would exceed the model's context capacity. */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
/** The provider quota was exhausted. */
export const QUOTA_EXCEEDED_CODE = 'QUOTA'
