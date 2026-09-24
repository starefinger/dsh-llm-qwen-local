/**
 * Boot regression for the zero-dependency refactor: the frozen `Config` surface
 * in src/config.ts must survive the REAL Cordis plugin-load validation.
 *
 * At plugin load, Cordis runs `resolveConfig(runtime, config)` where
 * `runtime.Config` is our exported `Config`. That calls
 * `Config["~standard"].validate(config)`, throws a `ValidationError` when the
 * result carries issues, and returns `.value` otherwise. Previously that path
 * was served by a live schemastery schema; now it is served by the hand-owned
 * `~standard` surface funneling through `resolveConfig`. This test drives the
 * real Cordis `resolveConfig` with the real `cordis.patch.yml` entry shape to
 * prove the load path is unchanged end to end.
 *
 * It also asserts the settings-service touchpoints the web form renderer and
 * the optional-settings consumer rely on (`Config(merged)` as a callable, and
 * `Config.toJSON()` as the frozen envelope).
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig as cordisResolveConfig, ValidationError } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from '../src/config.js'

// The exact `config` block from cordis.patch.yml (the `!!js` tag resolves to
// the same string default our code applies when the env var is unset).
const PATCH_ENTRY = {
  baseURL: 'http://127.0.0.1:8000/v1',
  models: [
    {
      id: 'qwen3.8',
      name: 'Qwen3.8-27B (local)',
      multimodal: true,
      reasoning: {
        efforts: [
          { id: 'off', wire: 'none' },
          { id: 'low', wire: 'low' },
          { id: 'medium', wire: 'medium' },
          { id: 'xhigh', wire: 'xhigh' },
        ],
        defaultEffort: 'xhigh',
      },
    },
  ],
}

// The runtime object Cordis stores at `ctx.plugin()`. Cordis's
// `resolveConfig` reads only `runtime.Config` (the `fibers`/`callback` members
// are used elsewhere in the Fiber lifecycle), so the shim supplies just that.
const RUNTIME = { Config } as unknown as Parameters<typeof cordisResolveConfig>[0]

describe('boot: real Cordis load-time validation against the frozen Config', () => {
  it('accepts the cordis.patch.yml entry and resolves to the explicit resolve step output', () => {
    const resolved = cordisResolveConfig(RUNTIME, PATCH_ENTRY)
    // The resolved value is exactly what the explicit resolve step produces —
    // the same value the adapter and discovery hooks consume per request.
    expect(resolved).toEqual(resolveConfig(PATCH_ENTRY))
    expect(resolved.baseURL).toBe('http://127.0.0.1:8000/v1')
    expect(resolved.defaultContextWindow).toBe(262_144) // route default filled
    expect(resolved.maxTokens).toBe(32_768) // route default filled
    expect(resolved.streamIdleTimeoutMs).toBe(300_000) // route default filled
    const model = resolved.models[0]
    expect(model.id).toBe('qwen3.8')
    expect(model.multimodal).toBe(true)
    expect(model.preserveThinking).toBe(true) // model default filled
    expect(model.reasoning?.defaultEffort).toBe('xhigh')
    expect(model.reasoning?.offMode).toBe('chat-template-kwargs') // default filled
  })

  it('fills no defaults the patch entry already supplies', () => {
    const resolved = cordisResolveConfig(RUNTIME, PATCH_ENTRY) as { baseURL: string }
    expect(resolved.baseURL).toBe(PATCH_ENTRY.baseURL)
  })

  it('throws a Cordis ValidationError (not a generic error) for an invalid entry', () => {
    // An absent model list is legal (dormant route); the per-entry rule that
    // still fails loudly is a null wire on a non-off effort.
    expect(() => cordisResolveConfig(RUNTIME, { baseURL: 'http://127.0.0.1:8000/v1' }))
      .not.toThrow()
    expect(() => cordisResolveConfig(RUNTIME, {
      models: [{
        id: 'm',
        reasoning: {
          efforts: [{ id: 'low', wire: null }],
          defaultEffort: 'low',
          offMode: 'chat-template-kwargs',
        },
      }],
    })).toThrow(ValidationError)
  })

  it('reports the specific issue message through the ValidationError', () => {
    try {
      // A reasoning wire that is null on a non-off effort is the one hard
      // per-entry rule left: the issue text surfaces through the validation
      // wrapper.
      cordisResolveConfig(RUNTIME, {
        models: [{
          id: 'm',
          reasoning: {
            efforts: [{ id: 'low', wire: null }],
            defaultEffort: 'low',
            offMode: 'chat-template-kwargs',
          },
        }],
      })
      expect.unreachable('expected a ValidationError')
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as Error).message).toMatch(/invalid config:/)
      expect((error as Error).message).toMatch(/may not use a null wire/)
    }
  })
})

describe('boot: settings-service touchpoints on the frozen Config', () => {
  it('invokes Config(merged) as the settings service does (resolve: schema(mergeLayers(base, section)))', () => {
    // The settings service computes `resolved = schema(mergeLayers(base, section))`
    // where base is the composition entry and section the user layer. A user
    // `models` list supersedes the base list wholesale while route fields
    // inherit — the merged object below is that exact input.
    const merged = {
      baseURL: 'http://127.0.0.1:9000/v1',
      models: [{ id: 'other-model' }],
    }
    const resolved = Config(merged)
    expect(resolved.baseURL).toBe('http://127.0.0.1:9000/v1')
    const models = resolved.models ?? []
    expect(models).toHaveLength(1)
    const model = models[0]
    if (model === undefined) throw new Error('expected one model')
    expect(model.id).toBe('other-model')
    expect(model.multimodal).toBe(false) // model default filled
    expect(resolved.defaultContextWindow).toBe(262_144) // route default filled
    expect(resolved.maxTokens).toBe(32_768) // route default filled
  })

  it('answers the frozen envelope for the web form renderer via toJSON()', () => {
    // toJSON() is typed via the schemastery schema shape, but the runtime value
    // is the frozen plain object; assert against that concrete shape. Ref uids
    // are an artifact of the generator (they renumber on any shape change), so
    // the assertion follows envelope.uid instead of pinning numbers.
    const envelope = Config.toJSON() as {
      uid: number
      refs: Record<string, {
        type?: string
        meta?: { required?: boolean; min?: number; default?: unknown }
        dict?: Record<string, number>
        inner?: number
      }>
    }
    const root = envelope.refs[String(envelope.uid)]
    if (root === undefined) throw new Error('expected the root envelope ref')
    expect(root.type).toBe('object')
    // The root dict lists exactly the six route-level field names.
    expect(Object.keys(root.dict ?? {}).sort()).toEqual([
      'apiKeyEnv', 'baseURL', 'defaultContextWindow', 'maxTokens', 'models', 'streamIdleTimeoutMs',
    ])
    // `models` is an optional array defaulting to [] (no min, no required) —
    // an empty catalog is a legal (dormant) configuration.
    const modelsRef = root.dict?.models
    if (modelsRef === undefined) throw new Error('expected a models ref')
    const models = envelope.refs[String(modelsRef)]
    if (models === undefined) throw new Error('expected the models ref object')
    expect(models.type).toBe('array')
    expect(models.meta).toEqual({ default: [] })
  })
})
