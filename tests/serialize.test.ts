import { describe, expect, it } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { serializeRequest } from '../src/serialize.js'
import type { QwenLocalModel, QwenLocalReasoningEffort } from '../src/config.js'

const MODEL_TEXT: QwenLocalModel = { id: 'qwen3.8', multimodal: false }
const MODEL_VISION: QwenLocalModel = { id: 'qwen3.8-vl', multimodal: true }

const REASONING_EFFORTS: QwenLocalReasoningEffort[] = [
  { id: 'off', wire: null },
  { id: 'low', name: 'Low', wire: 'low' },
  { id: 'high', wire: 'high' },
]

const REASONING_MODEL: QwenLocalModel = {
  id: 'qwen3.8',
  multimodal: false,
  reasoning: {
    efforts: REASONING_EFFORTS,
    defaultEffort: 'high',
    offMode: 'chat-template-kwargs',
  },
}

function options(partial: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'qwen-local',
    model: 'qwen3.8',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    ...partial,
  }
}

interface FakeStore {
  readImage: (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>
  calls: ImageAttachmentRef[]
}

function fakeStore(bytes = new Uint8Array([1, 2, 3]), mediaType: ImageMediaType = 'image/png'): FakeStore {
  const calls: ImageAttachmentRef[] = []
  return {
    calls,
    readImage: async (ref) => {
      calls.push(ref)
      return { ref, data: bytes }
    },
  }
}

function imageMessage(): Message {
  return createUserMessage({
    content: [
      { type: 'text', text: 'what is in this image?' },
      {
        type: 'image',
        attachment: {
          attachmentId: AttachmentId('att-1'),
          mediaType: 'image/png',
          bytes: 3,
          width: 1,
          height: 1,
        },
      },
    ],
    source: { kind: 'user' },
  })
}

describe('serializeRequest: messages', () => {
  it('serializes system + user text', async () => {
    const body = await serializeRequest(
      options({ system: 'be brief', model: 'qwen3.8' }),
      MODEL_TEXT,
      undefined,
    )
    expect(body.model).toBe('qwen3.8')
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
    ])
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('replays assistant tool calls with raw JSON arguments and empty content', async () => {
    const assistant = createAssistantMessage({
      content: [{
        type: 'tool-call',
        id: CallId('call-1'),
        name: 'bash',
        arguments: '{"command":"ls"}',
      }],
      source: { provider: 'qwen-local', model: 'qwen3.8' },
    })
    const body = await serializeRequest(options({ messages: [assistant] }), MODEL_TEXT, undefined)
    expect(body.messages).toEqual([{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"ls"}' },
      }],
    }])
  })

  it('replays assistant reasoning as reasoning_content with preserve_thinking at its default (on)', async () => {
    const assistant = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'thinking hard' },
        { type: 'text', text: 'answer' },
      ],
      source: { provider: 'qwen-local', model: 'qwen3.8' },
    })
    const body = await serializeRequest(options({ messages: [assistant] }), MODEL_TEXT, undefined)
    expect(body.messages).toEqual([{
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'thinking hard',
    }])
  })

  it('does not replay reasoning on tool-call turns (the official Qwen3.8 example shape)', async () => {
    const assistant = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'plan the command' },
        {
          type: 'tool-call',
          id: CallId('call-1'),
          name: 'bash',
          arguments: '{"command":"ls"}',
        },
      ],
      source: { provider: 'qwen-local', model: 'qwen3.8' },
    })
    const body = await serializeRequest(options({ messages: [assistant] }), MODEL_TEXT, undefined)
    expect(body.messages).toEqual([{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"ls"}' },
      }],
    }])
    expect(body.messages[0]).not.toHaveProperty('reasoning_content')
  })

  it('stops replaying reasoning and sends preserve_thinking: false for a preserveThinking: false model', async () => {
    const assistant = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'thinking hard' },
        { type: 'text', text: 'answer' },
      ],
      source: { provider: 'qwen-local', model: 'qwen3.8' },
    })
    const body = await serializeRequest(
      options({ messages: [assistant] }),
      { id: 'qwen3.8', multimodal: false, preserveThinking: false },
      undefined,
    )
    expect(body.messages).toEqual([{ role: 'assistant', content: 'answer' }])
    expect(body.chat_template_kwargs).toEqual({ preserve_thinking: false })
  })

  it('expands tool results into role:tool messages with placeholder for empty output', async () => {
    const filled = createToolResultMessage({
      callId: CallId('call-1'),
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })
    const empty = createToolResultMessage({
      callId: CallId('call-2'),
      content: [],
      isError: true,
    })
    const body = await serializeRequest(options({ messages: [filled, empty] }), MODEL_TEXT, undefined)
    expect(body.messages).toEqual([
      { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
      { role: 'tool', tool_call_id: 'call-2', content: '(no output)' },
    ])
  })

  it('refuses an image inside a tool result', async () => {
    const result = createToolResultMessage({
      callId: CallId('call-1'),
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId('att-2'),
          mediaType: 'image/png',
          bytes: 3,
          width: 1,
          height: 1,
        },
      }],
      isError: false,
    })
    await expect(serializeRequest(options({ messages: [result] }), MODEL_TEXT, undefined))
      .rejects.toThrow(LlmError)
    try {
      await serializeRequest(options({ messages: [result] }), MODEL_TEXT, undefined)
    } catch (error) {
      expect((error as LlmError).failure.code).toBe('UNSUPPORTED_CONTENT')
    }
  })
})

