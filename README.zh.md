# dsh-llm-qwen-local

[English](README.md) | 简体中文

![Qwen 本地 (vLLM) 设置页](docs/assets/setting.png)

用于**本地部署的 Qwen 模型**(如 Qwen3.8-27B)的 DeepSeek Harness LLM 适配器插件,由 **vLLM** 以其 OpenAI 兼容的 `/v1/chat/completions` 端点提供服务。

> **v0.3.0** · 精确兼容目标:DSH `0.1.1-rc.2` · MIT · 社区维护,非 DeepSeek 或 Qwen 官方产品。

```sh
dsh plugin --profile web add github:starefinger/dsh-llm-qwen-local
```

两个部署相关的一等公民配置项:

- **按模型的多模态开关**(`multimodal: true/false`)——声明该部署是否带视觉能力提供服务。
- **完全可配置的推理档位**(reasoning efforts)——所有可选档位、其显示名、`reasoning_effort` 的 wire 拼写、默认档位,以及 `off` 在 wire 上的表达方式,全部来自配置,可匹配你的 vLLM 构建接受的任意词汇表。

此外,自 0.1.1-rc.2 harness 升级起:

- **单世代调用绑定**(one-generation call binding)——适配器覆写 `LlmAdapter.prepareCall`,一次性快照连接事实(端点、目录、预算),并把模型元数据与最终派发都绑定到该快照,使 prepare 与 dispatch 之间落地的设置提交永远不会混入两代配置。
- **请求图像管线**(request-image pipeline)——当挂载的附件服务提供方实现了 `readImageRequest` 时,图像字节经由其投影(确定性像素/字节预算、变体缓存)处理;否则回退到归一化主字节。

```yaml
- id: llm-qwen-local
  name: dsh-llm-qwen-local
  config:
    baseURL: http://127.0.0.1:8000/v1
    models:
      - id: qwen3.8
        name: Qwen3.8 (local)
        multimodal: true
        reasoning:
          efforts:
            - { id: off, wire: none }
            - { id: low, wire: low }
            - { id: medium, wire: medium }
            - { id: xhigh, wire: xhigh }
          defaultEffort: xhigh
```

## 环境要求

- 已安装 `dsh`(CLI)**0.1.1-rc.2 或更新版本**(适配器使用了该版本引入的
  `LlmAdapter.prepareCall` 缝与 harness 侧的纯文本模型图像投影),以及一个以
  OpenAI 兼容 API 服务你的 Qwen 模型的 vLLM 实例。
- 带全局 `fetch` 的 Node.js(18+)。
- 组合中挂载了 `@deepseek-ai/dsh-attachment` 的 profile——标准的 `web` 与
  `headless` profile 都经由 `dsh-base` 挂载了它。适配器在请求时才惰性解析附件
  服务(纯文本部署永远不会触碰它),但模块导入本身在插件加载时就会解析,因此
  缺少该包的组合会在加载期失败。

## 安装

```sh
# 从 npm 安装(推荐——预构建,安装时无需构建):
dsh plugin --profile web add dsh-llm-qwen-local

# 从 git 安装(prepare 脚本会在安装时自动构建 lib/):
dsh plugin --profile web add github:starefinger/dsh-llm-qwen-local

# 或从本地 checkout 安装(同样在安装时运行 prepare 构建):
dsh plugin --profile web add ./path/to/qwen3.8-LLM-plugin

# 或从打包好的 tarball 安装(预构建,安装时无需构建):
dsh plugin --profile web add ./dsh-llm-qwen-local-0.3.1.tgz

# 验证贡献的层,然后启动:
dsh --profile web --dump-config
dsh --profile web
```

### 版本锁定安装(tag)

每个兼容性快照都会以它对应的 dsh 版本号打 tag。0.3.1 及之后的快照使用 `dsh-<dsh版本号>-plugin-<插件版本号>` 格式(dsh 版本在前,插件版本作后缀);更早的快照使用不带后缀的 `dsh-<dsh版本号>` 格式。**同一个 dsh 版本可能存在多个 tag——请使用插件版本号后缀最大的那个:它是支持你的 dsh 的最新快照。** 要安装某个特定快照,在 git URL 后追加 `#<tag>`——pnpm 会把 tag 解析到精确的 commit,安装结果可复现,且与 `main` 分支当前的状态无关:

