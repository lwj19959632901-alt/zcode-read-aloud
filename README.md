# read-aloud — 给 AI Agent 会话加一个「朗读」按钮

一个可嵌入 ZCode Gen UI 的**朗读按钮片段** + 一个**通用 CLI**：把当前会话上下文提取成纯文本，
然后无头朗读、生成带逐句高亮的按钮片段、枚举系统语音与会话列表。

```
read-aloud/
├── read-aloud.mjs        单文件 CLI + 片段生成器（dump / speak / widget / voices / sessions）
├── read-aloud.test.mjs   node:test 单测（35 条）
├── smoke_widget.py       Playwright + Chrome 真实浏览器冒烟
├── host-patch/           可选：ZCode 桌面端 asar 补丁（消息操作栏朗读按钮）
├── docs/demo.png         演示截图（占位，随首个 Release 补充）
├── LICENSE               MIT
└── README.md             本文件
```

## 演示

> 截图与演示说明见 Releases 页（`docs/demo.png` 占位，暂不放图）。

文字示意：按钮片段渲染在会话消息里，点击「朗读」后展开暂停 / 停止 / 倍速控件，
进度条与逐句高亮随朗读推进同步滚动。

```text
┌──────────────────────────────────────────────┐
│ [朗读] [暂停] [停止]  倍速 1.0x   ▮▮▮▮▯▯▯▯ 52% │
│  【用户】帮我总结这份文档的要点……              │
│  【助手】好的，第一点是……  ← 当前句高亮滚动    │
└──────────────────────────────────────────────┘
```

## 快速开始

前置：

- **Node 22+**（用到 `node:sqlite`；Node 22 下会打一条 `ExperimentalWarning`，属正常）
- **Windows 10/11**（默认 `sapi` 引擎依赖系统 `System.Speech`，并经 PowerShell 7 调用：
  `C:/Program Files/PowerShell/7/pwsh.exe`）
- 可选：`ffmpeg`（`--wav` 合并多块音频时用）、`pip install edge-tts`（`edge` 引擎用）

两条命令即刻出声：

```bash
# 1) 提取会话上下文 → 纯文本（角色标注 + 代码块占位）
node read-aloud.mjs dump --session <your-session-id> --out ctx.txt
#    不确定会话 id？先列一下最近的会话：
node read-aloud.mjs sessions
#    知道当前对话里的一句原文？用文本指纹直接定位（推荐，见「会话定位」）：
node read-aloud.mjs dump --session-by-text "<当前对话最近一条用户消息原文>" --out ctx.txt

# 2) 无头朗读（默认 sapi 引擎，离线零成本）
node read-aloud.mjs speak ctx.txt
```

生成朗读按钮片段：

```bash
node read-aloud.mjs widget ctx.txt --out read-aloud-context.html
# 或指定输出目录与标题：node read-aloud.mjs widget ctx.txt --vizdir <目录> --title my-context
```

在 ZCode 里以 `::visualize` 引用片段文件即可成为按钮：会话中发送一行
`::visualize{"path":"<片段文件的绝对路径>"}`，该片段就会作为内联卡片渲染在消息里。

## 子命令与参数

取值型参数（`--voice` / `--rate` / `--last` / `--max-chars` / `--title` / `--session` / `--vizdir` 等）
缺值时当场报错（退出码 2），不会把 `true` 泄漏进命令行。

### `dump` — 从 db.sqlite 提取会话上下文 → 纯文本

```bash
node read-aloud.mjs dump [--session ID | --session-by-text 指纹] [--session-by-text-limit N] [--last N] [--max-chars N] [--out 文件] [--db 路径]
```