describe('serializeRequest: multimodal gate', () => {
  it('serializes image parts as data URLs for a multimodal model', async () => {
    const store = fakeStore()
    const body = await serializeRequest(
      options({ model: 'qwen3.8-vl', messages: [imageMessage()] }),
      MODEL_VISION,
      store as unknown as AttachmentStore,
    )
    const message = body.messages[0]
    if (message === undefined) throw new Error('expected a user message')
    expect(message.role).toBe('user')
    if (message.role !== 'user' || typeof message.content === 'string') {
      throw new Error('expected a multimodal user message')
    }
    expect(message.content).toEqual([
      { type: 'text', text: 'what is in this image?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ])
    expect(store.calls).toHaveLength(1)
    expect(store.calls[0]?.attachmentId).toBe(AttachmentId('att-1'))
  })

  it('refuses an image for a text-only model, naming the model', async () => {
    let code = ''
    try {
      await serializeRequest(options({ messages: [imageMessage()] }), MODEL_TEXT, fakeStore() as unknown as AttachmentStore)
    } catch (error) {
      code = (error as LlmError).failure.code
      expect((error as Error).message).toContain('qwen3.8')
    }
    expect(code).toBe('UNSUPPORTED_CONTENT')
  })

  it('refuses an image when the attachment service is absent', async () => {
    let code = ''
    try {
      await serializeRequest(
        options({ model: 'qwen3.8-vl', messages: [imageMessage()] }),
        MODEL_VISION,
        undefined,
      )
    } catch (error) {
      code = (error as LlmError).failure.code
    }
    expect(code).toBe('UNSUPPORTED_CONTENT')
  })
})

describe('serializeRequest: reasoning effort mapping', () => {
  it('sends the wire spelling of the selected effort', async () => {
    const body = await serializeRequest(
      options({ reasoningEffort: ReasoningEffortId('low') }),
      REASONING_MODEL,
      undefined,
    )
    expect(body.reasoning_effort).toBe('low')
    expect(body.chat_template_kwargs).toBeUndefined()
  })

  it('materializes defaultEffort when the request omits an effort', async () => {
    const body = await serializeRequest(options(), REASONING_MODEL, undefined)
    expect(body.reasoning_effort).toBe('high')
  })

  it('expresses off as none plus enable_thinking false by default', async () => {
    const body = await serializeRequest(
      options({ reasoningEffort: ReasoningEffortId('off') }),
      REASONING_MODEL,
      undefined,
    )
    // `none` is vLLM's canonical no-thinking effort spelling (verified
    // against a live Qwen3.8 build; `off` itself is a 400); the kwarg
    // additionally stops the template from generating thinking.
    expect(body.reasoning_effort).toBe('none')
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('expresses off as none only when offMode is omit', async () => {
    const model: QwenLocalModel = {
      id: 'qwen3.8',
      multimodal: false,
      reasoning: { efforts: REASONING_EFFORTS, offMode: 'omit' },
    }
    const body = await serializeRequest(
      options({ reasoningEffort: ReasoningEffortId('off') }),
      model,
      undefined,
    )
    expect(body.reasoning_effort).toBe('none')
    expect(body.chat_template_kwargs).toBeUndefined()
  })

  it('sends nothing when no effort is selected and no default is configured', async () => {
    const model: QwenLocalModel = {
      id: 'qwen3.8',
      multimodal: false,
      reasoning: {
        efforts: [
          { id: 'off', wire: null },
          { id: 'high', wire: 'high' },
        ],
        offMode: 'chat-template-kwargs',
      },
    }
    const body = await serializeRequest(options(), model, undefined)
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.chat_template_kwargs).toBeUndefined()
  })

  it('rejects an effort the model does not declare', async () => {
    let code = ''
    try {
      await serializeRequest(
        options({ reasoningEffort: ReasoningEffortId('max') }),
        REASONING_MODEL,
        undefined,
      )
    } catch (error) {
      code = (error as LlmError).failure.code
    }
    expect(code).toBe('UNSUPPORTED_REASONING_EFFORT')
  })

  it('rejects an effort request against a model with no reasoning capability', async () => {
    let code = ''
    try {
      await serializeRequest(
        options({ reasoningEffort: ReasoningEffortId('high') }),
        MODEL_TEXT,
        undefined,
      )
    } catch (error) {
      code = (error as LlmError).failure.code
    }
    expect(code).toBe('UNSUPPORTED_REASONING_EFFORT')
  })

  it('merges enable_thinking and preserve_thinking kwargs when both deviate from defaults', async () => {
    const model: QwenLocalModel = {
      id: 'qwen3.8',
      multimodal: false,
      preserveThinking: false,
      reasoning: {
        efforts: REASONING_EFFORTS,
        offMode: 'chat-template-kwargs',
      },
    }
    const body = await serializeRequest(
      options({ reasoningEffort: ReasoningEffortId('off') }),
      model,
      undefined,
    )
    expect(body.reasoning_effort).toBe('none')
    expect(body.chat_template_kwargs).toEqual({
      enable_thinking: false,
      preserve_thinking: false,
    })
  })

  it('forces session-title auxiliary calls to off when the model declares it', async () => {
    const body = await serializeRequest(
      options({ purpose: 'session-title' }),
      REASONING_MODEL,
      undefined,
    )
    expect(body.reasoning_effort).toBe('none')
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('leaves session-title calls at the ordinary default when the model declares no off level', async () => {
    const noOff: QwenLocalModel = {
      id: 'qwen3.8',
      multimodal: false,
      reasoning: {
        efforts: [
          { id: 'low', wire: 'low' },
          { id: 'xhigh', wire: 'xhigh' },
        ],
        defaultEffort: 'xhigh',
        offMode: 'chat-template-kwargs',
      },
    }
    const body = await serializeRequest(options({ purpose: 'session-title' }), noOff, undefined)
    expect(body.reasoning_effort).toBe('xhigh')
    expect(body.chat_template_kwargs).toBeUndefined()
  })

  it('defensively refuses an explicit off request against a model with no off level', async () => {
    const noOff: QwenLocalModel = {
      id: 'qwen3.8',
      multimodal: false,
      reasoning: {
        efforts: [{ id: 'xhigh', wire: 'xhigh' }],
        offMode: 'chat-template-kwargs',
      },
    }
    let code = ''
    try {
      await serializeRequest(options({ reasoningEffort: ReasoningEffortId('off') }), noOff, undefined)
    } catch (error) {
      code = (error as LlmError).failure.code
    }
    expect(code).toBe('UNSUPPORTED_REASONING_EFFORT')
  })
})

describe('serializeRequest: pass-through fields', () => {
  it('maps tools, temperature, maxTokens, and stop', async () => {
    const body = await serializeRequest(
      options({
        tools: [{
          name: 'bash',
          description: 'run a command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        }],
        temperature: 0.2,
        maxTokens: 1234,
        stop: ['\n\n'],
      }),
      MODEL_TEXT,
      undefined,
    )
    expect(body.tools).toEqual([{
      type: 'function',
      function: {
        name: 'bash',
        description: 'run a command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    }])
    expect(body.temperature).toBe(0.2)
    expect(body.max_tokens).toBe(1234)
    expect(body.stop).toEqual(['\n\n'])
  })

  it('omits optional fields rather than sending null', async () => {
    const body = await serializeRequest(options(), MODEL_TEXT, undefined)
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('stop')
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('chat_template_kwargs')
  })
})
