# host-patch — 把 🔊 朗读按钮插进 ZCode 消息操作栏

在 ZCode 每条**助手回复**的操作栏（复制 / 赞 / 踩 / 分叉 / 钩子 / 时间戳）里加一个朗读按钮，
点一下用 **edge-tts 神经音色**（默认 `zh-CN-XiaoxiaoNeural`）流式朗读这条回复，再点停止。

> 🔊 右边的倍速小按钮：点击循环 `1.0× → 1.25× → 1.5× → 2.0× → 0.75×`，选择写进
> `localStorage["readaloud.rate"]`，热重载 / 重启后自动恢复；倍速是**播放器变速**
> （`audio.playbackRate`）：播放中改倍速**立即生效**（0 延迟、进度连续、不发新的
> `/tts` 请求，preservePitch 默认保留音高），不再重合成；每个新创建的 audio 元素
> 初始也带当前倍速；服务端合成统一原速（`/tts` 固定 `rate=+0%`）；停止状态下只改
> 设置、不启动播放；降级 `speechSynthesis` 路径仍按新的 `u.rate` 出下一块。

> 这是「C 方案」：改宿主 `app.asar` 入口，追加一行 dynamic import。
> A/B 方案（CLI + 技能 + MCP 侧栏面板）在仓库上层，不依赖本目录。

---

## 文件

| 文件 | 作用 |
|---|---|
| `readaloud-loader.cjs` | **主进程**：解析 python → 起 127.0.0.1 临时端口 HTTP 桥（`/health` `/voices` `/tts` 流式）→ 只向 URL 含 `app.asar/out/renderer` 的窗口注入渲染脚本；失败只记日志 |
| `readaloud-renderer.js` | **渲染层**：定位操作栏 → clone 复制按钮 → 喇叭图标 + `aria-label="朗读"` → 🔊 后插倍速按钮（循环 `1.0×/1.25×/1.5×/2.0×/0.75×`，存 localStorage）→ 点击取活节点 `innerText` → 按句切块流式 `<audio>` 播放 → 再点停止 → 不可用时降级 `speechSynthesis` → `MutationObserver` 兜底重注入 |
| `patch-readaloud.py` | **asar 补丁器**：`selftest` / `install` / `remove` / `check` |
| `install.ps1` / `uninstall.ps1` | PS7 runbook（全路径 `C:\Program Files\PowerShell\7\pwsh.exe`，自动用 PS7 重跑自己） |
| `state/entry-pristine.json` | 安装前入口指纹（按 asar 路径记录；`remove` 时用来断言字节回到原样；可删） |

零 npm 依赖。主进程只用 node 内置模块；合成走 `python -m edge_tts`。

---

## 安装 / 卸载

