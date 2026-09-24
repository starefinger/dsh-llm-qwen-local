# 设计思路与实现细节

[← 返回 README](../README.zh.md) · [配置参考](configuration.zh.md)

`dsh-llm-qwen-local` 的设计依据与实现细节。面向用户的安装与配置指引在 [README](../README.zh.md),每个配置字段的完整说明在[配置参考](configuration.zh.md)。

## 设计要点

### 按模型的多模态开关

`multimodal` 是**关于你端点的声明,而非对端点的检查**——没有任何东西去询问 vLLM 接受什么。语义细节(包括高报与低报代价的不对称性)见[配置参考](configuration.zh.md#多模态开关)。

### 完全可配置的推理档位

所有可选档位、其显示名、`reasoning_effort` 的 wire 拼写、默认档位,以及 `off` 在 wire 上的表达方式,全部来自配置,可匹配你的 vLLM 构建接受的任意词汇表。细节见[配置参考](configuration.zh.md#推理档位)。

### 单世代调用绑定(one-generation call binding)

自 0.1.1-rc.2 harness 升级起,适配器覆写 `LlmAdapter.prepareCall`,一次性快照连接事实(端点、目录、预算),并把模型元数据与最终派发都绑定到该快照,使 prepare 与 dispatch 之间落地的设置提交永远不会混入两代配置。

### 请求图像管线(request-image pipeline)

当挂载的附件服务提供方实现了 `readImageRequest` 时,图像字节经由其投影(确定性像素/字节预算、变体缓存)处理;对以 `ATTACHMENT_PROJECTION_UNSUPPORTED` 拒绝投影的提供方,回退到归一化主字节(`readImage`)。

### 工具结果内的图像:拆分而非拒绝(0.3.1)

wire 强制的严格 OpenAI 摆位是 `image_url` 部件只能搭乘 `user` 消息——`role: 'tool'` 内容为纯文本。所以对多模态模型,含图像部件的工具结果序列化为纯文本的 `role: 'tool'` 消息(工具的文本在拆分后保留;纯图像结果会附带简短说明),紧跟一条携带说明文字与图像部件(按工具结果顺序)的 `role: 'user'` 多模态消息——即 QwenLM `qwen-code` 的 `splitToolMedia` 形状。这同时**解毒了历史**:旧版本插件曾永久拒绝的会话日志,现在能干净序列化。纯文本模型仍对工具结果内的图像以 `UNSUPPORTED_CONTENT` 拒绝(直接适配器防御;运行时会先把此类图像投影为占位符)。

## Wire 方言(vLLM + Qwen3.8)

请求:`model`、`messages`(system 在前;多模态用户消息为 `text` / `image_url` data-URL 部件组成的 `content` 部件数组;工具结果为 `role: 'tool'`)、`tools`、`stream: true`、`stream_options: { include_usage: true }`,以及在偏离模板默认时附带 `reasoning_effort` 与 `chat_template_kwargs`、设置时附带 `temperature`、`max_tokens`、`stop`。

响应:SSE `data:` 载荷,以 `data: [DONE]` 哨兵结尾。`delta.reasoning_content`(以及部分框架发出的 `delta.reasoning` 拼写)→ harness `reasoning` 块(Qwen 思考通道);`delta.content` → `text` 块;`delta.tool_calls` → `tool-call` 块,`argumentsDelta` 为原始 JSON。`finish_reason`:`stop`/`content_filter` → `stop`,`length` → `max-tokens`,`tool_calls` → `tool-calls`,其余 → `error` finish。usage 附着在 finish 块上和/或以末尾单独的 usage-only 块到达;两者都被缓冲,在所有 `block-end` 之后、`finish` 之前冲刷(`finish` 之后不发射任何东西)。

历史回放:`preserve_thinking` 处于模板默认(开)时,助手推理在无工具调用的回合以 `reasoning_content` 回放——正是官方 Qwen3.8 示例所做的那种重构;含工具调用的回合与 `preserveThinking: false` 的模型不发送推理。工具调用以 `tool_calls` 回放,`content: ""`(绝不 `null`)。工具结果序列化为纯文本的 `role: 'tool'` 消息;对多模态模型,工具结果内的图像部件被拆到紧随其后的 `role: 'user'` 多模态消息(说明文字 + `image_url` 部件)。

## 模型参数(Qwen3.8-27B,对照模型卡片核实)

| 事实 | 值 | 在本插件中的落点 |
|---|---|---|
| 架构 | `Qwen3_5ForConditionalGeneration`——**原生视觉语言模型**(图像 + 视频) | 基线 `multimodal: true` |
| 上下文长度 | **原生 262,144**,经 YaRN / `--max-model-len` 可扩展至约 1M | `DEFAULT_CONTEXT_WINDOW = 262144`;vLLM 跑 1M 时按模型调高 `contextWindow` |
| 思考默认 | **开启**;每请求以 `chat_template_kwargs: { enable_thinking: false }` 关闭 | `off` 档位(wire `none`)+ `offMode: chat-template-kwargs`(默认) |
| `reasoning_effort` 档位 | **`xhigh`(默认)、`medium`、`low`**(vLLM 接受 `none` / `minimal` / `low` / `medium` / `high` / `xhigh`;`off` 会 400) | 基线 `efforts`(`off` → `wire: none`)+ `defaultEffort: xhigh` |
| `preserve_thinking` | **默认开启**;保留历史思考块 | 推理以 `reasoning_content` 回放;`preserveThinking: false` 发送该 kwarg |
| 推荐采样 | 思考:`temperature=1.0, top_p=0.95, top_k=20`;非思考:`temperature=0.7, top_p=0.8, top_k=20, presence_penalty=1.5` | harness 仅能暴露 `temperature`;其余跟随部署默认(vLLM 的生成默认与思考组一致) |
| 推荐输出预算 | 1M 上下文下若可拆分:推理 262,144 / 最终 131,072 | 按模型 / 按请求的 `maxTokens` |
| 图像 | `image_url` 部件(URL 或 data URL) | `multimodal: true` 路径(data URL 内联) |
| 视频 | `video_url` 部件 | 不支持——harness 没有视频内容块 |

## 框架兼容性

适配器发送或读取的每个 wire 字段及其来源:

| 字段 | 来源 | vLLM | SGLang | llama.cpp / Ollama |
|---|---|---|---|---|
| `model`/`messages`/`stream`/`stream_options` | OpenAI 标准 | 是 | 是 | 是 |
| `temperature`/`max_tokens`/`stop` | OpenAI 标准 | 是 | 是 | 是 |
| `tools`/`tool_calls` | OpenAI 标准 | 是 | 是 | 是 |
| `image_url`(data URL,请求投影) | OpenAI 标准 | 是 | 是 | VL 构建 |
| `reasoning_effort` | OpenAI 系,Qwen 文档化 | 是 | 是 | 否(忽略或 400) |
| `chat_template_kwargs` | **vLLM 扩展** | 是 | 是 | 否 |
| `delta.reasoning_content`(+ `reasoning` 回退) | Qwen 模板方言,不绑定框架 | `--reasoning-parser qwen3` | Qwen3 parser | `--reasoning-format deepseek` |
| `usage`(详情字段可选) | OpenAI 标准 | 是 | 是 | 缺省可容忍 |

唯一的 vLLM 专属扩展是 `chat_template_kwargs`,它恰好出现在两个可配置位置:`offMode: chat-template-kwargs` 与 `preserveThinking: false`。其余全部是 OpenAI 标准或 **Qwen 模板级**(`enable_thinking`、`preserve_thinking`、`reasoning_content` 通道都是模型 chat 模板的词汇,任何正确实现 Qwen3.8 模板的框架都能理解)。

- **vLLM**——完全兼容;默认配置就是为它写的。
- **SGLang**——默认配置应可直接使用(它支持 `chat_template_kwargs.enable_thinking` 与 reasoning effort);以等价的 reasoning-parser 参数启动。
- **llama.cpp / Ollama**——部分支持:标准路径(文本/工具/图像)可用。`chat_template_kwargs` 不被识别 → 设置 `offMode: omit`(此时 `off` 仅表示省略参数;无法按请求关闭思考)。`reasoning_effort` 不被识别 → 不声明 `reasoning` 块。思考流可分离仅当服务端发出 `reasoning_content`(llama.cpp:`--reasoning-format deepseek`)。
- **DashScope / Qwen 云**——不支持:其 OpenAI 兼容端点把 `enable_thinking` 作为**顶层**参数接收,而不是放在 `chat_template_kwargs` 内,本适配器没有顶层模板变量的配置项。需要按档位的额外参数设计;超出 v1 范围(适配器面向本地 OpenAI 兼容服务器)。

## 前端配置(Web Models 页 / 设置)

前端配置分两面:**node 半**把 DSH 配置面消费的四个钩子接起来(与 `llm-deepseek` 和 `llm-pi-ai` 使用的一样),**client 半**渲染可编辑页面。

Node 半(宿主暴露的配置面):

- **设置节**(settings section)——插件的 `Config` schema 被安装为 `llm-qwen-local` 用户设置节(`installSettingsSection`)。这使得该节成为宿主的单一事实来源:可经设置 RPC(`settings.describe` / `settings.replace`)与 `settings.yaml` 读写。提交会**实时**切换配置源——适配器每请求重新解析,所以保存的变更无需重启即达下一次模型调用。不可服务的节在其写入处被拒绝。仅这一面*不会*画页面——web 设置模态框只渲染 client 插件注册进 `settings.section` 槽的页面。
- **可配置提供方目录**——`qwen-local` 路由经 `registerConfigurableProviders` 注册,使 web Models 页将其列为行(活跃或休眠)。它的命名空间也使设置 RPC 向配置客户端暴露 `llm-qwen-local`。
- **模型发现**——`registerModelDiscovery` 应答 `llm.discoverModels`:命名了 `baseURL` 的草稿触发 `GET {baseURL}/models` 探测(草稿的一次性 key——设置页传入表单中当前的 key,所以新填入的 key 无需保存即可探测——否则路由的已存凭证,否则免认证);命名了路由但没有端点的草稿直接由已配置目录回答,无网络调用。
- **凭证**——该节的 `apiKeyEnv` 字段是一个*名字*(凭证 ref 或环境变量名),绝不是 key 值。适配器先经持久凭证服务(即 web Models 页写入 key 的服务)解析,再落到启动环境。未命中以 `MISSING_CREDENTIAL` 大声失败,而不是让部署捡到无关的环境 key——名字无法解析也意味着发现探测回退到免认证,受认证的 vLLM 会回答 `401`。

Client 半(你实际编辑的页面):

- `src/client` 是一个 **client 插件**(声明于 `dsh.client`,以 `./client` 导出,构建为模块表 bundle `lib/client.js`)。它向设置模态框的 `settings.section` 槽注册一个 `Qwen 本地 (vLLM)` 页面,并在 `llm-qwen-local` 节上渲染一个表单:`baseURL`、**API Key** 字段、模型列表(id / 名称 / 容量 / 图像预算 / 多模态 / `preserveThinking` / 推理档位)、**从端点发现模型**按钮(经 `llm.discoverModels` 探测草稿端点并合并 id)、**保存**(经 `settings.replace` 写入整节)。**无路由级 `maxRequestImageBytes`**——该字段已从插件中完全移除(配置、schema 与页面均无):每张图像按 per-image 预算投影后内联,请求过大由后端 LLM 服务按其自身输入上限拒绝。宿主按 schema 校验草稿并回传脱敏值;schema 违规就地显示。文案经 DSH locale 注册表中英双语,页面在 `settings/document-updated` 时重新拉取,使两个打开的界面收敛。
  - **API Key** 字段遵循核心 Models 页约定:值经 `credentials.set` 写入持久凭证服务下由提供方派生的 ref `QWEN_LOCAL_API_KEY`,该节的 `apiKeyEnv` 记录这个 ref 名——原始 key 永不落入 `settings.yaml`。留空保持当前 key(未存 key 时则不发送 `Authorization` 头);**清除**按钮删除已存凭证与引用。若该节已命名一个本页面不管理的 ref(例如粘贴的原始 key),表单会标红——适配器无法解析它,端点会持续回答 `401`。
- bundle 只依赖平台 `react` / `react/jsx-runtime` 模块——所有 DSH 类型导入均为 type-only 并被擦除,全部服务经注入的 `slots` / `locale` / `connection` / `remote` 面到达。`pnpm build` 对两半都做类型检查,并在 `lib/` 旁产出 `lib/client.js`。

范围说明:Models 页的*精选*按家族编辑器卡片(baseURL/key/模型目录表单)只在 `ui-settings-models` client 包中为 `llm-deepseek` 与 `llm-pi-ai` 两个命名空间手写。不属于这两个家族的路由会列在 Models 页上,但渲染通用的"其余请在 settings.yaml 中编辑"提示——Models 页没有第三方编辑器卡片的槽。因此本插件提供的可编辑面是专用的**设置页**,而不是 Models 页卡片。专门的 Models 卡片将是 `ui-settings-models` 的核心贡献,而非插件侧改动。

## 错误路径

- **由 `stream()` 抛出**(传输/协议失败):fetch 失败或 `TRANSPORT`;非 2xx 映射为 `AUTH`/`RATE_LIMIT`/`INVALID_REQUEST`/`SERVER`/`HTTP_<n>`(存在时附 `status`、`retry-after`、请求 id);SSE 载荷畸形 `MALFORMED_RESPONSE`;缺少 `[DONE]` 的截断 `STREAM_CLOSED`;空闲超时 `TIMEOUT`;调用方中止 `ABORTED`;图像/内容门禁 `UNSUPPORTED_CONTENT`(仅限直接适配器使用——运行时会先为纯文本模型投影图像);未知档位 `UNSUPPORTED_REASONING_EFFORT`;命名了 `apiKeyEnv` 却无处解析 `MISSING_CREDENTIAL`(在任何网络 I/O 之前)。请求图像投影失败中,除"不支持能力"的拒绝外,作为附件错误传播。
- **带内提供方失败**:携带 `error` 对象的 SSE 载荷关闭所有开放块,并以 `finish {kind: 'error', failure: {code: 'PROVIDER_ERROR'}}` 结束流。
- 无内容的完整响应映射为 `EMPTY_RESPONSE` 错误 finish。

每个提供方请求都携带 harness 的 `attributionHeaders()`;`options.signal` 贯穿 fetch 与正文读取被遵守。

## 已知限制与推迟事项

- **模态声明不受校验**——纯文本端点上设 `multimodal: true` 会在图像消息持久化后于回合中途失败(恢复:新会话 / 分叉 / 换模型)。反方向现在是**静默**的:视觉端点上设 `multimodal: false` 会让运行时把图像投影为文本占位符,模型作答但看不到图像(拨动开关后重新提问)。
- **请求图像投影依赖提供方**——当挂载的附件提供方无法派生请求图像(`ATTACHMENT_PROJECTION_UNSUPPORTED`)时,适配器回退到归一化主字节,该部署下 `imageMaxPixels`/`imageMaxBytes` 变为建议值。
- **工具结果内的图像搭乘后续用户消息**——vLLM wire 的 `role: 'tool'` 内容为纯文本,所以多模态模型的工具结果含图时执行拆分:工具消息保留文本,图像部件紧随其后出现在一条 `role: 'user'` 多模态消息中(说明文字:"Images returned by the tool call above are attached.")。纯文本模型仍对工具结果内的图像以 `UNSUPPORTED_CONTENT` 拒绝(直接适配器防御;运行时会先把此类图像投影为占位符)。
- **无 `replayState`**——端点无状态,历史从记录的块(含推理,经 `preserve_thinking`)干净回放,所以适配器不发出适配器私有的回放元数据。
- **无按路由的重试策略**——v1 没有 `retryPolicy` 配置;应用 harness 的正常默认值。
- **思考回放仅限无工具调用的回合**——推理只在无工具调用的助手回合以 `reasoning_content` 回放(官方 Qwen3.8 示例的形状);希望在工具调用回合也保留思考的部署需要模板级改动。
- **不支持视频输入**——Qwen3.8-27B 接受 `video_url` 部件,但 harness 没有视频内容块,所以只接了 `image`;需要视频的部署需要新的 harness 内容块外加 `video_url` 序列化路径。
- **拒绝助手侧图像**——harness 图像块在实践中仅限用户内容;助手/系统侧的图像内容被拒绝,而不是静默抹除(工具结果侧的多模态模型走上述拆分路径)。

## 本插件不声称

- 它不是 DeepSeek 或 Qwen/阿里巴巴的官方产品,也不暗示官方背书。
- 它不询问 vLLM 端点——`multimodal`、上下文容量、推理档位都是**关于你部署的声明**,声明错误的代价是回合中途的拒绝(或对低报视觉能力的静默纯文本投影),而不是协商出的能力。
- 它不支持 DashScope / 通义云或任何非 OpenAI 兼容的 Qwen 端点;目标是本地 vLLM(或兼容)服务。
- 它不把图像理解扩展到视频、音频、PDF 或图像生成。
- 它不替换 DSH 的会话日志、附件管线或模型选择器;它贡献一条 LLM 路由、一个设置 section 和一个设置页面。
