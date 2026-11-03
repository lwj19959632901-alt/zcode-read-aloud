# read-aloud 插件

朗读当前会话的 ZCode 插件：常驻侧栏面板 + edge-tts 神经音色（8 个中文音色可选），逐块合成播放，支持音色/倍速/进度高亮/停止。

## 安装

插件通过本地市场安装（`marketplace-local`）。安装后在侧栏面板切换器出现「朗读」面板。

## userConfig

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `pythonPath` | string | "" | edge-tts 的 Python 解释器全路径。留空则在 PATH 中查找（依次尝试 python / python3 / py，逐个验证 --version 可用）。 |
| `defaultVoice` | string | "" | 8 个中文 edge 神经音色之一（如 zh-CN-XiaoxiaoNeural / yunxi）。留空用 zh-CN-XiaoxiaoNeural。 |
| `maxChars` | number | 12000 | 会话文本超过此值按块边界截断。0 = 不限制。 |
| `dbPath` | string | "" | ZCode db.sqlite 绝对路径。留空用 ~/.zcode/cli/db/db.sqlite。 |

## 工具

插件暴露 4 个 MCP 工具（namespaced `mcp__read-aloud__<tool>`）：

- `speak_session` — 准备朗读会话：dump 当前会话 → 分块 → 返回分块索引与文本。不含音频。
- `speak_chunk` — 按 requestId+index 逐块取音频（base64 data URI）。voice/rate 可覆盖。
- `list_voices` — 列出 8 个中文 edge 神经音色。
- `session_info` — 诊断：会话身份/数据库/python 解析状态。

## 面板

「朗读」面板从侧栏面板切换器打开。

- 点「朗读」开始朗读当前会话
- 音色下拉：8 个中文神经音色
- 倍速：0.5× / 0.75× / 1× / 1.25× / 1.5× / 2×（2× 实际与 1.5× 同效，edge-tts 上限）
- 停止：暂停播放 + 作废在途请求（server 侧合成不可中断，最长约 30 秒）
- 进度条：aria-progressbar 同步更新
- 转写区：当前块高亮、已读块标记、自动滚动

## 停止语义

面板停止 = `Audio.pause()` + runId++（作废在途响应）+ 不再发新请求。
server 侧 spawnSync 阻塞无法中断（单块 ≤120 字，最坏约 20-30 秒），该块会合成完落进磁盘缓存——无害。

## 音色/倍速变更

面板切换音色/倍速后，重启当前块时在 speak_chunk 请求里带上新的 voice/rate 覆盖参数——effective 值参与 cacheKey，切音色后不命中旧缓存，合成新音色音频。变更不需要重新调 speak_session。

## 会话身份

- `meta`：host 注入 `_meta.sessionId`
- `arg`：显式参数
- `fallback-latest`：最新主会话（排除 sess_subagent_*/sess_dwf-*）

fallback 时面板状态栏显示实际会话 id 供核对。

## 排障

- **Python 未找到**：设置 `userConfig.pythonPath` 为 Python 全路径
- **edge-tts 未装**：`pip install edge-tts`
- **网络失败**：错误原文显示在面板提示行

## 与 CLI 的关系

用户级 `read-aloud` 技能和 CLI（`read-aloud.mjs`）支持 SAPI（离线）和 minimax 引擎。面板插件**只**使用 edge-tts（在线神经音色）。CLI 有 SAPI 离线兜底，面板没有。

## vendor 同步流程

正本 `read-aloud.mjs` 改动 dump/分块/音色逻辑 → 复制改动到 `dist/core.mjs` → 跑 `node --test test/core.test.mjs`（等价断言必须绿）→ git commit。

## 测试

```bash
# 语法检查
node --check dist/server.mjs
node --check dist/core.mjs

# 单测（显式文件列表：node --test 目录参数在本机 Node 22.23.3 MODULE_NOT_FOUND）
node --test test/core.test.mjs test/server.test.mjs test/panel.test.mjs test/validate-manifest.mjs

# manifest 合法性
node test/validate-manifest.mjs

# 真实 edge-tts 合成冒烟
node test/real-tts-smoke.mjs

# 面板浏览器冒烟（python 用全路径，避开 WindowsApps 桩）
C:/Users/Nefelibata/AppData/Local/Programs/Python/Python312/python.exe smoke_panel.py dist/panel.html
```
