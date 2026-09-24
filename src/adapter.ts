/**
 * `QwenLocalAdapter`: fetch + SSE against a vLLM (OpenAI-compatible)
 * chat-completions endpoint serving locally deployed Qwen models, emitting
 * harness StreamChunks. The adapter is transport-only: connection facts
 * arrive through a thunk resolved once per operation, so the registering
 * plugin owns validation and credential policy.
 *
 * Error paths (the two sanctioned ones): transport and protocol failures
 * (fetch failure, non-2xx, malformed SSE, truncation, idle timeout) THROW
 * `LlmError` with a stable code; a provider in-band failure (an error payload
 * mid-stream) ends the stream with `finish {kind: 'error'}`. Caller aborts
 * map to `LlmError` code `ABORTED`, which the harness normalizes to an
 * `aborted` finish.
 *
 * @module dsh-llm-qwen-local/adapter
 */

import { LlmAdapter } from './harness/llm-adapter.js'
import { LlmError } from './harness/llm-error.js'
import { assertUsableApiKey } from './harness/api-key.js'
import { attributionHeaders } from './harness/attribution.js'
import { ProviderRequestId } from './harness/brand.js'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { unlistedModel } from './serialize.js'
import { serializeRequest } from './serialize.js'
import { parseSse } from './sse.js'
import { translate } from './translate.js'
import type { QwenLocalModel, QwenLocalOptions } from './config.js'
import type { WireError } from './wire.js'

/** Constructor options for {@link QwenLocalAdapter}: the resolution hooks the plugin owns. */
export interface QwenLocalAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => QwenLocalOptions
  /**
   * Resolve the optional durable attachment service at request time. `undefined`
   * refuses any image with `UNSUPPORTED_CONTENT` rather than guessing a source.
   */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Resolve a named credential per request. The registering plugin wires this
   * to the durable credentials service (what the web Models page writes) with
   * a launch-environment fallback; a miss must throw `MISSING_CREDENTIAL` —
   * once a profile names a key, failing loud beats authenticating as the
   * wrong tenant. Absent (standalone or test use), the adapter reads the
   * process environment itself.
   */
  resolveApiKey?: (ref: string) => Promise<string>
}

/**
 * A read-idle watchdog: it arms a timer that aborts its own controller when no
 * transport activity arrives within the window; {@link pulse} resets it. The
 * combined signal (upstream plus the watchdog) is what fetch and body reads
 * honor.
 */
export class IdleTimeout {
  /** Whether the watchdog fired (distinguishes TIMEOUT from caller ABORTED). */
  fired = false

  private readonly controller = new AbortController()
  private readonly signal: AbortSignal
  private timer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(upstream: AbortSignal | undefined, private readonly ms: number) {
    this.signal = upstream === undefined
      ? this.controller.signal
      : AbortSignal.any([upstream, this.controller.signal])
    this.arm()
  }

