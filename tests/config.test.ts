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
})
