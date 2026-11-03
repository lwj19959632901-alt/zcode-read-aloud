---
description: 用常驻侧栏「朗读」面板朗读当前会话，支持音色/倍速/停止
argument-hint: [start|voices|status]
skills: read-aloud-panel
---

先用 Skill 工具读取插件技能 `read-aloud-panel`（技能正本在插件 `skills/read-aloud-panel/SKILL.md`），再按参数分支执行。

参数分支（$ARGUMENTS）：

- **空 / `start`** —— 朗读当前会话：
  调用插件 MCP 工具 `speak_session`（可带 `voice`、`rate`、`maxChars` 参数），结果定向「朗读」面板并自动播放。
  面板未打开时，告诉用户在侧栏面板切换器打开「朗读」。
  host 会注入当前会话身份（`_meta.sessionId`）；若未注入，面板状态栏会显示 fallback 会话 id 供核对。

- **`voices`** —— 列 8 个中文神经音色：
  调用插件 MCP 工具 `list_voices`，返回音色名/标签/性别/风格。

- **`status`** —— 查看会话身份/数据库/python 解析状态：
  调用插件 MCP 工具 `session_info`，返回 sessionId、db 路径、db 是否存在、python 是否已解析。

- **参数无法判定** —— 按 `start` 处理。

工具不可用（插件未安装或未启用）则停止并告知用户先安装插件。
