/**
 * Model discovery for the local Qwen deployment: while a configuration
 * surface (the web Models page) still edits a draft, it may interrogate the
 * endpoint's OpenAI-compatible `GET /models` listing. A draft that names no
 * endpoint is answered from the adapter's own catalog instead — the
 * adapter's registry is the better answer and it costs no network call.
 *
 * The draft's `apiKey` is for this interrogation alone; the harness never
 * stores it. When the draft carries none, the stored credential of the
 * route being edited is supplied by the registering plugin, and a miss
 * probes the endpoint unauthenticated (most local vLLM instances use no
 * auth at all).
 *
 * @module dsh-llm-qwen-local/discovery
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import { httpErrorCode } from './adapter.js'

/** The facts a discovery implementation needs from its registering plugin. */
export interface QwenLocalDiscoveryFacts {
  /**
   * The adapter's own catalog for a configured route; a draft naming no
   * endpoint is answered from this knowledge without a network call.
   */
  ownModels(): readonly LlmDiscoveredModel[]
  /**
   * The stored credential for a route the draft names, when the draft
   * carries none. `undefined` probes the endpoint unauthenticated.
   */
  storedApiKey(provider: string | undefined): Promise<string | undefined>
}

/**
 * Interrogate one endpoint's model list.
 * @param request - the draft a configuration surface is still editing.
 * @param facts - catalog and credential access owned by the plugin.
 * @throws LlmError `INVALID_REQUEST` (with `status`) on a rejected probe, `TRANSPORT` on a failed connection, `ABORTED` on caller cancellation.
 */
export async function discoverQwenModels(
  request: LlmModelDiscoveryRequest,
  facts: QwenLocalDiscoveryFacts,
): Promise<readonly LlmDiscoveredModel[]> {
  if (request.baseURL === undefined || request.baseURL.trim().length === 0) {
    if (request.provider === undefined) {
      throw new LlmError(
        'qwen-local model discovery needs an endpoint to interrogate or a configured route to describe',
        'INVALID_REQUEST',
      )
    }
    return facts.ownModels()
  }
  const apiKey = request.apiKey ?? await facts.storedApiKey(request.provider)
  const url = `${request.baseURL.replace(/\/+$/, '')}/models`
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...attributionHeaders(),
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
  } catch (error: unknown) {
    if (request.signal !== undefined && request.signal.aborted) {
      throw new LlmError('qwen-local model discovery aborted', 'ABORTED', { cause: error })
    }
    throw new LlmError(`qwen-local model list request to ${url} failed`, 'TRANSPORT', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `qwen-local model list request to ${url} failed (HTTP ${response.status})`,
      httpErrorCode(response.status),
      { status: response.status },
    )
  }
  const body = (await response.json()) as { data?: unknown }
  const data: unknown[] = Array.isArray(body.data) ? body.data : []
  return data
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map(entry => ({
      id: String(entry.id ?? ''),
      ...(typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {}),
      ...(typeof entry.context_window === 'number' ? { contextWindow: entry.context_window } : {}),
      ...(typeof entry.max_tokens === 'number' ? { maxTokens: entry.max_tokens } : {}),
    }))
    .filter(model => model.id.length > 0)
}
