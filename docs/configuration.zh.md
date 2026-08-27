# 配置参考

[← 返回 README](../README.zh.md) · [设计思路](design.zh.md)

`dsh-llm-qwen-local` 的每个配置字段。配置位于 `llm-qwen-local` 设置节(可在 **设置 → Qwen 本地 (vLLM)** 页面编辑,或在 `cordis.patch.yml` 中按 `id: llm-qwen-local` 覆盖)。

## 路由级字段

除 `models` 外,所有字段在 `cordis.yml` 中都是可选的;其余由 schema 默认值填充。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8000/v1` | 端点基址;自动追加 `/chat/completions`。 |
| `apiKeyEnv` | —(不发送认证头) | 持有可选 bearer token 的环境变量名,每请求读取。缺省/未设置/空白 = 不发送 `Authorization` 头。 |
| `models` | **必填** | 至少一个模型条目。 |
| `defaultContextWindow` | `262144` | 模型没有精确值时使用的上下文容量。 |
| `maxTokens` | `32768` | 每请求输出上限的兜底值;请求显式值与模型自身上限优先。 |
| `streamIdleTimeoutMs` | `300000` | 一次流读取挂起期间允许的最大提供方空闲时间。 |
| `maxRequestImageBytes` | —(保留全部图像) | 每请求内联 base64 图像载荷总量上限;超出时序列化前**最旧**的图像被确定性的文本占位符替换(harness 的 `offloadRequestImages` 策略),使历史繁重的视觉请求仍适配端点的输入上限。 |

## 模型条目

| 字段 | 默认值 | 含义 |
|---|---|---|
| `id` | **必填** | vLLM 接受的 wire 模型 id。 |
| `name` | `id` | 选择器标签。 |
| `description` | — | 相似变体间的选择器说明。 |
| `contextWindow` | 路由默认值 | 该模型请求/响应合计容量。 |
| `maxTokens` | 路由默认值 | 该模型每请求输出上限。 |
| `multimodal` | `false` | 视觉开关(见下节)。Qwen3.8-27B 是原生视觉语言模型——为它设置 `true`。 |
| `preserveThinking` | `true` | 部署是否保留历史思考块(Qwen3.8 的 `preserve_thinking`,模板默认开)。`false` 会发送 `chat_template_kwargs: { preserve_thinking: false }`,且适配器不再把助手推理回放进历史。 |
| `imageMaxPixels` | `640000` | 请求图像像素预算(宽 × 高,等比投影后)——与官方适配器共享的 harness 规范默认值。对细节敏感的视觉任务可调高;留空 = 默认。 |
| `imageMaxBytes` | `1048576` | base64 内联前每张请求图像的编码字节上限。 |
| `reasoning` | — | 推理能力;缺省 = 该模型不暴露可选档位。 |

## 多模态开关

`multimodal` 是**关于你端点的声明,而非对端点的检查**——没有任何东西去询问 vLLM 接受什么。自 0.1.1-rc.2 harness 升级起,harness 的 LLM 运行时自己处理"低报"的情形:

- `false`(默认):模型以纯文本公告(`inputModalities: ['text']`)。harness 运行时现在会把图像**投影**为确定性的文本占位符(`[image omitted because this model accepts text only; attachment sha256:…]`),发生在**适配器看到之前**——请求以纯文本继续,而不是被拒绝。适配器在序列化时仍保留自己的 `UNSUPPORTED_CONTENT` 门禁,覆盖直接使用(非运行时)与运行时投影之外组装的历史。
- `true`:模型以 `['text', 'image']` 公告。图像字节通过持久附件服务(`ctx.attachments`)解析;没有该服务的组合会对任何图像以 `UNSUPPORTED_CONTENT` 拒绝,而不是猜测来源。**工具返回的图像会被拆分而非拒绝**(见[设计思路](design.zh.md#工具结果内的图像拆分而非拒绝031)):wire 强制的严格 OpenAI 摆位是 `image_url` 部件只能搭乘 `user` 消息,所以含图像部件的工具结果序列化为纯文本的 `role: 'tool'` 消息,紧跟一条携带说明文字与图像部件的 `role: 'user'` 多模态消息(QwenLM `qwen-code` 的 `splitToolMedia` 形态)。

两种声明错误的代价不同:**高报**会接受一张提供方随后**在回合中途**拒绝的图像——此时消息已持久化进会话日志——该会话会反复重发这张失败的图像。恢复途径是新建会话、在图像之前分叉、或换一个模型;把未被消费的图像消息从失败的发送中回滚是推迟事项。**低报**不再大声失败:图像静默变成上面的占位符——模型仍然作答,但看不到图像(恢复:拨动开关后重新提问)。绕过运行时投影的调用方仍会触发直接适配器门禁(`UNSUPPORTED_CONTENT`,并指明模型名)。

图像字节以内联的 `image_url` 部件承载,值为 `data:<mediaType>;base64,…`;可用时经附件服务的请求图像管线投影(`readImageRequest`;harness 规范策略:最多 `imageMaxPixels` 像素、`imageMaxBytes` 编码字节、按变体缓存),对以 `ATTACHMENT_PROJECTION_UNSUPPORTED` 拒绝投影的提供方回退到归一化主字节(`readImage`)。

## 推理档位

```yaml
reasoning:
  efforts:
    - { id: off, wire: none }      # vLLM 规范的"无思考"拼写
    - { id: low, wire: low }       # 你的 vLLM 接受的任意 wire 拼写
    - { id: high, wire: high }
  defaultEffort: high              # 可选;缺省 = 跟随 vLLM 自身默认
  offMode: chat-template-kwargs    # 可选;'chat-template-kwargs' | 'omit'