```sh
# 安装 dsh 0.1.1-rc.2 的最新快照(插件 0.3.1):
dsh plugin --profile web add "git+https://github.com/starefinger/dsh-llm-qwen-local.git#dsh-0.1.1-rc.2-plugin-0.3.1"
```

选择与你 dsh 版本匹配的 tag(`dsh --version` 查看)——同一个 dsh 版本有多个 tag 时,取插件版本号后缀最大的。升级 dsh 后,先移除再用新版本的 tag 重新安装:

```sh
dsh plugin --profile web remove dsh-llm-qwen-local
dsh plugin --profile web add "git+https://github.com/starefinger/dsh-llm-qwen-local.git#dsh-<新dsh版本号>-plugin-<插件版本号>"
```

tag 是不可变的快照:已发布 tag 的修复会以新 tag 发布(同一 dsh 版本下插件版本号后缀更大的新 tag),绝不移动已有 tag 的指向。

git 与本地路径安装会在安装时运行包的 `prepare` 脚本(→ `pnpm build`)来生成 `lib/`。pnpm v10 默认拦截依赖包的构建脚本:如果首次安装因 "blocked build scripts" 报错,把 pnpm 打印出的那个 key 原样加到 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 下,再重跑同一条 `dsh plugin add` 即可。tarball 安装是预构建的,永远不需要这一步。

bundle 的 `cordis.patch.yml` 会插入一行基线 `llm-qwen-local`(模型 `qwen3.8`,多模态 `true`,`off/low/medium/xhigh` 档位,默认 `xhigh`)。安装后在 Web UI 的模型选择器中选中该模型即可;适配器通过 `listModels()` 公告它。

要修改任何配置,在你的 profile 的 `cordis.patch.yml` 中按 `id: llm-qwen-local` 覆盖该行——patch 会替换目标行的**整个** `config`(不做深度合并),所以保留的每个键都要重新写一遍。

## 快速上手

安装后,在 Web UI 的模型选择器中选中该模型——基线 `qwen3.8` 条目出现在 **Qwen (local)** 提供商分组下:

![模型选择器:已选中 Qwen3.8-27B (local)](docs/assets/use_guide_1.png)

点击输入框底部(模型名 + 档位,如 `Qwen3.8-27B (local) xhigh`)可切换会话模型或按请求选择**推理等级**(你配置中声明的档位,如 `off` / `low` / `medium` / `xhigh`):

![从输入框底部打开的推理等级菜单](docs/assets/use_guide_2.png)

其余所有配置都在 **设置 → Qwen 本地 (vLLM)** 页面编辑(节点侧 section 即 `llm-qwen-local`):端点、可选 API Key(存入宿主凭据服务,绝不写入 `settings.yaml`)、以及每个模型一张卡片——id、显示名、上下文窗口、输出上限、图像预算、多模态开关、历史思考保留、推理档位表:

![设置页:端点、图像预算、API Key 与模型卡片](docs/assets/setting.png)

![设置页:推理档位表、默认档位与发现/保存操作](docs/assets/setting2.png)

保存后**即时生效**——适配器按请求重新解析,保存的变更在下次模型调用时即到达,无需重启。

## 配置参考

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

### 模型条目

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

### 多模态开关

`multimodal` 是**关于你端点的声明,而非对端点的检查**——没有任何东西去询问 vLLM 接受什么。自 0.1.1-rc.2 harness 升级起,harness 的 LLM 运行时自己处理"低报"的情形:

- `false`(默认):模型以纯文本公告(`inputModalities: ['text']`)。harness 运行时现在会把图像**投影**为确定性的文本占位符(`[image omitted because this model accepts text only; attachment sha256:…]`),发生在**适配器看到之前**——请求以纯文本继续,而不是被拒绝。适配器在序列化时仍保留自己的 `UNSUPPORTED_CONTENT` 门禁,覆盖直接使用(非运行时)与运行时投影之外组装的历史。
- `true`:模型以 `['text', 'image']` 公告。图像字节通过持久附件服务(`ctx.attachments`)解析;没有该服务的组合会对任何图像以 `UNSUPPORTED_CONTENT` 拒绝,而不是猜测来源。**工具返回的图像会被拆分而非拒绝**(见下):wire 强制的严格 OpenAI 摆位是 `image_url` 部件只能搭乘 `user` 消息,所以含图像部件的工具结果序列化为纯文本的 `role: 'tool'` 消息,紧跟一条携带说明文字与图像部件的 `role: 'user'` 多模态消息(QwenLM `qwen-code` 的 `splitToolMedia` 形态)。