  /** The combined signal to pass to fetch and body reads. */
  get combined(): AbortSignal {
    return this.signal
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      this.fired = true
      this.controller.abort(new Error(`qwen-local stream idle for ${this.ms}ms`))
    }, this.ms)
    // Never hold the event loop open on a stream the consumer abandoned.
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Record transport activity and restart the window. */
  pulse(): void {
    if (this.disposed || this.timer === undefined) return
    clearTimeout(this.timer)
    this.arm()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** Parse a Retry-After header into milliseconds, when valid. */
function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

/** The one adapter instance for the local Qwen deployment. */
export class QwenLocalAdapter extends LlmAdapter {
  constructor(private readonly config: QwenLocalAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Qwen (local)' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => this.modelInfo(provider, model)))
  }

  /**
   * Bind exact model metadata and the request dispatch to ONE connection
   * generation (the new `LlmAdapter.prepareCall` seam). The harness prepares a
   * call before dispatching it; without this override the default
   * implementation would resolve the model and stream through two separate
   * `options()` reads, so a settings commit between preparation and dispatch
   * could combine one generation's modalities with another generation's
   * endpoint. The snapshot also freezes `resolveApiKey`-independent facts for
   * the whole dispatch.
   * @param provider - registered provider route.
   * @param model - exact model id.
   * @returns model metadata and a one-generation stream entry point.
   */
  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const connection = this.config.options()
    return Promise.resolve({
      model: this.resolveModelWith(provider, model, connection),
      stream: options => this.streamWithConnection(options, connection),
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(this.resolveModelWith(provider, model, this.config.options()))
  }

  /** Exact-model metadata from one fixed connection snapshot. */
  private resolveModelWith(provider: string, model: string, connection: QwenLocalOptions): LlmResolvedModelInfo {
    const configured = connection.models.find(entry => entry.id === model)
    if (configured === undefined) {
      // The uncatalogued fallback declares the same negative multimodal
      // capability as a text-only entry: "unknown" would let the host accept
      // and persist images the serializer must then reject.
      return {
        provider,
        id: model,
        name: model,
        inputModalities: ['text'],
        context: { contextWindow: connection.defaultContextWindow },
        defaultMaxTokens: connection.maxTokens,
      }
    }
    return this.resolvedModelInfo(provider, configured, connection)
  }

  /** Detached display metadata for one configured model. */
  private modelInfo(provider: string, model: QwenLocalModel): LlmModelInfo {
    return {
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...model.description === undefined ? {} : { description: model.description },
      inputModalities: model.multimodal ? ['text', 'image'] : ['text'],
    }
  }

  /** Exact-route metadata: capacity, output cap, and the configured reasoning offer. */
  private resolvedModelInfo(
    provider: string,
    model: QwenLocalModel,
    connection: QwenLocalOptions,
  ): LlmResolvedModelInfo {
    const reasoning = model.reasoning
    return {
      ...this.modelInfo(provider, model),
      context: { contextWindow: model.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: model.maxTokens ?? connection.maxTokens,
      ...reasoning === undefined ? {} : {
        reasoning: {
          // Adapter-owned opaque ids, in configured display order; wire
          // spellings stay inside the adapter.
          efforts: reasoning.efforts.map(effort => ({
            id: effort.id as ReasoningEffortId,
            name: effort.name ?? effort.id,
          })),
          ...reasoning.defaultEffort === undefined ? {} : {
            defaultEffort: reasoning.defaultEffort as ReasoningEffortId,
          },
        },
      },
    }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConnection(options, this.config.options())
  }

  private async * streamWithConnection(
    options: GenerateOptions,
    connection: QwenLocalOptions,
  ): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts freeze here and hold
    // for this whole request, so an in-flight stream never observes a
    // configuration change and the next call re-resolves.
    const model = connection.models.find(entry => entry.id === options.model) ?? unlistedModel(options.model)
    const attachments = this.config.resolveAttachments?.()
    let body
    try {
      body = await serializeRequest(options, model, attachments)
    } catch (error: unknown) {
      if (error instanceof LlmError) throw error
      throw new LlmError('qwen-local request serialization failed', 'PROTOCOL', { cause: error })
    }
    const apiKey = connection.apiKeyEnv === undefined
      ? undefined
      : this.config.resolveApiKey !== undefined
        ? await this.config.resolveApiKey(connection.apiKeyEnv)
        : bearerKey(connection)

    // One stable signal reaches both initial fetch and body reads: the
    // caller's (when present) joined with the idle watchdog's.
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const idle = new IdleTimeout(upstream, connection.streamIdleTimeoutMs)
    const iterator = this.request(body, idle.combined, connection, apiKey, () => { idle.pulse() })[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await iterator.next()
        if (result.done) {
          exhausted = true
          return
        }
        idle.pulse()
        yield result.value
      }
    } catch (error: unknown) {
      if (idle.fired) {
        throw new LlmError(
          `qwen-local stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('qwen-local request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`qwen-local API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      idle.dispose()
      consumer.abort('qwen-local stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    body: Parameters<typeof JSON.stringify>[0],
    signal: AbortSignal,
    connection: QwenLocalOptions,
    apiKey: string | undefined,
    onFrame: () => void,
  ): AsyncIterable<StreamChunk> {
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
      ...apiKey === undefined ? {} : { 'authorization': `Bearer ${apiKey}` },
    }

    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      // The outer stream distinguishes caller cancellation and watchdog expiry.
      if (signal.aborted) throw error
      throw new LlmError(
        `qwen-local API request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `qwen-local API error (HTTP ${response.status})`
      let providerError: WireError['error']
      try {
        const parsed = await response.json() as WireError
        providerError = parsed.error ?? null
        if (providerError?.message) message = providerError.message
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the
        // failure, so malformed gateway JSON must not mask it.
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status), {
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (!response.body) {
      throw new LlmError('qwen-local API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body, onFrame))
  }
}

/** Read the optional bearer token from the named environment variable, per request. */
export function bearerKey(connection: QwenLocalOptions): string | undefined {
  if (connection.apiKeyEnv === undefined) return undefined
  const value = process.env[connection.apiKeyEnv]
  if (value === undefined || value.trim().length === 0) return undefined
  return assertUsableApiKey(value, 'dsh-llm-qwen-local', connection.apiKeyEnv)
}

/** A provider-request id from the standard headers, when present. */
function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}
