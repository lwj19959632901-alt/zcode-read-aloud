---
name: read-aloud-panel
description: "Use when the user asks to read the current session aloud via the side panel, wants to switch voice/rate in the read-aloud panel, needs to stop reading, or asks about the read-aloud plugin's tools (speak_session, speak_chunk, list_voices, session_info). Covers panel interaction, stop semantics, rate limits, and troubleshooting. Yields TTS requests to local-ai skill and text-to-speech to the read-aloud CLI skill."
---

# read-aloud-panel

`read-aloud-panel` is a ZCode plugin that reads the current conversation aloud via a persistent
side-panel using edge-tts neural voices (8 Chinese voices). It synthesizes audio chunk-by-chunk
and plays them in sequence with transcript highlighting.

## Tools

The plugin exposes 4 MCP tools (namespaced `mcp__read-aloud__<tool>`):

### `speak_session`

Prepares a reading session: dumps the current conversation, splits it into chunks, and returns
the chunk index with text for the panel to render. Does **not** include audio.

Parameters:
- `voice` (optional string): voice name or short name (e.g. `yunxi`). Defaults to `RA_DEFAULT_VOICE` or `zh-CN-XiaoxiaoNeural`.
- `rate` (optional number): -10 to 10 (edge percentage step 5). Defaults to 0. Values outside -10..10 are clamped to the nearest bound (e.g. 99 → 10, -99 → -10, NaN → 0). Non-finite values default to 0.
- `maxChars` (optional number): character budget. Defaults to `RA_MAX_CHARS` (12000). 0 = unlimited. Truncation is at chunk boundaries.
- `sessionId` (optional string): explicit session id override (for testing). Defaults to `_meta.sessionId` → fallback resolution.

Returns JSON with `requestId`, `sessionId`, `sessionSource`, `voice`, `rate`, `chunks[]`, `totalChars`, `truncated`.

`sessionSource` is one of: `"meta"` (host injected), `"arg"` (explicit), `"fallback-latest"` (latest main session).

### `speak_chunk`

Retrieves audio for a specific chunk (base64 data URI). Called by the panel chunk-by-chunk.

Parameters:
- `requestId` (required string): from `speak_session` response.
- `index` (required number): chunk index (0-based).
- `voice` (optional string): overrides the voice from the speak_session request.
- `rate` (optional number): overrides the rate from the speak_session request.

Returns JSON with `ok`, `requestId`, `index`, `text`, `voice`, `rate`, `dataUri`, `bytes`, `cached`.

**Voice/rate change semantics**: when the panel switches voice or rate, it passes the new
`voice`/`rate` as override parameters in the `speak_chunk` call. The effective values
participate in the cache key, so switching voice does **not** hit the old cache and
synthesizes new audio. This means changes take effect **without re-calling `speak_session`**
(no re-dump, no re-render of the transcript).

### `list_voices`

Lists 8 Chinese edge neural voices with name, label, gender, style.

### `session_info`

Diagnostics: returns current session identity (`_meta.sessionId` or null), db path, db existence, and whether python has been resolved.

## Panel Interaction

The **朗读** (Read Aloud) panel opens from the session's right-side panel switcher.

- **Read**: click the 朗读 button → `speak_session` → renders transcript → requests chunk 0 → plays audio → on `ended` requests next chunk.
- **Stop**: `Audio.pause()` + runId++ (invalidates in-flight responses) + status "已停止" + progress reset. The server-side synthesis for the current chunk **cannot be interrupted** (spawnSync blocks); the chunk will finish synthesizing (~20-30s max) and land in the disk cache silently.
- **Voice change**: takes effect on the **current chunk** (restart). The panel sends the new voice as an override in `speak_chunk`. The old cache is not hit.
- **Rate change**: takes effect on the **current chunk** (restart). Same override mechanism.
- **Progress bar**: `aria-progressbar` with `aria-valuenow` synced to reading progress.
- **Transcript highlighting**: current chunk `.is-active`, read chunks `.is-read`, auto-scroll.

### Rate Limits

| Panel Rate | edge --rate | Notes |
|---|---|---|
| 0.5× | -50% | |
| 0.75× | -25% | |
| 1× | +0% | |
| 1.25× | +25% | |
| 1.5× | +50% | edge-tts maximum |
| 2× | +50% | **Same as 1.5×** (edge-tts maximum); UI hint notes this |

### Autoplay Policy

If `speak_session` is triggered by a model command (not a user click), the browser may block
autoplay. The panel catches the `play()` Promise rejection and shows a hint:
"浏览器拦截了自动播放，请点一下朗读按钮" — the user needs to click the read button once.

## Session Identity

- **Three states**: `meta` (host injected `_meta.sessionId`), `arg` (explicit parameter), `fallback-latest` (latest main session, excluding `sess_subagent_*` and `sess_dwf-*`).
- When `sessionSource` is `fallback-latest`, the panel status bar shows:
  "会话 sess_xxx（最近更新，host 未注入身份）" — the user can verify whether this is the current session.
- Use `session_info` to check the current session identity and database/python status.

## Troubleshooting

- **Python not found**: the server tries `RA_PYTHON_PATH` → `python` → `python3` → `py`, verifying each with `--version`. If all fail, the error lists all candidates. Fix: set `userConfig.pythonPath` to the full Python executable path.
- **edge-tts not installed**: error message shows the edge-tts failure. Fix: `pip install edge-tts`.
- **Network failure**: the error text from edge-tts is shown in the panel hint line. The panel only uses edge-tts (no SAPI fallback — browser `speechSynthesis` and System.Speech are different things). The CLI (`read-aloud.mjs`) retains SAPI fallback.
- **Host doesn't inject sessionId**: `session_info` diagnoses this. `speak_session` falls back to the latest main session with a transparent `sessionSource` marker. The panel shows the actual session id in the status bar.

## Difference from CLI skill

The user-level `read-aloud` skill and CLI (`read-aloud.mjs`) support SAPI (offline) and minimax engines with automatic fallback. The panel plugin **only** uses edge-tts (online neural voices). The CLI has SAPI offline fallback; the panel does not.
