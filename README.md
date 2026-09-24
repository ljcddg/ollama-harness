# Ollama Harness

**给本地小模型用的编码 agent harness。** 桌面应用（Electron + React + TypeScript），核心是纯 Node、不 import Electron。除了你自己开的 Ollama，没有云依赖——你的代码和对话不离开这台机器。

> **English summary** — A local-first coding-agent harness for [Ollama](https://ollama.com) models.
> Sessions are an append-only event log replayed into every request, never a mutable message list.
> Adapters are the only provider-aware code. And because the model is small, the *harness* carries the
> responsibility for staying on track: stalled plans, capability denials and unbacked claims are
> detected and corrected, tool output is pre-digested so it cannot be misread, and a turn that used
> tools cannot end until a self-review agrees it answered the request. Offline, no telemetry, MIT.

`Node 22+` · `Electron 33` · `TypeScript 5.7` · `MIT` · `9 个工具` · `131 条核心断言`

## 技术底座

| | |
|---|---|
| chat 模型 | **`gemma4:e2b`**（2B 级）。工具的注册顺序、提示词写法、守卫阈值——全都是围着它的实际行为调出来的，而不是照着一篇论文写的 |
| 嵌入模型 | `bge-m3`（只有 `search` 工具用；没装就不注册这个工具） |
| 界面外观 | 参考并改编自 **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**（MIT） |

关于外观：窗口框架与视觉气质照 DeepSeek Harness 的路子做了一套本项目自己的实现；**核心部分——事件日志、适配器、工具层、守卫与自审门——是独立实现的**。方向也相反：DSH 是"一切皆插件"，这里是**内核写死、边界清楚**（三个设计决策见后文）。两者都是 MIT，署名与许可在此保留。

---

## 目录

- [它真正解决什么问题](#它真正解决什么问题)
- [快速开始](#快速开始)
- [工具](#工具)
- [目前实现了什么](#目前实现了什么)
- [三个不能破的设计决策](#三个不能破的设计决策)
- [模型跑偏时 harness 会做什么](#模型跑偏时-harness-会做什么)
- [上下文工程](#上下文工程)
- [目录结构](#目录结构)
- [验证门：凭什么信它](#验证门凭什么信它)
- [效果与限制（诚实版）](#效果与限制诚实版)
- [配置](#配置)
- [安全](#安全)
- [排错](#排错)
- [License](#license)

---

## 它真正解决什么问题

这不是又一个 Cline / Continue 的复刻。那些项目默认你手里是 Claude 或 GPT——**模型足够聪明，harness 只需要把文件递给它**。

这个项目的前提正好相反：**模型是 2B~8B 的本地小模型，它一定会跑偏。** 于是责任划分反过来——不是指望模型自觉，而是把工作搬到 harness 侧，并且每一种失效模式都对应一段可断言的代码，而不是一句提示词。

下面每一条都是实测踩出来的，不是设想：

| 实测到的失效模式 | harness 的对策 |
|---|---|
| **把计划当执行**：输出"接下来我会读 pom.xml…"，然后零工具调用就收尾 | `detectStall()`：前瞻语 + 无结果词 + 正文 <400 字 → 注入纠正，明说"宣布不等于执行" |
| **否认能力**："我无法访问本地文件系统"——而它手里就有 `read` | `detectCapabilityDenial()`：这种拒绝一旦进了 transcript 就会被当成既定事实，所以纠正必须**显式撤销**它 |
| **空口断言**：提到工具名 + 前瞻语气 + 一次调用都没有 | `detectUnbackedClaim()`：命中就重新唤起模型，而不是让它结束这一轮 |
| **答完了但没做到要求** | 自审门 `runSelfReview()`：见后文 |
| **搜不到就断言"代码里没有"** | 工具输出的形状：`grep` 扫过 0 个文件时单独报 `Nothing was searched`，**绝不出现 "No matches"** |
| 中文提问 ↔ 英文标识符，`grep` 没有共享 token | `search` 工具：bge-m3 向量检索兜住语义这一路 |
| 长对话后凭记忆答话，把**别的项目**的内容安到当前项目上 | 自动压缩：超过阈值就把前文折成摘要 |

第一条通用规则是：**工具的输出形状决定模型的结论。** "什么都没查"和"查了没有"必须用不同的话说。

## 快速开始

```bash
npm install
npm run dev          # Vite dev server + Electron
```

需要：

- Node 22+
- [Ollama](https://ollama.com/download) 在本机跑着（`ollama serve`）
- 至少一个支持工具调用的模型：`ollama pull qwen2.5:7b`
- 可选，语义检索：`ollama pull bge-m3`（没有它，`search` 工具不会出现在工具列表里）

```bash
npm run build && npm start   # 跑构建产物
npm run check:all            # 全量健康检查（见「验证门」）
```

> **先读「[效果与限制](#效果与限制诚实版)」再决定要不要折腾。** 它现在的效果并不好——能跑通一件小事，但不要指望它独立完成中等规模的任务。原因写在那一节里。
>
> 开发主要在 2B 级小模型上做（`gemma4:e2b`）——守卫就是为它们写的。换到 7B 级会明显更少触发纠正，体验更顺。**没有模型时应用照常启动**，只是列表为空并明确告诉你连不上 Ollama。

## 工具

应用里接的是 9 个（`search` 需要嵌入模型才注册；不能用的工具不注册，因为死条目每一步都在烧 prompt token）：

| 工具 | 作用 |
|---|---|
| `read` | 读文件。PDF / docx / GBK 文本都会先解码成文本再给模型，二进制会报"是二进制"而不是"内容为空" |
| `list` | 目录概览（结构 + 类型直方图 + 身份文件），尾部附 **L0 确定性项目地图** |
| `glob` | 按文件名找 |
| `grep` | 按内容找。支持 `AI OR retry` 这类被模型当正则写的表达式；命中空集时说清是哪个环节挡住的 |
| `search` | 语义检索（本地嵌入模型 + 进程内向量索引）：中文提问能命中英文标识符 |
| `web` | DuckDuckGo 检索 + 抓正文。离线时明确报"连不上"，而不是装作没有这个工具 |
| `edit` | 精确替换文件内容（需唯一匹配） |
| `write` | 整份覆盖一个文件 |
| `bash` | 执行命令。危险形状（`rm -rf`、`git push --force`、把下载直接管进 shell 等）**永远弹确认** |

工具注册顺序就是它出现在 prompt 里的顺序：**先读后写**，因为小模型大致按看到的顺序挑工具，而"改之前先读"是防住大部分破坏的习惯。

## 目前实现了什么

**已经能用**

- [x] 事件日志驱动的会话：append-only JSONL；编辑与压缩都是追加事件，取消/恢复/重放精确
- [x] 9 个工具，含文档抽取（PDF 的 Flate 流、docx、GBK/UTF-8 编码探测）
- [x] 三个守卫 + 自审门，每次判定都写进日志（`review/result`），事后可查"这轮为什么结束"
- [x] 自动压缩、审批流程、路径约束（对最深已存在祖先 realpath，符号链接逃不出去）
- [x] 工作目录绑定会话：侧栏按目录分组，目录之外的操作要审批
- [x] L0 确定性项目地图（pom / package.json / Java 注解），替代模型的"似乎是前端"
- [x] 语义检索：本地嵌入模型 + 进程内向量索引 + size/mtime 指纹失效
- [x] 个性化：称呼、自称、四种语气、追加风格要求
- [x] 行内数学兜底（模型爱写 `$\rightarrow$`，翻译成 `→` 再渲染）
- [x] 11 道验证门：131 条核心断言 + 4 道 CDP 探针 + 真 Ollama 端到端

**还没做**

- [ ] **只有 Ollama 适配器。** `LlmAdapter` 抽象在，OpenAI 兼容端点没接
- [ ] **多模态没接。** `ContentBlock` 还没有 image，视觉能力未接线
- [ ] **工作目录外的路径每次都重新询问**（没有"记住这一次选择"）
- [ ] **没有真实模型的自动回归。** `check:live` 要手动跑，且要本机有 Ollama
- [ ] **"看项目"这类请求还没有 harness 驱动的递归读**（分层摘要挂在哪一层未定）
- [ ] 侧栏折叠状态只在组件 state 里，切会话就丢

## 三个不能破的设计决策

**① 事件日志是唯一真相。** 会话是 append-only 的 JSONL。每次模型调用都从日志重新 `deriveMessages()` 推导请求，**不存在"当前消息列表"这个变量**。编辑和压缩同样是追加事件，由 fold 决定"当前值"——fold 从不修改原事件。这让取消、恢复、重放在语义上是精确的，而不是近似的。`shared/session.ts` 里的 `deriveMessages()` 是这个仓库最重要的函数。

**② 适配器是唯一的 provider 边界。** `shared/message.ts` 定义与 provider 无关的词汇表；适配器负责它与某一种 wire 协议之间的翻译。加一个 provider = 写一个适配器，不碰 loop、不碰工具、不碰 UI。目前实现了 Ollama（`/api/chat` 的 NDJSON，不是 SSE）。嵌入也走适配器的可选方法（`/api/embed`），wire 格式所以不会漏进工具层。

**③ 渲染进程是纯视图。** 它只通过 IPC 说话，并且**用与主进程同一套 fold** 重建会话。两者不可能对"对话里有什么"产生分歧，因为它们跑的是同一个函数。

## 模型跑偏时 harness 会做什么

这是本项目最不一样的地方，值得单独说。

### 守卫（`core/stall.ts`）

每步结束时按固定顺序检查，命中就注入一条纠正消息：

1. **能力否认** → "你有工具，直接读，别把活派回给用户"
2. **停滞** → "宣布不等于执行"
3. **空口断言** → "你说了要查，但没有一次调用"

纠正不是"再试一次"的重试，而是**一条内容具体的消息**，并且复用压缩用的那条通道（system 来源的 user 消息）——**不新增事件类型**。渲染器会把它从视图里丢掉：那不是用户说的话，把它渲染成用户气泡会让 transcript 撒谎。

### 自审门（`core/review.ts` + `core/loop.ts`）

模型的"我完成了"不是结束条件。**本轮跑过工具**时（纯问答不设门——那只会让门每次都说"无法确认"），harness 会把 transcript 交给同一个模型审一遍：要求达到了吗？

- 不通过 → 把**分解过**的意见回喂，逼它再答（≤3 轮）
- 同一批意见对上一个**已经改过的**答案重复出现 → 判定为审查器漂移，放行而不是空转
- 轮次用尽 → 把欠的东西交给用户，而不是假装成功
- 审查器自己跑挂 → 放行，不为 harness 的错误惩罚模型
- 每一次判定都写进日志（`review/result`），所以"这轮为什么结束 / 为什么又答了一遍"事后可查

**已知的诚实边界**：审查器和被审查者是同一个弱模型。计数拦不住这一点，所以尺子必须自带刻度——`buildReviewPrompt()` 里的四条规则（只从请求推导要求、模糊请求也算有要求、要求写成可验证条件、证不了判 `unclear` 而不是 `missing`）就是为此写的。

## 上下文工程

没有一家成熟的 harness 指望"模型自觉多读"，决定什么进上下文的是 harness：

| 机制 | 位置 | 解决什么 |
|---|---|---|
| L0 确定性项目地图 | `core/tools/repo-map.ts` | Aider 式：离线抽事实（pom 的 artifactId、package 依赖、Java 类的注解），挂进 `list` 输出。替代模型的"似乎是前端" |
| 语义检索 | `core/tools/search.ts` | 中英错位。60 行一块、进程内索引、size+mtime 指纹失效、相似度下限 0.05（零相似结果不进榜单） |
| 自动压缩 | `core/loop.ts` | 每轮开始前跑，超过阈值就把前文折成一段摘要追加 `session/compact`；**什么都不删**，fold 从该 seq 之后恢复 |

## 目录结构

```
src/
  shared/          各层共用的词汇表
    message.ts       provider 无关的消息与流式类型
    session.ts       事件日志，以及从它推导状态的 fold
    ipc.ts           主进程 ↔ 渲染进程的契约
    grouping.ts      侧栏按工作目录分组（纯函数）
    latex.ts         行内数学的兜底简化（模型爱写 $\rightarrow$，渲染器不认）
  core/            不含任何 Electron import，能在纯 Node 下跑
    llm/
      adapter.ts        LlmAdapter 基类
      ollama-adapter.ts Ollama 的 /api/chat（NDJSON）
      assembler.ts      把 StreamChunk 折成 content block
    tools/           9 个工具 + 路径约束（paths.ts）
    loop.ts          agent 循环、守卫、自审门
    review.ts        自审门的判据与解析
    stall.ts         失效模式检测
    prompt.ts        系统提示词组装
    transcript.ts    审查用的平铺 transcript
    extract.ts       PDF / docx / 编码探测
    session-store.ts  JSONL 持久化
  main/            Electron 主进程
    agent-service.ts  编排 loop + adapter + store
    main.ts           窗口、IPC handler、生命周期
    menu.ts           原生菜单
    preload.ts        contextBridge 表面（编成 CommonJS）
  renderer/        React 界面
    hooks/useHarness.ts  把推送来的事件折成节点树
    components/          MessageList / Composer / Sidebar / 两个弹窗
scripts/           验证门（见下节）+ 排查工具
```

主进程按 ESM 构建，唯独 `preload.ts` 是例外：Electron 用 `require()` 加载它，而本包是 `"type": "module"`——于是 `tsconfig.preload.json` 单独编它、`scripts/finalize-preload.mjs` 把它改名成 `.cjs`。因为在这个约束下它不能在运行时 import `shared/ipc.ts`，它**内联**了通道名，而 `check-core` 会断言这些副本与 `shared/ipc.ts` 仍然一致。

## 验证门：凭什么信它

一个 agent harness 的行为很难靠肉眼确认（"它是不是没查就说没有？"），所以这个仓库的做法是：**每一条重要的行为都配一个可执行断言。** 改完代码必须全绿。

```bash
npm run check:all
```

| 命令 | 断言什么 |
|---|---|
| `typecheck` | 三个 TypeScript 项目全部通过 |
| `check` | **131 条核心断言**：日志 fold、流式装配、参数校验、glob、分组、文档抽取、停滞/否认/空口断言检测、自审门、工具输出形状、preload 契约 |
| `check:cwd` | 工作目录由会话头决定，不是全局默认值（5 个 case，含目录已不存在的情形） |
| `check:load` | 每个已安装的包真的能被 `require` |
| `check:deps` | 每个包声明的入口在磁盘上真的存在 |
| `check:smoke` | 编译产物能在 Electron 自带运行时下加载 |
| `check:render` | 构建后的应用能开窗，且 React 真的挂载了 |
| `check:composer` | 输入框的真实尺寸、自增高、不早出滚动条 |
| `check:sidebar` | 侧栏分组、弹出菜单不被裁切 |
| `check:settings` | 设置弹窗真的能滚，且帧预算达标 |
| `check:live` | 真 Ollama 端到端（需要本地模型） |

其中**四道是 CDP 探针**（`check:render` / `check:composer` / `check:sidebar` / `check:settings`，都在 `scripts/probe-*.mjs`）：启动真应用、连上调试端口、向页面要**量出来的数字**而不是截图。它们存在的原因是——"窗口开了，但里面是空白"和"窗口开了，一切正常"在所有日志里长得一模一样。

排查模型行为用 `node scripts/inspect-session.mjs --list / --turns / --last N`：日志在 `%APPDATA%\ollama harness\sessions\<uuid>.jsonl`，**"没调用"和"调了失败"一眼能分**。

## 效果与限制（诚实版）

**先说结论：它现在的效果并不好。** 它能跑通一件小事（读几个文件、改一处、自己验证一下），但**不要指望它独立完成一个中等规模的任务**。

### 为什么

- **模型就是天花板。** 2B 级模型的工具调用本身就不稳：会重复调、会挑错工具、会在长序列里丢掉目标。守卫能挡住最蠢的收尾（比如"我读过了"其实一次都没读），但**守卫是止损，不是提升**——它换不来正确性。
- **审查器和被审查者是同一个模型。** 自审门用同样的权重去判断刚才那次回答好不好，所以它有盲区（已经记录了两处：一轮里跑过工具之后 claim 守卫会被关掉；停滞检测不看 reasoning）。计数拦不住这件事，只能靠给尺子加刻度。
- **压缩会丢细节。** 长会话必须压缩才能留在上下文窗口里，而摘要必然丢东西；压缩之后模型偶尔会把细节记错。
- **会撞步数上限。** 一步 = 一次模型调用 + 它要求的工具。改多个文件的任务很容易超过默认的 `maxStepsPerTurn`，然后它半途停下——这时要么调高上限，要么把任务拆小。
- **显存与速度。** 本地推理受本机显存限制：chat 模型和嵌入模型同时常驻，上下文越长越慢。**上下文不是免费的**，`maxTokens` 和压缩阈值都值得按机器调。
- **只支持 Ollama。** 想接别的后端，得自己写一个适配器。

### 实测环境

> **【待填：显卡 / 显存 / 内存 / 系统】** —— 上面这些结论都是在这套配置 + `gemma4:e2b` 上测出来的，换配置数字会变。

### 那为什么还值得做

因为"把工作放在 harness 侧"这件事本身是对的，而且**可验证**：工具输出必须说清空集、L0 项目地图、审查器的刻度、语义检索的相似度下限——每一条都有断言守着，都能回归。而"换个大模型就好了"不在你的控制之内，也没法测。

## 配置

存在 Electron 的用户数据目录里（`config.json`），会话文件就在它旁边：

| 键 | 含义 |
|---|---|
| `ollamaBaseUrl` | Ollama 地址，默认 `http://127.0.0.1:11434` |
| `model` | 选中的模型 |
| `workdir` | 工具操作的目录（**只决定新建会话的默认值**；每个会话自己的目录写在会话头里） |
| `temperature` | 采样温度 |
| `maxTokens` | 单次输出上限。默认 8192——推理模型的 reasoning 和正文**共用这一份预算**，4096 会让它写满推理后连工具调用都发不出来 |
| `maxStepsPerTurn` | 单轮最大步数（一步 = 一次模型调用 + 它要求的工具） |
| `autoCompact` / `compactThresholdChars` | 是否自动压缩、超过多少字符触发 |
| `approvalRequiredFor` | 每次调用都要你确认的工具；空数组 = 全部放行 |
| `persona` | 称呼、自称、回答语气、追加的风格要求（会进系统提示词） |

## 安全

`bash` 会执行模型写出来的任何东西——这是本地 agent 的意义，也是这里最大的风险。缓解手段：

- `bash` 和写入类工具都是审批候选，加进 `approvalRequiredFor` 即可拦截
- 危险命令形状（`rm -rf`、`git push --force`、把下载内容管进 shell 等）**即使没勾选也一定弹确认**
- 文件工具的每个路径都过 `resolveToolPath()`：对最深的**已存在**祖先做 realpath，所以符号链接不能悄悄把你带出工作目录；工作目录之外的路径需要审批
- 渲染进程 `contextIsolation: true` + `nodeIntegration: false`

文件边界是**刻意留软**的（用户可以批准）——一个连自己 cwd 之外都碰不了的编码 agent 没什么用。

## 排错

以下每一条都是真实浪费过时间、所以记下来让它下次变便宜的坑。

**窗口开了但内容是白的。** Electron 里最具误导性的失败：崩溃的渲染进程和健康的渲染进程长得一样——外壳画出来了、内容空白、主进程什么都不打。`npm run check:render` 会告诉你到底是哪种。这里遇到过的三个原因：

- **preload 加载失败，`window.harness` 是 undefined。** Electron 用 `require()` 加载 preload，而本包 `"type": "module"`，require 一个 ESM 会抛 `ERR_REQUIRE_ESM`；桥没装上，`useHarness` 里的第一个 IPC 调用就抛错，整棵 React 树卸载，`#root` 变空。所以 preload 单独编成 `.cjs`，`finalize-preload.mjs` 断言它是自包含的，`check-core` 守着这两条性质。
- **CSP 挡住了内联脚本。** Vite 的 HMR client 是内联 `<script>`，而 `script-src 'self'` 会直接挡掉它，React 根本起不来。所以策略分模式注入（dev 允许 `'unsafe-inline'` 和 `ws:`，生产两者都不允许），由 `vite.config.ts` 里的插件完成——写死在 `index.html` 里一定会对其中一个模式是错的。
- **GPU 进程起不来，Electron 把自己杀了。** Chromium 会重试几次然后 `GPU process isn't usable. Goodbye.`，连窗口一起带走。**只加 `--disable-gpu` 没用**——GPU 进程照样启动、照样失败；`--in-process-gpu` 把它折进浏览器进程，没有独立进程可死。剩下的 `Unable to move the cache` / `Gpu Cache Creation failed` 是噪音。
  - 顺带一个性能后果：这条路径下 UI 走**软件光栅**，所以全屏 `backdrop-filter` 之类合成期特效是按 CPU 逐帧计价的（设置弹窗曾经因此只有 11fps，实测 p50 90ms → 去掉后 5ms）。

**安装类问题。** 中断的 `npm install` 可能留下一个只有 `package.json` 的目录；npm 认为这个包存在就永不重取，`check:load` 是唯一能发现它的检查（逐个 require）。`npm error Invalid Version:` 是 `package-lock.json` 里有 `version: null` 的条目——lockfile 是权威，删掉重装即可。Electron 二进制（约 110MB）下载失败可以用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。注意 `electron --version` 可能报的是系统里的那个，要看 `node_modules/electron/dist/version`。

**两个容易配置错的细节。** `tsconfig.main.json` 需要 `"DOM"`（主进程用了 `fetch`/`Response`）；两个项目都用 `NodeNext`，这才让 `./foo.js` 能解析到 `foo.ts`——换成 `"bundler"` 会让所有相对 import 报 TS2307。`build:main` 先删 `dist/{main,core,shared,preload}` 不是洁癖：旁边残留的 `dist/main/preload.js` 可能被优先加载，那是窗口变白的成因之一。

## License

MIT
