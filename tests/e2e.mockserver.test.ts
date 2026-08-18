/**
 * End-to-end adapter tests against an in-process mock vLLM (OpenAI-compatible
 * SSE). No real model or endpoint is required.
 */
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { QwenLocalAdapter } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import type { Config, QwenLocalOptions } from '../src/config.js'

interface RecordedRequest {
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

interface MockVllm {
  url: string
  requests: RecordedRequest[]
  server: Server
  close(): Promise<void>
}

/** Start an in-process mock vLLM whose behavior each test programs. */
function startMockVllm(
  handler: (res: ServerResponse, body: Record<string, unknown>, mock: MockVllm) => void,
): Promise<MockVllm> {
  const requests: RecordedRequest[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      requests.push({ headers: req.headers, body })
      handler(res, body, mock)
    })
  })
  const mock: MockVllm = {
    url: '',
    requests,
    server,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    },
  }
  return new Promise<MockVllm>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      mock.url = `http://127.0.0.1:${port}/v1`
      resolve(mock)
    })
  })
}

/** Write one SSE frame. */
function frame(res: ServerResponse, payload: object | string): void {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
}

const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.map(s => new Promise<void>(resolve => {
    s.closeAllConnections?.()
    s.close(() => resolve())
  })))
})

function tracked(mock: MockVllm): MockVllm {
  servers.push(mock.server)
  return mock
}

function options(partial: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'qwen-local',
    model: 'qwen3.8',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    ...partial,
  }
}

const BASE_CONFIG: Config = {
  baseURL: 'http://127.0.0.1:0/v1',
  apiKeyEnv: undefined,
  models: [{
    // Qwen3.8-27B: native vision-language model, thinking on by default,
    // official effort levels xhigh (default) / medium / low.
    id: 'qwen3.8',
    multimodal: true,
    reasoning: {
      efforts: [
        { id: 'off', wire: null },
        { id: 'low', wire: 'low' },
        { id: 'medium', wire: 'medium' },
        { id: 'xhigh', wire: 'xhigh' },
      ],
      defaultEffort: 'xhigh',
      offMode: 'chat-template-kwargs',
    },
  }],
  defaultContextWindow: 32768,
  maxTokens: 4096,
  streamIdleTimeoutMs: 60_000,
}