| 参数 | 说明 |
| --- | --- |
| `--session <id>` | 指定会话；不传则取 `time_updated` 最新**且排除 `sess_subagent_*` / `sess_dwf-*` 前缀**的会话（库内存在大量 agent 内部派生会话，不排除会取错） |
| `--session-by-text <指纹>` | **文本指纹定位会话**：在最近 N 个主会话（默认 10，同样排除 `sess_subagent_*` / `sess_dwf-*`）里搜**真实用户消息**（`role='user'` + `part.type='text'` + 非合成注入）正文是否含该子串。与 `--session` **互斥**（两个都给直接报错）。唯一命中→用它；零命中→退出码 2 报「指纹未命中任何会话」并给三步补救；多命中→退出码 2 并**列出全部候选**（id + 标题 + 时间），提示用 `--session` 明确指定。**大小写敏感**（普通子串匹配，不做模糊/归一化） |
| `--session-by-text-limit N` | 指纹搜索的候选会话数，默认 10 |
| `--last N` | 取最后 N 条**消息**（并块前的条数，不是并块后的块数） |
| `--max-chars N` | 默认 12000，超出截断；截断说明只进 stderr 摘要，不进正文（否则会被 widget/speak 当正文念出来） |
| `--out <文件>` | 落盘（默认 stdout）；摘要信息一律走 stderr，stdout 保持纯净可管道 |
| `--db <路径>` | 默认 `~/.zcode/cli/db/db.sqlite` |

行为细则：

- `db.sqlite` **一律 `readOnly` 打开**、单次查询、零写入。
- 排序 `message.sequence` + `part.sequence`（`part.sequence` 是消息内计数，不是全局序号）。
- 只取 `part.type === "text"`；`reasoning` / `tool` / `timeline` / `step-*` 不入朗读。
- **合成消息过滤（硬性）**：同时检查 `message.data` 与 `part.data`，命中任一条即整条排除（判别式见下文「工作原理」）。
- 代码块 → 「（代码略）」；未闭合围栏把剩余全部当代码。
- **空结果不静默**：`--session` 指定不存在的 id、或过滤后 0 条可朗读消息时，退出码 2 并在 stderr
  报错——rc=0 + 空输出会把「取错会话」扮成成功。
- 连续的同类角色消息**合并为一个展示块**；`--last N` 的 N 按**并块前的消息条数**计
  （先切后并——否则合成消息被滤掉后多条助手消息并成 1 块，`--last 6` 会退回全量）。
  stderr 摘要同时报消息数与并块后的块数，例如 `消息 6/23 条（并块后 1 块）`。
- 输出格式：每条消息首行 `【用户】` / `【助手】` 前缀，消息间空行。正文里若出现以 `【` 开头的行，
  写盘时加零宽空格（U+200B）转义、读盘时剥掉，`formatDump` / `parseDump` 往返无损。

### 会话定位：指纹法 vs 显式 `--session`（**绝不依赖默认会话**）

默认解析取的是「`time_updated` 最新的主会话」。**多窗口并行时它会静默取到另一个窗口的会话**——
本机实测：当前对话在 `sess_<当前窗口>`，不带 `--session` 的 `dump` 取到的是并行窗口的
`sess_<并行窗口>`（llm-distill 会话），**不报错、不提示**。这类「取错会话」比报错更危险：
朗读/渲染出来的是另一个窗口的内容。

两种可靠定位法：

| 方式 | 命令 | 适用 |
| --- | --- | --- |
| 文本指纹（推荐，自动化场景） | `node read-aloud.mjs dump --session-by-text "<当前对话最近一条用户消息原文>"` | 拿当前对话原文当指纹；唯一命中即确定 |
| 显式 id | `node read-aloud.mjs dump --session <id>` | 已经知道 id（`sessions` 列表里有） |

用法纪律：

1. **先解析出 id，后续每条 dump 都显式带 `--session <id>`**，不要指望默认值一直对。
2. 指纹**零命中**＝指纹没落在候选集里的真实用户消息上。按三步补救，**顺序别换**：
   ① **原样重试一次**（会话可能刚落盘、还没进库）；
   ② 加 `--session-by-text-limit 50` **扩大候选集**（真因通常是「会话不在最近 10 个里」）；
   ③ 才换更短的指纹片段重试（真因是指纹写错/大小写不对）。
   —— 顺序反了会一直在「换指纹」上打转，而真因是会话不在候选集。
3. 指纹**多命中**＝指纹太短/太常见（多个会话都有）。CLI 会列出全部候选
   （会话 id + 标题 + 最近更新时间），**从候选里挑一个并显式 `--session` 指定**，不要猜。