```

- **Qwen3.8-27B 的官方档位**:`xhigh`(模型默认)、`medium`、`low`——bundle 基线恰好声明这些外加 `off`。vLLM 接受的 `reasoning_effort` 词汇表是 `none` / `minimal` / `low` / `medium` / `high` / `xhigh`;`off` 作为 wire 值会返回 400,所以 `off` 映射到 `wire: none`(已在真实 Qwen3.8 vLLM 构建上验证)。思考默认开启,所以完全不发送该参数(不设 `defaultEffort`,或无档位时 `offMode: omit`)保持部署的思考默认。
- `efforts`(必填,按显示顺序)——权威的可选列表。每个 `id` 是 harness 随请求携带的不透明值;`name`(默认 `id`)是选择器展示的内容。未声明的档位不会被提供。`id` 在单个模型内唯一。`off` 档位是**可选**的:它是适配器自己的"无思考"选择器。对于无法关闭思考的部署,省略它——那时档位选择永远无法关闭思考,`session-title` 调用也保持普通默认,而不是强制 `off`。
- `wire`——作为 `reasoning_effort` 发送的确切拼写。`off` 约定用 `none`,且是唯一允许 `null` 的档位(不发送任何东西——参数出现前的逃生口;offMode 的 kwargs 仍承载该表达);其余档位必须命名非空 wire 值。可自由改名(`{ id: max, wire: high }`)——harness 从不接触 wire 拼写。
- `defaultEffort`——调用方省略档位时物化进请求。缺省保持 vLLM 自身默认。
- `offMode`——`off` 的模板侧表达,与其 wire 值一同发送:
  - `chat-template-kwargs`(默认):额外发送 `chat_template_kwargs: { enable_thinking: false }`——模型文档化的非思考模式(思考默认开启,所以仅靠档位值留模板门禁开着;该 kwarg 才是把它关掉的那把锁)。
  - `omit`:不额外发送——用于 `none` 单独即意味着无思考的部署。
- 每请求选择优先于 `defaultEffort`。请求命名了模型未声明的档位时,在任何网络 I/O 之前以 `UNSUPPORTED_REASONING_EFFORT` 失败——绝不钳制。
- `session-title` 辅助调用被强制为 `off`:短标题永远不需要思考。