function adapterFor(config: Config, resolveAttachments?: () => AttachmentStore | undefined): QwenLocalAdapter {
  const connection: QwenLocalOptions = resolveConfig(config)
  return new QwenLocalAdapter({ options: () => connection, ...resolveAttachments === undefined ? {} : { resolveAttachments } })
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('QwenLocalAdapter e2e (mock vLLM)', () => {
  it('streams reasoning + text with usage and stop, and sends the configured wire request', async () => {
    const mock = tracked(await startMockVllm((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(res, { choices: [{ delta: { role: 'assistant', reasoning_content: 'thinking' } }] })
      frame(res, { choices: [{ delta: { content: 'Hello' } }] })
      frame(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } })
      frame(res, '[DONE]')
      res.end()
    }))
    const adapter = adapterFor({ ...BASE_CONFIG, baseURL: mock.url })
    const chunks = await drain(adapter.stream(options({ reasoningEffort: ReasoningEffortId('low') })))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Hello' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])

    expect(mock.requests).toHaveLength(1)
    const request = mock.requests[0]
    if (request === undefined) throw new Error('no request recorded')
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.headers['accept']).toBe('text/event-stream')
    expect(String(request.headers['user-agent'])).toMatch(/^deepseek-harness\//)
    expect(request.headers['authorization']).toBeUndefined()
    expect(request.body).toMatchObject({
      model: 'qwen3.8',
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'low',
    })
    expect(request.body).not.toHaveProperty('chat_template_kwargs')
    expect(request.body).not.toHaveProperty('max_tokens')
    expect(request.body.messages).toEqual([{ role: 'user', content: 'hello' }])
    await mock.close()
  })

  it('resolves a named credential through the plugin resolver (the credentials-service path)', async () => {
    const mock = tracked(await startMockVllm((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(res, { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })
      frame(res, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })
      frame(res, '[DONE]')
      res.end()
    }))
    const connection = resolveConfig({
      ...BASE_CONFIG,
      baseURL: mock.url,
      apiKeyEnv: 'QWEN_LOCAL_API_KEY',
    })
    const seen: string[] = []
    const adapter = new QwenLocalAdapter({
      options: () => connection,
      resolveApiKey: async (ref) => {
        seen.push(ref)
        return 'stored-key-456'
      },
    })
    await drain(adapter.stream(options()))
    expect(seen).toEqual(['QWEN_LOCAL_API_KEY'])
    expect(mock.requests[0]?.headers['authorization']).toBe('Bearer stored-key-456')
    await mock.close()
  })

  it('fails loud with MISSING_CREDENTIAL before any network I/O when the resolver misses', async () => {
    const denied = tracked(await startMockVllm(() => {
      throw new Error('must not be reached')
    }))
    const connection = resolveConfig({
      ...BASE_CONFIG,
      baseURL: denied.url,
      apiKeyEnv: 'QWEN_LOCAL_API_KEY',
    })
    const adapter = new QwenLocalAdapter({
      options: () => connection,
      resolveApiKey: async () => {
        throw new LlmError('no API key for QWEN_LOCAL_API_KEY', 'MISSING_CREDENTIAL')
      },
    })
    let code = ''
    try {
      await drain(adapter.stream(options()))
    } catch (error) {
      code = error instanceof LlmError ? error.failure.code : 'NOT_LLM_ERROR'
    }
    expect(code).toBe('MISSING_CREDENTIAL')
    expect(denied.requests).toEqual([])
    await denied.close()
  })

  it('materializes the default effort and sends the bearer key from the named env', async () => {
    process.env.QWEN_TEST_KEY = 'test-key-123'
    try {
      const mock = tracked(await startMockVllm((res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        frame(res, { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })
        frame(res, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })
        frame(res, '[DONE]')
        res.end()
      }))
      const adapter = adapterFor({
        ...BASE_CONFIG,
        baseURL: mock.url,
        apiKeyEnv: 'QWEN_TEST_KEY',
      })
      const chunks = await drain(adapter.stream(options()))
      const finish = chunks.at(-1)
      expect(finish).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(mock.requests[0]?.body).toMatchObject({ reasoning_effort: 'xhigh' })
      expect(mock.requests[0]?.headers['authorization']).toBe('Bearer test-key-123')
      await mock.close()
    } finally {
      delete process.env.QWEN_TEST_KEY
    }
  })

  it('maps a 400 error body to INVALID_REQUEST with status', async () => {
    const mock = tracked(await startMockVllm((res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'max_tokens out of range', type: 'invalid_request_error' } }))
    }))
    const adapter = adapterFor({ ...BASE_CONFIG, baseURL: mock.url })
    let code = ''
    let status
    try {
      await drain(adapter.stream(options()))
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError)
      code = (error as LlmError).failure.code
      status = (error as LlmError).failure.status
    }
    expect(code).toBe('INVALID_REQUEST')
    expect(status).toBe(400)
    await mock.close()
  })

  it('ends with a PROVIDER_ERROR finish on an in-band error payload', async () => {
    const mock = tracked(await startMockVllm((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(res, { choices: [{ delta: { content: 'partial' } }] })
      frame(res, { error: { message: 'engine busy' } })
      frame(res, '[DONE]')
      res.end()
    }))
    const adapter = adapterFor({ ...BASE_CONFIG, baseURL: mock.url })
    const chunks = await drain(adapter.stream(options()))
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'engine busy', code: 'PROVIDER_ERROR' } },
    })
    await mock.close()
  })

  it('surfaces a caller abort as ABORTED', async () => {
    const mock = tracked(await startMockVllm((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(res, { choices: [{ delta: { content: 'first' } }] })
      // Stay open: no further frames, no end.
    }))
    const controller = new AbortController()
    const adapter = adapterFor({ ...BASE_CONFIG, baseURL: mock.url })
    const stream = adapter.stream(options({ signal: controller.signal }))
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value?.type).toBe('block-start')
    controller.abort()
    let code = ''
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) await iterator.next()
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError)
      code = (error as LlmError).failure.code
    }
    expect(code).toBe('ABORTED')
    await mock.close()
  })

  it('times out an idle stream with TIMEOUT', async () => {
    const mock = tracked(await startMockVllm((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(res, { choices: [{ delta: { content: 'first' } }] })
      // Then silence: no frames until the watchdog fires.
    }))
    const adapter = adapterFor({
      ...BASE_CONFIG,
      baseURL: mock.url,
      streamIdleTimeoutMs: 150,
    })
    const stream = adapter.stream(options())
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value?.type).toBe('block-start')
    let code = ''
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) await iterator.next()
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError)
      code = (error as LlmError).failure.code
    }
    expect(code).toBe('TIMEOUT')
    await mock.close()
  })

  it('sends image data URLs for a multimodal model and refuses them for a text-only one', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const calls: ImageAttachmentRef[] = []
    const store = {
      readImage: async (ref: ImageAttachmentRef) => {
        calls.push(ref)
        return { ref, data: bytes }
      },
    } as unknown as AttachmentStore
    const imageMessage = createUserMessage({
      content: [
        { type: 'text', text: 'describe' },
        {
          type: 'image',
          attachment: {
            attachmentId: AttachmentId('att-1'),
            mediaType: 'image/png' as ImageMediaType,
            bytes: 3,
            width: 1,
            height: 1,
          },
        },
      ],
      source: { kind: 'user' },
    })

    // multimodal: true → data URL on the wire
    const mock = tracked(await startMockVllm((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(res, { choices: [{ delta: { content: 'a red dot' }, finish_reason: 'stop' }] })
      frame(res, { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2 } })
      frame(res, '[DONE]')
      res.end()
    }))
    const visionConfig = {
      ...BASE_CONFIG,
      baseURL: mock.url,
      models: [{ id: 'qwen3.8-vl', multimodal: true }],
    }
    const adapter = adapterFor(visionConfig, () => store)
    await drain(adapter.stream(options({ model: 'qwen3.8-vl', messages: [imageMessage] })))
    const content = (mock.requests[0]?.body.messages as unknown[] | undefined)?.[0]
    expect(content).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      ],
    })
    expect(calls).toHaveLength(1)
    await mock.close()

    // multimodal: false → refused before any network I/O
    const denied = tracked(await startMockVllm(() => {
      throw new Error('must not be reached')
    }))
    const textAdapter = adapterFor({
      ...BASE_CONFIG,
      baseURL: denied.url,
      models: [{ id: 'qwen3.8', multimodal: false }],
    }, () => store)
    let code = ''
    try {
      await drain(textAdapter.stream(options({ messages: [imageMessage] })))
    } catch (error) {
      code = (error as LlmError).failure.code
    }
    expect(code).toBe('UNSUPPORTED_CONTENT')
    expect(denied.requests).toHaveLength(0)
    await denied.close()
  })

  it('replays tool calls and tool results across a full round trip', async () => {
    const mock = tracked(await startMockVllm((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(res, {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'call-9', type: 'function', function: { name: 'bash', arguments: '{"command":"echo hi"}' } }],
          },
        }],
      })
      frame(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
      frame(res, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 4 } })
      frame(res, '[DONE]')
      res.end()
    }))
    const adapter = adapterFor({ ...BASE_CONFIG, baseURL: mock.url })
    const assistantMessage = createAssistantMessage({
      content: [{
        type: 'tool-call',
        id: CallId('call-1'),
        name: 'bash',
        arguments: '{"command":"ls"}',
      }],
      source: { provider: 'qwen-local', model: 'qwen3.8' },
    })
    const result = createToolResultMessage({
      callId: CallId('call-1'),
      content: [{ type: 'text', text: 'file.txt' }],
      isError: false,
    })
    const chunks = await drain(adapter.stream(options({ messages: [assistantMessage, result] })))
    expect(chunks).toContainEqual({
      type: 'tool-call-delta',
      index: 0,
      id: 'call-9',
      name: 'bash',
      argumentsDelta: '{"command":"echo hi"}',
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(mock.requests[0]?.body.messages).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'file.txt' },
    ])
    await mock.close()
  })
})