4. 指纹匹配**大小写敏感**；命中判定必须同时满足三条，缺一不可：
   - `part.data.type === 'text'`（`reasoning` / `tool` 里复述的原文不算）；
   - 消息与 part **都不是合成注入**（`synthetic` / `visibility:'model-only'` / `runtimeMessage.source`
     一律排除——宿主注入块在本机散布于上千个会话里，不滤会伪多命中，
     更危险的是「当前会话不在候选集 + 恰好只有一个别的候选只在合成块里命中」时**唯一命中且静默取错会话**）；
   - 消息 `role === 'user'`（真实用户消息）。
5. `--session` 与 `--session-by-text` **互斥**，同时给直接报错（退出码 2）。

### `sessions` — 列最近会话

```bash
node read-aloud.mjs sessions [--last N] [--db 路径]
```

输出 `时间 / 会话 id / 标题`，同样排除 `sess_subagent_*` / `sess_dwf-*` 前缀，便于选 `--session`：

```text
$ node read-aloud.mjs sessions
最近会话（已排除 sess_subagent_* / sess_dwf-* 前缀的内部会话）：
  2026-10-31 12:00:00  <your-session-id>  帮我写一个 XX 脚本
  2026-10-30 21:30:00  <your-session-id>  调研 YY 方案
```

### `speak` — 无头朗读

```bash
node read-aloud.mjs speak <文本文件> [--engine edge|sapi|minimax] [--voice 名字] [--rate -10..10] [--wav out.wav] [--dry-run] [--llm 路径]
```

| 参数 | 说明 |
| --- | --- |
| `--engine` | `edge`（默认，在线神经音色，不可用时自动回落 `sapi` 并提示）/ `sapi`（离线）/ `minimax`（套餐内，消耗额度） |
| `--voice <名字>` | edge 音色名（全名如 `zh-CN-YunxiNeural` 或短名如 `yunxi`）；sapi 为子串匹配（默认 `Microsoft Huihui` → `Yaoyao` → `Kangkang` → 第一个 zh-CN） |
| `--rate <-10..10>` | 语速；edge 映射成 `--rate=±X%`，sapi 为 SAPI Rate |
| `--wav <路径>` | 只落盘不播音：每块一个 wav，ffmpeg concat 合并 |
| （不给 --wav） | 直接出声（edge 经 ffmpeg 转 wav 后 PlaySync 播放；sapi 直调 System.Speech）；Ctrl+C 可中断 |
| `--dry-run` | 只打印将执行的命令/参数，不发声 |
| `--llm <路径>` | `minimax` 引擎的 TTS 包装脚本入口（默认尝试 `~/.zcode/skills/local-ai/llm.mjs`，可指向任意 OpenAI 兼容的等效脚本） |

### `widget` — 生成内联 HTML 片段

```bash
node read-aloud.mjs widget <文本文件> (--out <文件> | --vizdir <目录> [--title 标题])
```

`--vizdir` 时输出 `<vizdir>/read-aloud-<title>.html`（默认 title `context`）。
**`--out` 与 `--vizdir` 至少给一个**：不接受 cwd 相对默认路径，避免把片段写丢。
片段超 1MB 直接报错（请调小 `--last` / `--max-chars`）。

片段形态（复刻 DeepSeek 消息操作栏的「朗读」）：

- 「朗读」主按钮（`volume-2` 图标 + `data-tooltip="朗读"` + `aria-pressed`），激活后展开 **暂停 / 停止 / 倍速选择**。
- 进度条 + 原文逐句高亮（当前句 `--accent` 高亮、已读句 `--muted-foreground` 淡出）；
  `aria-valuenow` 随朗读推进同步更新（屏幕阅读器可感知进度），停止归零、完成置 100。
- transcript 容器 `max-height: 360px; overflow: auto`，高亮句 `scrollIntoView({ block: 'nearest' })`——
  **不靠全展开**（12k 字符全展开会超宿主 10,000px 帧高上限）。
- 引擎：浏览器 `speechSynthesis`；句子分块顺序朗读；处理 `voiceschanged` 异步加载；
  **无中文语音时按钮禁用并给可见提示**。
- 状态读写双侧：加载时读 `window.zcode.widgetState.privateContent.rate` 并监听 `zcode:set_globals` 应用倍速偏好；
  倍速变更时 `setWidgetState({ modelContent: null, privateContent: { rate } })`；**加载时与状态事件不写**。