```powershell
# 先完全退出 ZCode（含托盘/后台进程），然后：
& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

# 安装后重启 ZCode，每条助手回复操作栏右侧出现 🔊

# 卸载（只剥离注入行）
& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

直接调补丁器（等价）：

```powershell
python patch-readaloud.py check              # 注入状态 + 行数 + 入口语法（Electron --check）
python patch-readaloud.py selftest           # 重打包逐字节自检（不动现役 asar）
python patch-readaloud.py install            # ZCode 运行中会拒绝
python patch-readaloud.py remove             # strip-only
python patch-readaloud.py install --asar "D:\Other\resources\app.asar"
```

`check` 退出码：`0` = PASS，`1` = FAIL，`3` = **NOT-INSTALLED**（未注入，多半是官方升级整包替换了
`app.asar`）。`3` 只表示「功能不在」，不代表 asar 有损坏，也不阻断任何写入操作。

路径解析（非默认安装位置时用）：

- **asar**：`--asar` 显式指定优先，其次环境变量 `READALOUD_ASAR`，最后兜底本机默认
  `D:\ZCode\resources\app.asar`。
- **ZCode 可执行文件**（入口语法检查用）：环境变量 `ZCODE_EXE`（旧名 `READALOUD_ZCODE_EXE` 仍兼容）
  优先，其次从 asar 路径反推 `<root>\ZCode.exe`，最后才兜底本机默认 `D:\ZCode\ZCode.exe`。

前置：`python -m pip install edge-tts`（未安装时按钮仍会出现，但只能走系统 `speechSynthesis` 机械音）。

---

## 三条硬规则（别改）

### 1. 禁止任何 `.tmp` / pending 待替换路径

ZCode 的自动更新走 `resources/app-update.yml` 里的 generic feed。若安装时把包写成
「待下次启动替换」，某次自动更新之后再启动，**旧 asar 会覆盖新版本** —— 整份客户端降级。
所以本工具在检测到 `ZCode.exe` 进程时**直接拒绝**，提示先退出；不存在「稍后自动完成」的分支。

### 2. 禁止用 `app.asar.orig` / 旧备份覆盖回滚

`resources/app.asar.orig`（2026-09-25）与 `app.asar.bak-orig-preinjection-*` 都比现役 asar
旧一个月。用它们覆盖 = 把客户端降级回一个月前，且会抹掉 zusage 等其它注入。
回滚**只做 strip-only**：删掉自己的注入行，其余字节原样保留。

### 3. 幂等靠正则，不靠「是否在尾部」

zusage 每 60 秒会自动重装自己的注入行，会把我们的行挤到**非尾部**。
按「尾部是不是我的行」判断会重复追加；本工具用唯一 token `readaloud-loader.cjs` 的正则
`re.sub` 清理所有历史行再追加一条，装完断言**恰好 1 处**。

---

## 端口与 token 机制

- HTTP 桥 `server.listen(0, '127.0.0.1')` —— **临时端口**，每次启动随机，不写死 47821，不怕占用。
- **每次启动生成随机 token**（24 字节 → hex），注入渲染层时随配置下发；所有路由都必须带
  （`?t=<token>` 或 `Authorization: Bearer <token>`），否则 401。
- 每个请求校验 `Host == 127.0.0.1:<port>`，防 DNS rebinding。
- **不发 `Access-Control-Allow-Origin: *`**：媒体请求（`<audio src>`）本来就不参与 CORS；
  `/health` `/voices` 按需**反射具体 Origin**（`null` / `file://` / `127.0.0.1` / `zcode://`），
  鉴权靠 token 而不是 CORS。
- **注入门控**：只有 `webContents.getURL()` 含 `app.asar/out/renderer` 的 `window` 才会收到
  渲染脚本与 token（主窗口 URL 形如
  `file:///<ZCodeRoot>/resources/app.asar/out/renderer/index.html?...`；本机示例为
  `file:///D:/ZCode/resources/app.asar/out/renderer/index.html?...`）。宿主日后若用
  `BrowserWindow` 打开外部网页，那个页面拿不到 token / 桥端口。
- `/tts` 并发上限 4，单次正文上限 1200 字（渲染层按 900 字切块），客户端断开即杀子进程。
- 单块合成有 **25 秒看门狗**：python 子进程超时被 kill，尚未出音频时回 `504`
  （`{"error":"synthesis timeout"}`），已出音频则断流让渲染层报错降级。

## 隐私与联网（重要）

- **消息正文会进本机进程列表**：渲染层取到的正文经 HTTP 请求传参给
  `python -m edge_tts --text <正文>`，同机其它进程/用户在进程列表中能看到这段命令行文本
  （Windows 任务管理器默认不显示命令行，但 `wmic`/`Get-CimInstance Win32_Process` 可见）。
  这段暴露只限本机，无落盘、无日志；但下一节的「离开本机」仍然成立。
- **edge-tts 是微软在线服务**：文本会发往微软的语音合成服务器（`speech.platform.bing.com`
  等），**离开本机**。涉及敏感内容的回复请勿点朗读，或先断网。
- **断网/连不上微软**时神经音色不可用，自动降级为系统 `speechSynthesis` 机械音
  （Windows 自带的 Huihui / Kangkang / Yaoyao），这条路径完全本地。
- 本地桥只绑 `127.0.0.1`、每次启动随机 token、校验 `Host`，不接受局域网访问。

## 流式是怎么做的

