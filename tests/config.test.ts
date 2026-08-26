import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import type { Config } from '../src/config.js'

const BASE: Config = {
  models: [{ id: 'qwen3.8', multimodal: true }],
}

const REASONING = {
  efforts: [
    { id: 'low', wire: 'low' },
    { id: 'xhigh', wire: 'xhigh' },
  ],
  defaultEffort: 'xhigh',
  offMode: 'chat-template-kwargs',
} as const

describe('resolveConfig', () => {
  it('accepts a model whose efforts declare no off level', () => {
    const resolved = resolveConfig({
      ...BASE,
      models: [{ id: 'qwen3.8', multimodal: true, reasoning: { ...REASONING, efforts: [...REASONING.efforts] } }],
    })
    const model = resolved.models[0]
    if (model === undefined || model.reasoning === undefined) throw new Error('expected a reasoning model')
    expect(model.reasoning.efforts.map(e => e.id)).toEqual(['low', 'xhigh'])
    expect(model.preserveThinking).toBe(true)
  })

  it('accepts a model with an off level', () => {
    const resolved = resolveConfig({
      ...BASE,
      models: [{
        id: 'qwen3.8',
        reasoning: {
          efforts: [
            { id: 'off', wire: null },
            { id: 'xhigh', wire: 'xhigh' },
          ],
          defaultEffort: 'xhigh',
          offMode: 'chat-template-kwargs',
        },
      }],
    })
    expect(resolved.models[0]?.reasoning?.efforts).toHaveLength(2)
  })

  it('refuses a null wire on a non-off level', () => {
    expect(() => resolveConfig({
      ...BASE,
      models: [{
        id: 'qwen3.8',
        reasoning: {
          efforts: [{ id: 'low', wire: null }],
          offMode: 'chat-template-kwargs',
        },
      }],
    })).toThrow(/may not use a null wire/)
  })

  it('refuses a defaultEffort that names no declared level', () => {
    expect(() => resolveConfig({
      ...BASE,
      models: [{
        id: 'qwen3.8',
        reasoning: {
          efforts: [{ id: 'low', wire: 'low' }],
          defaultEffort: 'high',
          offMode: 'chat-template-kwargs',
        },
      }],
    })).toThrow(/defaultEffort "high" is not among/)
  })

  it('refuses duplicate model ids and empty model lists', () => {
    expect(() => resolveConfig({
      ...BASE,
      models: [
        { id: 'a' },
        { id: 'a' },
      ],
    })).toThrow(/duplicate model "a"/)
    expect(() => resolveConfig({ ...BASE, models: [] })).toThrow(/at least one model/)
  })

  it('refuses duplicate effort ids within one model', () => {
    expect(() => resolveConfig({
      ...BASE,
      models: [{
        id: 'qwen3.8',
        reasoning: {
          efforts: [
            { id: 'low', wire: 'low' },
            { id: 'low', wire: 'low' },
          ],
          offMode: 'chat-template-kwargs',
        },
      }],
    })).toThrow(/duplicate reasoning effort "low"/)
  })

  it('accepts per-model image budgets and the route image byte cap, preserving absence', () => {
    const resolved = resolveConfig({
      ...BASE,
      maxRequestImageBytes: 8 * 1024 * 1024,
      models: [{
        id: 'qwen3.8',
        multimodal: true,
        imageMaxPixels: 123_456,
        imageMaxBytes: 2048,
      }],
    })
    expect(resolved.maxRequestImageBytes).toBe(8 * 1024 * 1024)
    expect(resolved.models[0]?.imageMaxPixels).toBe(123_456)
    expect(resolved.models[0]?.imageMaxBytes).toBe(2048)
    expect(resolved.models[0]).not.toHaveProperty('contextWindow')
    expect(resolved).not.toHaveProperty('streamIdleTimeoutMs', undefined)
  })

  it('leaves the image fields absent when the config omits them', () => {
    const resolved = resolveConfig(BASE)
    expect(resolved.maxRequestImageBytes).toBeUndefined()
    expect(resolved.models[0]).not.toHaveProperty('imageMaxPixels')
    expect(resolved.models[0]).not.toHaveProperty('imageMaxBytes')
  })

  it('refuses non-positive image budgets and route cap', () => {
    expect(() => resolveConfig({
      ...BASE,
      models: [{ id: 'qwen3.8', imageMaxPixels: 0 }],
    })).toThrow(/imageMaxPixels must be a positive integer/)
    expect(() => resolveConfig({
      ...BASE,
      models: [{ id: 'qwen3.8', imageMaxBytes: -1 }],
    })).toThrow(/imageMaxBytes must be a positive integer/)
    expect(() => resolveConfig({ ...BASE, maxRequestImageBytes: 0 }))
      .toThrow(/maxRequestImageBytes must be a positive safe integer/)
  })
})
