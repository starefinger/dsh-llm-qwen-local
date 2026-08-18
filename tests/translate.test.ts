import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { translate } from '../src/translate.js'

/** Collect the full chunk sequence; rethrows mid-stream errors. */
async function collect(payloads: string[]): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of translate((async function* () {
    yield* payloads
  })())) {
    chunks.push(chunk)
  }
  return chunks
}

const done = (payloads: Record<string, unknown>[]): string[] => [
  ...payloads.map(p => JSON.stringify(p)),
  '[DONE]',
]

describe('translate', () => {
  it('streams interleaved reasoning, text, and tool calls, flushing usage before finish', async () => {
    const chunks = await collect(done([
      { choices: [{ delta: { role: 'assistant', reasoning_content: '' } }] },
      { choices: [{ delta: { reasoning_content: 'let me think' } }] },
      { choices: [{ delta: { reasoning_content: ' more' } }] },
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"co' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mmand":"ls"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 20 } },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } },
    ]))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'let me think' },
      { type: 'reasoning-delta', index: 0, text: ' more' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Hello' },
      { type: 'text-delta', index: 1, text: ' world' },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'bash', argumentsDelta: '{"co' },
      { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'bash', argumentsDelta: 'mmand":"ls"}' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'let me think more' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello world' } },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('does not open a reasoning block for an empty initial delta', async () => {
    const chunks = await collect(done([
      { choices: [{ delta: { reasoning_content: '' } }] },
      { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] },
    ]))
    expect(chunks.some(c => c.type === 'block-start' && c.blockType === 'reasoning')).toBe(false)
    const finish = chunks.at(-1)
    expect(finish).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('subtracts cached prompt tokens to keep counts disjoint', async () => {
    const chunks = await collect(done([
      { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } } },
    ]))
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 60, outputTokens: 5, cacheReadTokens: 40 } })
  })

  it('reports informational reasoning tokens folded into output', async () => {
    const chunks = await collect(done([
      { choices: [{ delta: { reasoning_content: 'hm' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 6 } } },
    ]))
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 1, outputTokens: 9, reasoningTokens: 6 } })
  })

  it('maps finish reasons: length and content_filter', async () => {
    const a = await collect(done([
      { choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] },
    ]))
    expect(a.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    const b = await collect(done([
      { choices: [{ delta: { content: 'x' }, finish_reason: 'content_filter' }] },
    ]))
    expect(b.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    const c = await collect(done([
      { choices: [{ delta: { content: 'x' }, finish_reason: 'something_new' }] },
    ]))
    expect(c.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'model stopped: something_new', code: 'SOMETHING_NEW' } },
    })
  })

  it('maps an empty stop completion to an EMPTY_RESPONSE error finish', async () => {
    const chunks = await collect(done([
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]))
    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    if (finish?.type !== 'finish') throw new Error('expected finish')
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind === 'error') {
      expect(finish.reason.failure.code).toBe('EMPTY_RESPONSE')
    }
  })

  it('throws MALFORMED_RESPONSE for a bad JSON payload', async () => {
    let code = ''
    try {
      await collect(['{not json', '[DONE]'])
    } catch (error) {
      code = (error as LlmError).failure.code
    }
    expect(code).toBe('MALFORMED_RESPONSE')
  })

  it('ends with an error finish on an in-band provider error, emitting nothing after it', async () => {
    const chunks = await collect(done([
      { choices: [{ delta: { content: 'partial' } }] },
      { error: { message: 'engine busy' } },
    ]))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'engine busy', code: 'PROVIDER_ERROR' } } },
    ])
  })

  it('throws STREAM_CLOSED when the payload source omits the DONE sentinel', async () => {
    let code = ''
    try {
      for await (const _chunk of translate((async function* () {
        yield JSON.stringify({ choices: [{ delta: { content: 'x' } }] })
      })())) {
        // drain
      }
    } catch (error) {
      code = (error as LlmError).failure.code
    }
    expect(code).toBe('STREAM_CLOSED')
  })
})
