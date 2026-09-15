/**
 * Local, dependency-free copy of the harness `LlmAdapter` base class.
 *
 * The harness `@deepseek-ai/dsh-llm` exports an abstract `LlmAdapter` whose
 * concrete methods carry defaults (`providerRetryPolicy` and
 * `imageRequestPricing` answer `undefined`, `listModels` an empty catalog,
 * `resolveModel` a bare identity, `prepareCall` a two-resolution
 * default) and one abstract method (`stream`). The published plugin carries
 * no runtime dependency on the package, so the base is reproduced here. The
 * harness never does an `instanceof LlmAdapter` check on a registered adapter
 * — it calls the methods duck-typed — so a local base class is
 * behaviorally identical to the package's.
 *
 * Type shapes are imported type-only from `@deepseek-ai/dsh-llm` and erased
 * from the build.
 *
 * @module dsh-llm-qwen-local/harness/llm-adapter
 */

import type {
  GenerateOptions,
  LlmImageRequestPricing,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'

/**
 * A provider-wire adapter for the harness message and stream vocabulary.
 * Register concrete subclasses with `ctx.llm.registerAdapter(providers, adapter)`.
 */
export abstract class LlmAdapter {
  /**
   * Describe one provider route owned by this adapter.
   * @param provider - a route passed to `registerAdapter()` for this instance.
   * @returns detached display metadata whose id must equal `provider`.
   */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /**
   * Return the provider-owned retry policy captured with this route.
   * @param _provider - a route passed to `registerAdapter()` for this instance.
   * @returns a resolved policy, or `undefined` to use the normal defaults.
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  /**
   * Resolve provider-side request-image pricing for one exact model route.
   * The default declares none, so consumers fall back to their own neutral
   * estimate. Implementations must answer synchronously without I/O.
   * @param _provider - a route passed to `registerAdapter()` for this instance.
   * @param _model - exact model id passed to {@link GenerateOptions.model}.
   * @returns route-owned image pricing, or `undefined` when the route declares none.
   */
  imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined {
    return undefined
  }

  /**
   * List models this adapter can currently advertise for one owned provider.
   * The result is advisory: an adapter may accept unlisted model ids.
   * @param _provider - one provider route owned by this adapter.
   * @returns discoverable models in adapter-preferred order.
   */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  /**
   * Resolve all metadata available for one exact model.
   * @param provider - one provider route owned by this adapter.
   * @param model - exact model id passed to {@link GenerateOptions.model}.
   * @param _signal - cancellation for this exact-model lookup.
   * @returns provider/model identity plus any context, call-default, and reasoning metadata.
   */
  resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /**
   * Bind exact model metadata and the eventual request dispatch to one
   * adapter generation. Dynamic adapters override this so settings changes
   * between preparation and dispatch cannot combine one generation's
   * capabilities with another's endpoint.
   * @param provider - registered provider route.
   * @param model - exact model id.
   * @param signal - cancellation for model resolution.
   * @returns model metadata and a one-generation stream entry point.
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  /**
   * Stream one model call as raw chunks. The only required method.
   * @param options - the fully-assembled request; implementations must honor `options.signal`.
   * @returns the chunk stream, obeying the adapter contract documented on `StreamChunk`.
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