`python -m edge_tts --text … --voice …` 默认把 mp3 写到 **stdout**（`--write-media` 才落文件）。
主进程把子进程 stdout **直接 pipe 进 HTTP 响应**，拿到第一块数据才写 `200` 头，
渲染层用 `<audio src="http://127.0.0.1:<port>/tts?t=…&text=…">` 边下边播。
长文按句切块（≤900 字）顺序播放，每块一个 `<audio>`。

## DOM 定位（为什么这么写）

```
[class*="assistant-turn"]
├── div.flex.flex-col.gap-5            ← 正文：[class*="assistant-row"] [data-conversation-selectable]
├── div（diff 卡片，可选）
└── div.flex.items-center.gap-1.group-hover/assistant…   ← 操作栏（6 个子节点）
      复制 / 赞 / 踩 / 分叉 / 钩子 / 时间戳
```

注意：有的回合（历史/加载中/并行任务）**没有直系操作栏**，整个消息包在
`div.flex.flex-col.gap-5[&>[data-zcode-chat-loading-slot]…]` 里，里面只有正文深处的
「复制」。这种回合宁可不注入，等操作栏真正出现后由 observer 补进去。

- 操作栏定位按可靠性排序，**绝不返回 `assistant-turn` 本身或包裹整条消息的列容器**：
  1. `button[aria-label="赞"]` 的 `parentElement`（宿主动作栏最稳的锚）
  2. 否则 `button[aria-label="踩"]` 的 `parentElement`
  3. 否则 `button[aria-label="复制"]` 的 `parentElement`，且该父节点至少 3 个直系 `button`
     （挡掉正文代码块/表格里的单复制按钮）
  4. 最后才回退到 class 匹配（直系子节点带 `group-hover/assistant` 且含 `button`）
- **插入守卫**：`ensureButton` / `ensureSpeedButton` 只在「容器有直系子节点
  `button[aria-label="赞"|"踩"|"复制"]`」时才插；否则直接放弃，绝不 `appendChild` 到包裹容器
  （列容器是 `flex-col`，追加进去会让 🔊 和倍速各占一行、整体错位）。
- **游离按钮清理**：`sync()` 每轮移除「父容器不是合格操作栏」的
  `button[data-readaloud="1"]` / `button[data-readaloud-speed="1"]`，幂等且无残留时不碰 DOM。
- 锚点是 `button[aria-label="复制"]`，没有就用栏内第一个 `button`。
- 取文范围必须是 `[class*="assistant-row"] [data-conversation-selectable]`：
  **用户气泡也有 `[data-conversation-selectable]`**，裸查会读到用户消息。
- 取文必须读**活节点** `innerText`：clone 后 `innerText` 会退化成 `textContent`、丢段落分隔
  （实测 live 1376 字 / 29 行 vs clone 1389 字 / 42 行）。
- 播放态高亮**不读** `--color-primary`（当前主题实算为 `#fff`，改字色等于没提示）：固定用
  accent `#4f9cf9` 的背景 tint + 内描边，并同步 `aria-pressed="true"` 给读屏。

## 升级 ZCode 之后

官方升级会整包替换 `app.asar` → 注入行消失，按钮也随之不见。**升级后重跑 `install.ps1` 即可**。
`state/entry-pristine.json` 记的是上一版的入口指纹（按 asar 路径分键），`remove` 时对不上会提示「asar 已被官方升级，属正常」，
不影响剥离。

---

## 自检（离线，不需要重启 ZCode）