两种声明错误的代价不同:**高报**会接受一张提供方随后**在回合中途**拒绝的图像——此时消息已持久化进会话日志——该会话会反复重发这张失败的图像。恢复途径是新建会话、在图像之前分叉、或换一个模型;把未被消费的图像消息从失败的发送中回滚是推迟事项。**低报**不再大声失败:图像静默变成上面的占位符——模型仍然作答,但看不到图像(恢复:拨动开关后重新提问)。绕过运行时投影的调用方仍会触发直接适配器门禁(`UNSUPPORTED_CONTENT`,并指明模型名)。

图像字节以内联的 `image_url` 部件承载,值为 `data:<mediaType>;base64,…`;可用时经附件服务的请求图像管线投影(`readImageRequest`;harness 规范策略:最多 `imageMaxPixels` 像素、`imageMaxBytes` 编码字节、按变体缓存),对以 `ATTACHMENT_PROJECTION_UNSUPPORTED` 拒绝投影的提供方回退到归一化主字节(`readImage`)。

### 推理档位

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

## Wire 方言(vLLM + Qwen3.8)

请求:`model`、`messages`(system 在前;多模态用户消息为 `text` / `image_url` data-URL 部件组成的 `content` 部件数组;工具结果为 `role: 'tool'`)、`tools`、`stream: true`、`stream_options: { include_usage: true }`,以及在偏离模板默认时附带 `reasoning_effort` 与 `chat_template_kwargs`、设置时附带 `temperature`、`max_tokens`、`stop`。

响应:SSE `data:` 载荷,以 `data: [DONE]` 哨兵结尾。`delta.reasoning_content`(以及部分框架发出的 `delta.reasoning` 拼写)→ harness `reasoning` 块(Qwen 思考通道);`delta.content` → `text` 块;`delta.tool_calls` → `tool-call` 块,`argumentsDelta` 为原始 JSON。`finish_reason`:`stop`/`content_filter` → `stop`,`length` → `max-tokens`,`tool_calls` → `tool-calls`,其余 → `error` finish。usage 附着在 finish 块上和/或以末尾单独的 usage-only 块到达;两者都被缓冲,在所有 `block-end` 之后、`finish` 之前冲刷(`finish` 之后不发射任何东西)。

历史回放:`preserve_thinking` 处于模板默认(开)时,助手推理在无工具调用的回合以 `reasoning_content` 回放——正是官方 Qwen3.8 示例所做的那种重构;含工具调用的回合与 `preserveThinking: false` 的模型不发送推理。工具调用以 `tool_calls` 回放,`content: ""`(绝不 `null`)。工具结果序列化为纯文本的 `role: 'tool'` 消息;对多模态模型,工具结果内的图像部件被拆到紧随其后的 `role: 'user'` 多模态消息(说明文字 + `image_url` 部件)——这也让旧版本插件曾永久拒绝的历史(被"毒化"的会话)在新版本下自动恢复。

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

**必需的 vLLM 服务参数**(按官方 vLLM 配方):`--reasoning-parser qwen3` 实际上是强制的——没有它整个推理块会落进 `message.content`——工具调用还需 `--enable-auto-tool-choice --tool-call-parser qwen3_coder`,以及 `--max-model-len 262144`(或更高)。

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

前端配置分两面:**node 半**把 DSH 配置面消费的四个钩子接起来(与
`llm-deepseek` 和 `llm-pi-ai` 使用的一样),**client 半**渲染可编辑页面。

Node 半(宿主暴露的配置面):

- **设置节**(settings section)——插件的 `Config` schema 被安装为
  `llm-qwen-local` 用户设置节(`installSettingsSection`)。这使得该节成为宿主
  的单一事实来源:可经设置 RPC(`settings.describe` /
  `settings.replace`)与 `settings.yaml` 读写。提交会**实时**切换配置源——
  适配器每请求重新解析,所以保存的变更无需重启即达下一次模型调用。
  不可服务的节在其写入处被拒绝。仅这一面*不会*画页面——web 设置模态框
  只渲染 client 插件注册进 `settings.section` 槽的页面。
