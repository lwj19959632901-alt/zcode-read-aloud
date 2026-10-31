# read-aloud — 给 AI Agent 会话加一个「朗读」按钮

一个可嵌入 ZCode Gen UI 的**朗读按钮片段** + 一个**通用 CLI**：把当前会话上下文提取成纯文本，
然后无头朗读、生成带逐句高亮的按钮片段、枚举系统语音与会话列表。

```
read-aloud/
├── read-aloud.mjs        单文件 CLI + 片段生成器（dump / speak / widget / voices / sessions）
├── read-aloud.test.mjs   node:test 单测（33 条）
├── smoke_widget.py       Playwright + Chrome 真实浏览器冒烟
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
| `--session-by-text <指纹>` | **文本指纹定位会话**：在最近 N 个主会话（默认 10，同样排除 `sess_subagent_*` / `sess_dwf-*`）里搜 `part.data.type=='text'` 的正文是否含该子串。与 `--session` **互斥**（两个都给直接报错）。唯一命中→用它；零命中→退出码 2 报「指纹未命中任何会话」；多命中→退出码 2 并**列出全部候选**（id + 标题 + 时间），提示用 `--session` 明确指定。**大小写敏感**（普通子串匹配，不做模糊/归一化） |
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
本机实测：当前对话在 `sess_6002fc29`，不带 `--session` 的 `dump` 取到的是并行窗口的
`sess_2fe7a446`（llm-distill 会话），**不报错、不提示**。这类「取错会话」比报错更危险：
朗读/渲染出来的是另一个窗口的内容。

两种可靠定位法：

| 方式 | 命令 | 适用 |
| --- | --- | --- |
| 文本指纹（推荐，自动化场景） | `node read-aloud.mjs dump --session-by-text "<当前对话最近一条用户消息原文>"` | 拿当前对话原文当指纹；唯一命中即确定 |
| 显式 id | `node read-aloud.mjs dump --session <id>` | 已经知道 id（`sessions` 列表里有） |

用法纪律：

1. **先解析出 id，后续每条 dump 都显式带 `--session <id>`**，不要指望默认值一直对。
2. 指纹**零命中**＝指纹不在最近 10 个主会话里（或写法与原文不一致），换个更短的片段重试。
3. 指纹**多命中**＝指纹太短/太常见（多个会话都有）。CLI 会列出全部候选
   （会话 id + 标题 + 最近更新时间），**从候选里挑一个并显式 `--session` 指定**，不要猜。
4. 指纹匹配**大小写敏感**，且只认 `type=='text'` 的 part——`reasoning` / `tool` 里复述的原文不算命中。
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
node read-aloud.mjs speak <文本文件> [--engine sapi|minimax|edge] [--voice 名字] [--rate -10..10] [--wav out.wav] [--dry-run] [--llm 路径]
```

| 参数 | 说明 |
| --- | --- |
| `--engine` | `sapi`（默认）/ `minimax` / `edge` |
| `--voice <子串>` | 子串匹配语音名；不传按 `Microsoft Huihui` → `Yaoyao` → `Kangkang` → 第一个 zh-CN |
| `--rate <-10..10>` | SAPI 语速 |
| `--wav <路径>` | 只落盘不播音：每块一个 wav，ffmpeg concat 合并 |
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

### `voices` — 列 SAPI 语音

```bash
node read-aloud.mjs voices
```

标注 zh-CN，并说明与浏览器 `speechSynthesis` 语音表的差异（见下节）。

## 引擎矩阵

| 引擎 | 依赖 | 成本 | 说明 |
| --- | --- | --- | --- |
| `sapi` | Windows `System.Speech`（PowerShell 7 全路径调用） | 离线零成本 | **默认**。Node 侧分块 → UTF-8 无 BOM 文件 → PS7 `Get-Content -Raw -Encoding utf8` 读 → 逐块 `Speak()` |
| `minimax` | MiniMax 订阅 + TTS 包装脚本（默认尝试 `~/.zcode/skills/local-ai/llm.mjs`，`--llm` 可指定任意 OpenAI 兼容等效脚本） | 取决于所用订阅 | 提质可选项，须显式 `--engine minimax` |
| `edge` | `edge-tts` CLI（`pip install edge-tts`） | 免费需联网 | 未安装则退出码 2 并给安装提示 |

## 已知坑位（实测踩过的）

| 坑 | 现象 | 对策 |
| --- | --- | --- |
| **widget 文件名前缀** | `--vizdir <目录>` 的产物名是 `read-aloud-<title>.html`，不是 `<title>.html` | 想要 `read-aloud-context.html` 就传 `--title context`（默认 title 已经是 `context`，但显式写更省心）；`--out` 则是原样文件名，不加前缀 |
| **PS7 必须全路径** | 用短名 `pwsh` 会解析到 WindowsApps 的应用别名桩（85 字节），**静默失败**（计划任务里尤其容易踩） | 一律用 `C:/Program Files/PowerShell/7/pwsh.exe`（CLI 里已硬编码这个全路径） |
| **`minimax` 消耗额度** | `--engine minimax` 走 local-ai 的 `llm.mjs tts`，属**套餐内**调用，但**会消耗订阅额度** | 默认引擎是离线零成本的 `sapi`；只在确实需要提质时显式 `--engine minimax` |
| **`edge` 未装即降级** | 本机没装 `edge-tts` | 调 `--engine edge` 直接退出码 2 并给安装提示（`pip install edge-tts`）；不影响默认 `sapi` |
| **默认会话会取错** | 多窗口并行时，不带 `--session` 的 `dump` 取到另一个窗口的会话且不报错 | 用 `--session-by-text` 指纹定位或显式 `--session`，详见「会话定位」一节 |
| **`speak` 只吃文件** | 没有直传文本 / stdin 的入口 | 正文先写进文件（**绝对 Windows 路径**，Git Bash 里的 `/tmp/...` 会被 MSYS 改写）再 `speak <文件>` |

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
一部分（实测 3 个 zh-CN）。片段走浏览器 `speechSynthesis`，所以可选语音比 CLI 的 `sapi` 引擎少；
CLI 的 `sapi` 引擎直调 `System.Speech`，可用全部 SAPI 面语音。

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

## 测试与验收

```bash
node --check read-aloud.mjs
node --check read-aloud.test.mjs
node --test read-aloud.test.mjs        # 33 条全绿
```

手动冒烟（Windows）：

```bash
node read-aloud.mjs dump --session <your-session-id> --out ctx.txt
node read-aloud.mjs voices                                          # 应列出若干 zh-CN 语音
node read-aloud.mjs speak ctx.txt --engine sapi --wav out.wav       # 需 ffmpeg 才会合并
node read-aloud.mjs widget ctx.txt --out button.html
```

真实浏览器冒烟（可选）：`smoke_widget.py` 用 Playwright + Chrome 加载一个**把片段包进沙箱 iframe**
的 standalone HTML（应用内由 `::visualize` 渲染管线生成这一步），断言 DOM 标记齐全、无
fetch/XHR/WebSocket、`speechSynthesis` 有 zh-CN 语音、点朗读后 `onend` 真实触发且高亮推进、
倍速写入 `window.zcode` 状态、停止后 `cancel` 被调用：

```bash
pip install playwright && playwright install chrome   # channel="chrome"
python smoke_widget.py <standalone.html>
```

单测覆盖：dump 提取（排序/角色/代码略/`--last`/`--max-chars`/消息级与 part 级合成标记过滤/内部会话前缀过滤）、
**会话指纹定位**（唯一命中选中正确会话 / 与 `--session` 互斥 / 零命中报错 / 多命中报错并列候选）、
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