片段硬约束（宿主 visualize 渲染要求，全部在单测里断言）：仅 fragment（无 doctype/html/head/body）、
根节点唯一 id + `getElementById` 选取、禁 fetch/XHR/WebSocket、<1MB、主题变量 + 宿主 utility 类、
lucide `data-lucide` 图标（无内联 SVG）、内联脚本 vm-safe。

### `voices` — 列语音

```bash
node read-aloud.mjs voices
```

先列 SAPI 已装语音（标注 zh-CN），再列 edge-tts 在线神经音色（标注默认/推荐）；
并说明与浏览器 `speechSynthesis` 语音表的差异（见下节）。

## 引擎矩阵

| 引擎 | 依赖 | 成本 | 说明 |
| --- | --- | --- | --- |
| `edge` | `edge-tts` CLI（`pip install edge-tts`） | 免费需联网 | **默认**。中文神经音色（晓晓/云希/云扬等 8 个）；不可用时自动回落 `sapi` |
| `sapi` | Windows `System.Speech`（PowerShell 7 全路径调用） | 离线零成本 | Node 侧分块 → UTF-8 无 BOM 文件 → PS7 `Get-Content -Raw -Encoding utf8` 读 → 逐块 `Speak()` |
| `minimax` | MiniMax 订阅 + TTS 包装脚本（默认尝试 `~/.zcode/skills/local-ai/llm.mjs`，`--llm` 可指定任意 OpenAI 兼容等效脚本） | 取决于所用订阅 | 提质可选项，须显式 `--engine minimax`（**消耗订阅额度**） |

## 正式插件：read-aloud v1.0.0（ZCode 侧栏面板）

同一套 dump / 分块逻辑的第二个交付形态：**ZCode 常驻侧栏面板插件**，装进本地市场 `read-aloud-local`，与 CLI、内联片段并存（三者互不替代）。

| 项 | 值 |
| --- | --- |
| 插件 id / 版本 | `read-aloud@read-aloud-local` / `1.0.0`（serverInfo `read-aloud`，protocolVersion `2025-06-18`） |
| 市场源目录 | `marketplace-local/read-aloud/`（manifest `.zcode-plugin/plugin.json`） |
| 宿主安装副本 | `~/.zcode/cli/plugins/cache/read-aloud-local/read-aloud/1.0.0/`（宿主执行的是这份**拷贝**，不是源码目录） |
| 面板 | surface id `read-aloud`，资源 `ui://read-aloud/panel.html`，`availability:"session"`，CSP `connectDomains:[]` |
| MCP 工具（4） | `speak_session`（dump+分块，不含音频）/ `speak_chunk`（逐块 base64，**仅面板可见**）/ `list_voices` / `session_info` |
| userConfig（4） | `pythonPath` / `defaultVoice` / `maxChars`（默认 12000，0=不限制，服务端硬顶 200000）/ `dbPath` |
| 插件级命令 / 技能 | `/read-aloud-panel`、技能 `read-aloud-panel`（与用户级 `/read-aloud`、技能 `read-aloud` 故意错开） |
| 宿主注册 | `installed_plugins.json` + `known_marketplaces.json` + `config.json`（`enabledPlugins`）+ `marketplaces/read-aloud-local/marketplace.json` 快照（细节见 `666/INTEGRATION.md` 同条登记） |

### 面板与 CLI 分工

| 维度 | 侧栏面板插件（1.0.0） | CLI / 内联片段 |
| --- | --- | --- |
| 入口 | 侧栏「朗读」面板；模型可调 `speak_session` | `node read-aloud.mjs …`；`/read-aloud` 命令；`::visualize` 按钮片段 |
| 会话定位 | `_meta.sessionId` → 显式 `sessionId` → 最新主会话（`sessionSource` 回传 `meta`/`arg`/`fallback-latest`，fallback 时面板显示实际 id） | `--session` / `--session-by-text` 显式定位（**不依赖默认会话**） |
| 引擎 | edge 主 + **SAPI 兜底**（见下节） | `edge` 默认 → 自动回落 `sapi`；`minimax` 需显式 `--engine minimax` |
| 音色 | 8 个中文 edge 神经音色（面板下拉） | `voices` 列 SAPI 系统语音 + edge 8 音色 |
| 播放形态 | 面板内逐块播放，进度/高亮/停止 | 无头出声、或 `--wav` 落盘合并 |
| 成本 | 免费（edge 需联网） | 免费；`sapi` 离线零成本；`minimax` 消耗订阅额度 |