- **可配置提供方目录**——`qwen-local` 路由经
  `registerConfigurableProviders` 注册,使 web Models 页将其列为行(活跃或
  休眠)。它的命名空间也使设置 RPC 向配置客户端暴露 `llm-qwen-local`。
- **模型发现**——`registerModelDiscovery` 应答
  `llm.discoverModels`:命名了 `baseURL` 的草稿触发
  `GET {baseURL}/models` 探测(草稿的一次性 key,否则路由的已存凭证,否则
  免认证);命名了路由但没有端点的草稿直接由已配置目录回答,无网络调用。
- **凭证**——该节的 `apiKeyEnv` 字段是一个*名字*(凭证 ref 或环境变量
  名),绝不是 key 值。适配器先经持久凭证服务(即 web Models 页写入 key
  的服务)解析,再落到启动环境。未命中以 `MISSING_CREDENTIAL` 大声失败,
  而不是让部署捡到无关的环境 key——名字无法解析也意味着发现探测回退到
  免认证,受认证的 vLLM 会回答 `401`。

Client 半(你实际编辑的页面):

- `src/client` 是一个 **client 插件**(声明于 `dsh.client`,以
  `./client` 导出,构建为模块表 bundle `lib/client.js`)。它向设置模态框的
  `settings.section` 槽注册一个 `Qwen 本地 (vLLM)` 页面,并在
  `llm-qwen-local` 节上渲染一个表单:`baseURL`、路由级
  `maxRequestImageBytes`、**API Key** 字段、模型列表(id / 名称 / 容量 /
  图像预算 / 多模态 / `preserveThinking` / 推理档位)、**从端点发现模型**
  按钮(经 `llm.discoverModels` 探测草稿端点并合并 id)、**保存**(经
  `settings.replace` 写入整节)。宿主按 schema 校验草稿并回传脱敏值;
  schema 违规就地显示。文案经 DSH locale 注册表中英双语,页面在
  `settings/document-updated` 时重新拉取,使两个打开的界面收敛。
  - **API Key** 字段遵循核心 Models 页约定:值经 `credentials.set`
    写入持久凭证服务下由提供方派生的 ref `QWEN_LOCAL_API_KEY`,该节的
    `apiKeyEnv` 记录这个 ref 名——原始 key 永不落入 `settings.yaml`。
    留空保持当前 key(未存 key 时则不发送 `Authorization` 头);**清除**
    按钮删除已存凭证与引用。若该节已命名一个本页面不管理的 ref(例如
    粘贴的原始 key),表单会标红——适配器无法解析它,端点会持续回答
    `401`。
- bundle 只依赖平台 `react` / `react/jsx-runtime` 模块——所有 DSH 类型
  导入均为 type-only 并被擦除,全部服务经注入的 `slots` / `locale` /
  `connection` / `remote` 面到达。`pnpm build` 对两半都做类型检查,并在
  `lib/` 旁产出 `lib/client.js`。

范围说明:Models 页的*精选*按家族编辑器卡片(baseURL/key/模型目录表单)只在
`ui-settings-models` client 包中为 `llm-deepseek` 与 `llm-pi-ai` 两个命名空间
手写。不属于这两个家族的路由会列在 Models 页上,但渲染通用的"其余请在
settings.yaml 中编辑"提示——Models 页没有第三方编辑器卡片的槽。因此本插件
提供的可编辑面是专用的**设置页**,而不是 Models 页卡片。专门的 Models 卡片
将是 `ui-settings-models` 的核心贡献,而非插件侧改动。

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

## 开发

```sh
pnpm install
pnpm build     # tsc → lib/ + 客户端 bundle
pnpm typecheck
pnpm test      # vitest: 序列化、翻译、对 mock vLLM 的 e2e
```

测试针对脚本化的进程内 vLLM(SSE)mock 运行——不需要真实模型或端点。

## 许可

本仓库以 [MIT](LICENSE) 许可发布。

插件运行时仅依赖 MIT 许可的包(`@deepseek-ai/schemastery`、`eventsource-parser`);开发工具链中包含 TypeScript(Apache-2.0)及其他 MIT 许可工具。本仓库未打包(vendor)任何 DeepSeek Harness 或 Qwen 源码。Qwen3.8-27B 模型权重与 DSH 产品各自受其上游条款约束;本插件为社区项目,非 DeepSeek 或 Qwen/阿里巴巴官方产品。
