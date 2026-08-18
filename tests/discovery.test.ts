/**
 * Model-discovery tests against an in-process mock `/models` endpoint.
 */
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import { discoverQwenModels } from '../src/discovery.js'

interface MockModels {
  url: string
  seenAuth: (string | undefined)[]
  server: Server
  close(): Promise<void>
}

/** Start an in-process mock OpenAI-compatible `/models` endpoint. */
function startModelsServer(
  respond: (res: ServerResponse, auth: string | undefined) => void,
): Promise<MockModels> {
  const seenAuth: (string | undefined)[] = []
  const server = createServer((req, res) => {
    if (req.url !== '/models') {
      res.writeHead(404).end()
      return
    }
    seenAuth.push(req.headers.authorization === undefined ? undefined : req.headers.authorization)
    respond(res, req.headers.authorization === undefined ? undefined : req.headers.authorization.slice('Bearer '.length))
  })
  const mock: MockModels = {
    url: '',
    seenAuth,
    server,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    },
  }
  return new Promise<MockModels>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      mock.url = `http://127.0.0.1:${port}`
      resolve(mock)
    })
  })
}

const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.map(s => new Promise<void>(resolve => {
    s.closeAllConnections?.()
    s.close(() => resolve())
  })))
})

function tracked(mock: MockModels): MockModels {
  servers.push(mock.server)
  return mock
}

const CATALOG: readonly LlmDiscoveredModel[] = [
  { id: 'qwen3.8', name: 'Qwen3.8 (local)', contextWindow: 262144, maxTokens: 32768 },
]

function facts(
  overrides: Partial<{
    ownModels: () => readonly LlmDiscoveredModel[]
    storedApiKey: () => Promise<string | undefined>
  }> = {},
): Parameters<typeof discoverQwenModels>[1] {
  return {
    ownModels: overrides.ownModels ?? (() => CATALOG),
    storedApiKey: overrides.storedApiKey ?? (async () => undefined),
  }
}

describe('discoverQwenModels', () => {
  it('maps a vLLM /models listing, including optional capacity fields', async () => {
    const mock = tracked(await startModelsServer(res => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        data: [
          { id: 'qwen3.8-27b', object: 'model', owned_by: 'vllm' },
          { id: 'qwen3.8-27b-fp8', object: 'model', name: 'FP8 build', context_window: 262144, max_tokens: 32768 },
          { object: 'model' },
        ],
      }))
    }))
    const models = await discoverQwenModels({ baseURL: mock.url }, facts())
    expect(models).toEqual([
      { id: 'qwen3.8-27b' },
      { id: 'qwen3.8-27b-fp8', name: 'FP8 build', contextWindow: 262144, maxTokens: 32768 },
    ])
    await mock.close()
  })

  it('trims a trailing slash and sends the draft key when the draft carries one', async () => {
    const mock = tracked(await startModelsServer((res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'm' }] }))
    }))
    const models = await discoverQwenModels(
      { baseURL: `${mock.url}/`, apiKey: 'draft-key' },
      facts({ storedApiKey: async () => {
        throw new Error('must not be consulted when the draft carries a key')
      } }),
    )
    expect(models).toEqual([{ id: 'm' }])
    expect(mock.seenAuth).toEqual(['Bearer draft-key'])
    await mock.close()
  })

  it('falls back to the stored route credential when the draft carries none, and probes unauthenticated on a miss', async () => {
    const mock = tracked(await startModelsServer((res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'm' }] }))
    }))
    await discoverQwenModels(
      { baseURL: mock.url, provider: 'qwen-local' },
      facts({ storedApiKey: async () => 'stored-key' }),
    )
    await discoverQwenModels({ baseURL: mock.url, provider: 'qwen-local' }, facts())
    expect(mock.seenAuth).toEqual(['Bearer stored-key', undefined])
    await mock.close()
  })

  it('answers from the adapter catalog when the draft names a route but no endpoint', async () => {
    const mock = tracked(await startModelsServer(() => {
      throw new Error('must not be reached')
    }))
    const models = await discoverQwenModels(
      { provider: 'qwen-local' },
      facts({ ownModels: () => [] }),
    )
    expect(models).toEqual([])
    expect(mock.seenAuth).toEqual([])
    const fromCatalog = await discoverQwenModels({ provider: 'qwen-local' }, facts())
    expect(fromCatalog).toEqual(CATALOG)
    await mock.close()
  })

  it('refuses a draft with neither endpoint nor route', async () => {
    let code = ''
    try {
      await discoverQwenModels({}, facts())
    } catch (error) {
      code = (error as LlmError).failure.code
    }
    expect(code).toBe('INVALID_REQUEST')
  })

  it('maps a rejected probe to the HTTP error code with status', async () => {
    const cases: readonly (readonly [number, string])[] = [
      [401, 'AUTH'],
      [400, 'INVALID_REQUEST'],
      [500, 'SERVER'],
    ]
    for (const [status, expected] of cases) {
      const mock = tracked(await startModelsServer(res => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'nope' } }))
      }))
      let code = ''
      let statusSeen: number | undefined
      try {
        await discoverQwenModels({ baseURL: mock.url }, facts())
      } catch (error) {
        code = (error as LlmError).failure.code
        statusSeen = (error as LlmError).failure.status
      }
      expect(code).toBe(expected)
      expect(statusSeen).toBe(status)
      await mock.close()
    }
  })

  it('treats an empty or malformed listing as no models, not a failure', async () => {
    const mock = tracked(await startModelsServer(res => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list' }))
    }))
    expect(await discoverQwenModels({ baseURL: mock.url }, facts())).toEqual([])
    await mock.close()
  })

  it('maps caller cancellation to ABORTED', async () => {
    const controller = new AbortController()
    const mock = tracked(await startModelsServer((res) => {
      controller.abort('user cancelled')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'm' }] }))
    }))
    let code = ''
    try {
      await discoverQwenModels({ baseURL: mock.url, signal: controller.signal }, facts())
    } catch (error) {
      code = error instanceof LlmError ? error.failure.code : 'NOT_LLM_ERROR'
    }
    expect(code).toBe('ABORTED')
    await mock.close()
  })
})