### 双引擎矩阵：edge 主，SAPI 兜底

| 场景 | `edge` | `sapi`（离线兜底） |
| --- | --- | --- |
| 面板 `speak_chunk` | 正常路径：mp3 → `data:audio/mpeg` | **edge 合成失败即自动回退**：PS7 `System.Speech` 写 wav → `data:audio/wav`，响应 `engine:"sapi"`；SAPI 再失败则报「edge 失败 + SAPI 兜底失败」双错 |
| CLI `speak`（默认） | 首选 | 仅**引擎不可用**类错误自动回落（未装 `edge-tts`/启动失败、`edge-tts` 退出码非 0（含网络失败）、缺 `ffmpeg`）；显式 `--engine edge` 时 fail-closed 不回落 |
| 音色映射 | 8 个中文神经音色（`--voice` 全名/短名） | `sapiVoiceHint` 按性别就近：男声 4 个 → `Kangkang`，其余 → `Huihui`；PS 侧找不到则用系统默认音色 |
| 依赖 | Python + `edge_tts` + 联网 | Windows + PowerShell 7 全路径（`C:/Program Files/PowerShell/7/pwsh.exe`） |
| 缓存 | `<sha256>.mp3` | `<sha256>.wav`（命中直接复用；edge 恢复后下次仍先试 edge） |

> 说明：面板当前**不单独提示**已回退 SAPI（响应里有 `engine` 字段，UI 未展示）；音色下拉仍是 edge 名，SAPI 侧按性别就近映射。本节的 SAPI 兜底以**源码目录**为准——宿主 `cache` 里的已安装副本可能滞后于源码，更新需按文末「更新提示」回拷后重启。

### 停止语义

- **面板**：停止 = `Audio.pause()` + `runId++`（在途响应与预取缓存按 `runId` 校验后丢弃，不再发新块）。面板**不发取消信号**，服务端已启动的合成不会被停止打断（只有超时才 SIGKILL：edge 120s / SAPI 60s）；单块 ≤120 字、最坏约 20-30 秒，该块会合成完落进磁盘缓存后静默丢弃（无害，下次命中缓存）。
- **CLI**：无 `--wav` 时 Ctrl+C 可中途停（`stdio: 'inherit'` 直通）；`--wav` 时正在合成的那块不在 `manifest.txt` 里，不参与合并（其 wav 头未 finalize），已完成的块仍可合并。

### 倍速上限

| 面板档位 | 传给 edge 的 `--rate` | 实际效果 |
| --- | --- | --- |
| 0.5× | -50% | 慢一半 |
| 0.75× | -25% | — |
| 1× | +0% | 原速 |
| 1.25× | +25% | — |
| 1.5× | +50% | edge-tts **上限** |
| 2× | +50% | **与 1.5× 同效**（UI 选项保留，提示行注明） |

CLI 的 `--rate` 范围 `-10..10`，按 5 的步长映射到同一组百分比（-10→-50%、0→+0%、10→+50%）；越界钳制。SAPI 兜底时同一 `-10..10` 步进值直接作 `System.Speech.Rate`（整数档，非百分比）。

> 更新提示：改 `marketplace-local/read-aloud/` 源码**不会**自动生效——宿主跑的是 cache 副本，更新后需回拷到 installPath 并完整重启 ZCode；注册三件套与陷阱见 `666/INTEGRATION.md`「新登记：read-aloud v1.0.0 正式插件」。

## 已知坑位（实测踩过的）