```powershell
# 下面的 D:\ZCode\... 均为本机示例路径，请按实际安装位置替换
# （或先设 $env:ZCODE_EXE / $env:READALOUD_ASAR）

# 1) 重打包逐字节相等 + 只入口偏移变化 + 注入行不变量 + 入口语法
python patch-readaloud.py selftest

# 2) 语法（ESM 要用 .mjs 副本）
Copy-Item readaloud-loader.cjs  .\tmp-loader.mjs
Copy-Item readaloud-renderer.js .\tmp-renderer.mjs
node --check .\tmp-loader.mjs
node --check .\tmp-renderer.mjs
$zcode = if ($env:ZCODE_EXE) { $env:ZCODE_EXE } else { 'D:\ZCode\ZCode.exe' }
$env:ELECTRON_RUN_AS_NODE=1; & $zcode --check .\tmp-loader.mjs
$env:ELECTRON_RUN_AS_NODE=1; & $zcode --check .\tmp-renderer.mjs

# 3) 副本 asar 上演练 install → check → remove
$asar = if ($env:READALOUD_ASAR) { $env:READALOUD_ASAR } else { 'D:\ZCode\resources\app.asar' }
Copy-Item $asar .\tmp-probe\asar-lab\app.asar
python patch-readaloud.py install --asar .\tmp-probe\asar-lab\app.asar
python patch-readaloud.py check   --asar .\tmp-probe\asar-lab\app.asar
python patch-readaloud.py remove  --asar .\tmp-probe\asar-lab\app.asar

# 4) 倍速按钮 DOM 断言（Playwright + 本机 Chrome，不碰 ZCode、不跑真实 TTS）
python renderer-speed-test.py
```

> 演练副本请放在临时目录并事后删除（每个 ~374MB）。

## 排障

| 现象 | 排查 |
|---|---|
| 按钮不出现 | CDP：`document.querySelectorAll('button[data-readaloud]').length`；再看 `window.__readaloudVersion`、控制台 `[readaloud]` 日志。若日志说 `no injectable window`，检查窗口 URL 是否含 `app.asar/out/renderer` |
| 按钮出现但点不出声 | `window.__readaloudDebug.counts()` 看 `ttsReady`；`curl "http://127.0.0.1:<port>/health?t=<token>"`；`python -c "import edge_tts"` |
| 提示「合成超时」 | 单块超过 25 秒被 loader kill（504），本条已自动切系统音；下一次点击会先重试 `/health`，恢复后回到神经音色 |
| 只有机械音 | python 没找到或没装 `edge-tts`；看主进程日志 `[readaloud] no usable python`；设 `READALOUD_PYTHON`。若之前神经音能播、后来一直机械音，点一次新消息会触发 `/health` 重试，恢复即回神经音 |
| 按钮时有时无 | React 重渲染会冲掉注入节点，靠 `MutationObserver` 补回（150ms 合并 / 800ms 上限）；若长期缺失看 `needsWork()` 是否被内容判定挡住 |
| 客户端起不来 | 入口语法坏了：`python patch-readaloud.py check`；`remove` 需要能进系统，必要时从别的机器拷回同版本 `app.asar`（**不要**用 `.orig`） |
| `install` 报「ZCode 正在运行」 | 完全退出（任务管理器里确认无 `ZCode.exe`）再跑 |
| `check` 退 3 / NOT-INSTALLED | 官方升级把 `app.asar` 整包换掉了：重跑 `install.ps1` 即可，不是损坏 |

## 热迭代

改完 `readaloud-renderer.js` **不用重装 asar、也不用重启 ZCode**：loader 每 2 秒 `watchFile`，
mtime 变化后**直接对每个现存窗口调 `injectInto()`**（绕过 `attach()` 的已 hook 短路），
注入前缀会先执行 `window.__readaloudDispose()` 摘掉旧实例再装新的。日志会打印实际注入的窗口数：

```
[readaloud] renderer changed, hot re-injected into 1 window(s)
```

没有窗口匹配注入门控（URL 不含 `app.asar/out/renderer`）时不会谎报，只会打印
`no injectable window matched the URL gate`；写到一半/语法坏掉的中间态会打印
`the new source failed to load/parse; not re-injecting` 并保留旧实例（`new Function(src)` 预校验）。

注意：热重载只覆盖 `readaloud-renderer.js`。**改 `readaloud-loader.cjs` 必须重启 ZCode**
（主进程代码），且客户端必须已经加载了带本版热重载逻辑的 loader——从旧版升级过来时，
先重启一次让新 loader 上电。

也可以手动（在 DevTools 控制台）：

```js
window.__readaloudReload()      // 重建按钮 + observer，返回 {version, buttons}
window.__readaloudDispose()     // 摘掉按钮 + 断开 observer + 停止播放
```