| 坑 | 现象 | 对策 |
| --- | --- | --- |
| **widget 文件名前缀** | `--vizdir <目录>` 的产物名是 `read-aloud-<title>.html`，不是 `<title>.html` | 想要 `read-aloud-context.html` 就传 `--title context`（默认 title 已经是 `context`，但显式写更省心）；`--out` 则是原样文件名，不加前缀 |
| **PS7 必须全路径** | 用短名 `pwsh` 会解析到 WindowsApps 的应用别名桩（85 字节），**静默失败**（计划任务里尤其容易踩） | 一律用 `C:/Program Files/PowerShell/7/pwsh.exe`（CLI 里已硬编码这个全路径） |
| **`minimax` 消耗额度** | `--engine minimax` 走 local-ai 的 `llm.mjs tts`，属**套餐内**调用，但**会消耗订阅额度** | 默认引擎是在线神经音色 `edge`；只在确实需要提质时显式 `--engine minimax` |
| **`edge` 不可用自动回落** | 未装 `edge-tts`（或联网失败）时 | 自动回落离线 `sapi` 并 stderr 提示（已装 edge-tts 时默认引擎就是它）；想强制离线用 `--engine sapi` |
| **默认会话会取错** | 多窗口并行时，不带 `--session` 的 `dump` 取到另一个窗口的会话且不报错 | 用 `--session-by-text` 指纹定位或显式 `--session`，详见「会话定位」一节 |
| **`speak` 只吃文件** | 没有直传文本 / stdin 的入口 | 正文先写进文件（**绝对 Windows 路径**，Git Bash 里的 `/tmp/...` 会被 MSYS 改写）再 `speak <文件>` |
| **PowerShell 单元素数组退化** | `ConvertFrom-Json` 对**单元素** JSON 数组会摊平成标量，`$chunks[0]` 取到的是**第一个字符**——只念一个字，退出码还是 0（静默坏） | 解析 JSON 数组一律用 `@(...)` 包住（`$chunks = @(… \| ConvertFrom-Json)`），保证数组语义；本仓的 PS 脚本已按此写并有单测回归 |

## 设计说明

### 文本经文件传递（及仅有的两个 argv 例外）

设计原则：**正文一律经文件传递，不经命令行**，规避 Windows 引号/编码坑。
`sapi` 的正文一律经 UTF-8 **无 BOM** 文件传递（node 的 `writeFileSync(...,'utf8')` 不带 BOM），
PS7 侧 `Get-Content -Raw -Encoding utf8` 读取。

**书面例外：`minimax` 与 `edge` 两个引擎的分块都经 argv 传递**——两者的 CLI 都只收
位置参数（`llm.mjs tts <文本>`）或 `--text`（`edge-tts --text <文本>`），均没有 stdin/文件模式。
这就是把分块压小的原因：minimax ≤3000 字、edge ≤120 字，都在 Windows 命令行安全区内。

### 句子分块策略

先按中英文句末标点切（标点留在前块，连续 `…！？` 不切以免孤儿块），
超长块（sapi/edge 120 字 / minimax 3000 字）按逗号、空格等软边界二次切分，仍超才硬切；**不产生空块**。

### `--wav` 语义与中断有效性

- `SetOutputToWaveFile` **只落盘不播音**（实测确认）；每块一个 `chunk_NNN.wav`，ffmpeg concat 合并。
- 每块合成成功后，PS 侧把该 wav 路径追加进 `manifest.txt`；Node 只合并 manifest 里的块。
- **Ctrl+C 中断时，正在合成的那一块不在 manifest 里**（其 wav 头未 finalize，合并会吃到损坏音频），
  因此不会被合并；已干净结束的块仍可合并。Node 侧还会再校验每个 wav 的 RIFF 头与 data 尺寸，残缺块跳过并告警。
- 无 `--wav` 时直接发声，Ctrl+C 可中途停（`stdio: 'inherit'` 直通）。

### SAPI 与浏览器语音表的差异

同一套 Windows 语音在不同暴露面的可见数量不同：SAPI 面（`System.Speech`）通常能看到全部安装的
zh-CN 语音（含 `Microsoft Huihui Desktop` 这类变体），而无头 Chrome 的 `speechSynthesis` 只暴露其中
一部分（实测 3 个 zh-CN）。片段走浏览器 `speechSynthesis`，**无法联网，只能用系统已装语音**（质量有限）；
想要神经级音色请走 CLI 的默认引擎 `edge`（`pip install edge-tts` 即可，中文 8 音色，`--voice` 可换）。

## 工作原理：dump 的合成消息过滤

AI Agent 会话库里混着大量**非对话内容**：系统提示词、deferred tools 清单、运行时注入的提示等。
不过滤的话，朗读出来的第一条就是几千字符的系统提示词，真实对话反而被淹没——
在一条含 25 条 text part 的会话里实测，有 14 条属于这类（约 96k 字符），真实对话只剩约 1.4k 字符。

`dump` 在读取时同时检查 `message.data`（消息级）与 `part.data`（part 级）两个层级，
**命中以下任一条判别式即整条排除**：

1. `synthetic === true` —— 显式标记的合成消息；
2. `metadata.visibility === 'model-only'` —— 标注为只给模型看的内容；
3. `metadata.runtimeMessage.source` —— 带运行时来源标记的注入消息（系统提示词、工具清单等运行时数据）。

三个判别式是「或」的关系、双层级生效，宁多滤不漏滤；`sessions` 子命令同理还会按会话 id 前缀
排除 agent 内部派生会话（`sess_subagent_*` / `sess_dwf-*`），避免默认解析取错会话。

## 宿主补丁（可选）

`host-patch/` 是给 **ZCode 桌面端**用的 asar 补丁：往 `app.asar` 入口追加一行 dynamic import
（主进程起本机 HTTP 桥），再把 🔊 按钮插到每条助手回复的消息操作栏里（流式 edge-tts，
断网降级系统语音）。安装、卸载、排障与自检见 [`host-patch/README.md`](host-patch/README.md)。

风险须知：

- **官方升级会整包替换 `app.asar`**，注入行随之消失、按钮不见 —— 升级后重跑 `install.ps1` 即可；
- 安装 / 卸载都要求**完全退出 ZCode**（含托盘/后台进程），工具检测到运行中会直接拒绝；
- **仅适用于 Windows + ZCode 桌面端**；卸载只剥离注入行（strip-only），不会用旧备份覆盖 asar。

## 测试与验收

```bash
node --check read-aloud.mjs
node --check read-aloud.test.mjs
node --test read-aloud.test.mjs        # 35 条全绿
```

手动冒烟（Windows）：

```bash
node read-aloud.mjs dump --session <your-session-id> --out ctx.txt
node read-aloud.mjs voices                                          # 应列出若干 zh-CN 语音
node read-aloud.mjs speak ctx.txt --engine sapi --wav out.wav       # 需 ffmpeg 才会合并
node read-aloud.mjs widget ctx.txt --out button.html
```

### 单块合成验收（PowerShell 单元素数组退化回归）

**这是必跑的一条**：单块（只有一句）时 `ConvertFrom-Json` 会把单元素数组摊平成标量，
`$chunks[0]` 只取到第一个字符——只念一个字、退出码还是 0（静默坏）。
判据：**控制台打出完整句子** + **wav 时长 ≥ 2s**（14 字以上单句）。
真 PowerShell 实跑（不真出声，落盘验时长）：

```bash
# ① 造一个 18 字的单句（只有一块 → 走单元素数组那条路）
#    路径必须写绝对 Windows 路径：Git Bash 里 $TEMP 是 /tmp（MSYS 路径），会被改写
printf '【用户】这是一句用于验收的中文朗读测试文本。\n' > "C:/Users/<用户名>/AppData/Local/Temp/ra-single.txt"
# ② 真实 PS7 合成到 wav（只落盘不播音）
node read-aloud.mjs speak "C:/Users/<用户名>/AppData/Local/Temp/ra-single.txt" --wav "C:/Users/<用户名>/AppData/Local/Temp/ra-single.wav"
# ③ 看控制台：必须是完整句子，不能只有第一个字
#    [1/1] 这是一句用于验收的中文朗读测试文本。
#    speak: sapi 已合成 1 块 → …（4.36 秒）
```

wav 时长用 WAV 头算（`dataSize / byteRate`）或 `ffprobe -show_entries format=duration`：

```bash
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 "C:/Users/<用户名>/AppData/Local/Temp/ra-single.wav"
```

实测基线（2026-11-01，PS 7 + `Microsoft Huihui Desktop`）：控制台 `[1/1] 这是一句用于验收的中文朗读测试文本。`，
wav **4.36 秒**（退化版本是 `[1/1] 这` + 1.12 秒）。单测里有 `@()` 包裹的模板回归断言，
但**真实 PS 合成仍需手跑一次**——模板断言挡不住 PS 解释器语义变化。

真实浏览器冒烟（可选）：`smoke_widget.py` 用 Playwright + Chrome 加载一个**把片段包进沙箱 iframe**
的 standalone HTML（应用内由 `::visualize` 渲染管线生成这一步），断言 DOM 标记齐全、无
fetch/XHR/WebSocket、`speechSynthesis` 有 zh-CN 语音、点朗读后 `onend` 真实触发且高亮推进、
倍速写入 `window.zcode` 状态、停止后 `cancel` 被调用：

```bash
pip install playwright && playwright install chrome   # channel="chrome"
python smoke_widget.py <standalone.html>
```

单测覆盖：dump 提取（排序/角色/代码略/`--last`/`--max-chars`/消息级与 part 级合成标记过滤/内部会话前缀过滤）、
**会话指纹定位**（唯一命中选中正确会话 / 与 `--session` 互斥 / 零命中报错 / 多命中报错并列候选 /
合成注入与助手消息不参与匹配 / 更旧会话也能命中）、`sessions` 输出三列格式、
**PS 分块清单 `@()` 包裹回归**（单元素数组退化）、
句子分块器（中文标点/超长二次切分/无空块）、widget 生成（HTML 转义/根 id/无 fetch/XHR/内联脚本 `node --check`）、
`speak --dry-run` 命令构造（sapi/minimax）、spawn 失败 fail-closed（注入 mock spawnSync，不真调 PS7）、
取值型参数缺值报错、wav 头解析、voices 选择，
以及 **widget 交互冒烟**（vm 沙箱 + fake DOM + fake speechSynthesis：点朗读 → 逐句 `onend`
→ 高亮推进 → 全队列完成（含 `aria-valuenow` 同步）；停止 → `cancel` 且不再 `speak`；无 `speechSynthesis` 时按钮禁用 + 提示；
倍速偏好读写双侧）。fake DOM 与 fake speechSynthesis 全部手写，不引第三方库。

## 已知限制

- **vm 冒烟抓不到真实浏览器怪癖**：`cancel()` 后立即 `speak()` 的竞态、超长 utterance 被丢弃、
  无音频环境不发声。对策是 Playwright 冒烟作真实浏览器关卡（实测无头 Chrome 3 个 zh-CN，
  `speak()→onend` 正常触发）。
- **`parseDump` 的角色标记有理论歧义**：正文行若以 `【用户】`/`【助手】` 开头，写盘时会插零宽空格转义，
  往返无损；但若用户手写文本文件喂给 `widget`/`speak` 且含这类行首，可能被误判成新消息块。
- **语音异步加载**：个别浏览器 `getVoices()` 首次返回空，按钮会先禁用，`voiceschanged` 到达后恢复；
  点击「朗读」时也会再探测一次。
- **`speak()` 抛异常的环境**（无音频设备等）：片段会降级提示并收起控件，不会卡在「朗读中」；
  此时用 CLI 的 `sapi` 引擎（`SetOutputToWaveFile` 不依赖播放设备）兜底。
- **`--wav` 中断语义**：见上节，只有干净结束的块会进合并结果。
- **`node:sqlite` 在 Node 22 仍是实验特性**，加载时打 `ExperimentalWarning`；CLI 与单测都只针对
  SQLite 这条静音，其余警告照旧。
- 片段按宿主 visualize 渲染约束设计（沙箱 iframe、无网络、主题变量）；移植到其它宿主时需自行确认对应约束。

## 致谢

- [MichaelPGifford/claude-read-aloud](https://github.com/MichaelPGifford/claude-read-aloud)（MIT）——
  句子分块朗读、代码块念「（代码略）」、约 1.2 万字符上限、voice 可插拔的设计参考。
- [rany2/edge-tts](https://github.com/rany2/edge-tts) —— `edge` 引擎依赖的在线 TTS CLI。
- DeepSeek 官方 App 的消息「朗读」按钮 —— 片段交互形态的设计原型。

本仓库代码为独立实现，未复制上述项目代码。

## 许可证

[MIT](./LICENSE) © 2026 lwj19959632901-alt
