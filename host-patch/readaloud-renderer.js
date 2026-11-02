/* ZCode 朗读按钮（渲染层）。
 *
 * 由 readaloud-loader.cjs 在主进程注入（executeJavaScript，userGesture=true）。
 * 前缀会先设好 window.__readaloudConfig = {base, token, voice, version}；本文件也能
 * 独立跑（缺配置时自动降级到 speechSynthesis）。
 *
 * 行为：
 *   - 定位助手回复的操作栏（优先「赞」按钮的父节点，其次「踩」/多按钮「复制」父节点，
 *     最后才按 group-hover/assistant class 回退；插入前校验容器直系含动作按钮），
 *     clone「复制」按钮（样式零成本）→ 换喇叭图标 + aria-label="朗读" → 插在复制之后；
 *   - 喇叭后面再插一个倍速小按钮（data-readaloud-speed="1"）：点击循环
 *     1.0 → 1.25 → 1.5 → 2.0 → 0.75 → 1.0，存 localStorage["readaloud.rate"]；
 *     倍速由播放器实现（audio.playbackRate，>1 加速 <1 减速，preservePitch 默认保留
 *     音高）：播放中切速立即生效、进度连续、不发任何新的 /tts 请求，不再重合成；
 *     每个新创建的 audio 元素初始也带当前倍速；服务端合成统一原速（/tts 固定
 *     rate=+0%）；停止状态只改状态不启动播放；降级 speechSynthesis 路径仍用 u.rate；
 *   - 点击：只取 [class*="assistant-row"] [data-conversation-selectable] 的活节点 innerText
 *     （用户气泡也有 [data-conversation-selectable]，裸查会读错；clone 会让 innerText
 *     退化成 textContent、丢段落分隔）；
 *   - 按句切块（<=900 字）顺序播放，用 <audio src="…/tts?..."> 流式播放；再点停止；
 *     服务不可用/音频出错时降级 speechSynthesis；一次失败不会永久封死神经路径
 *     （下次点击先重试 /health，通了就恢复）；
 *     播放态用 accent 背景 tint + aria-pressed="true" 表示，不依赖主题的 --color-primary；
 *   - MutationObserver（childList+subtree）合并触发：最少 150ms、最长等 800ms，
 *     没有缺失按钮时直接 no-op（不碰 DOM，避免自激循环）；
 *   - 暴露 window.__readaloudReload() / window.__readaloudDispose() 便于热迭代。
 */
(function () {
  "use strict";

  var CFG = (typeof window.__readaloudConfig === "object" && window.__readaloudConfig) || {};
  var VERSION = CFG.version || "0.1.1";
  var BASE = typeof CFG.base === "string" ? CFG.base : "";
  var TOKEN = typeof CFG.token === "string" ? CFG.token : "";
  var CFG_VOICE = typeof CFG.voice === "string" ? CFG.voice : "zh-CN-XiaoxiaoNeural";

  var TURN_SEL = '[class*="assistant-turn"]';
  var ROW_SEL = '[class*="assistant-row"]';
  var SELECTABLE_SEL = "[data-conversation-selectable]";
  var CONTENT_SEL = ROW_SEL + " " + SELECTABLE_SEL;
  var OUR = '[data-readaloud="1"]';
  var SPEED_SEL = 'button[data-readaloud-speed="1"]';
  var RATE_KEY = "readaloud.rate";
  /* 点击循环顺序：1.0 → 1.25 → 1.5 → 2.0 → 0.75 → 1.0（最后一档回卷） */
  var RATE_STEPS = [1, 1.25, 1.5, 2, 0.75];
  var MAX_CHUNK = 900;
  var TTS_TIMEOUT_MS = 25000;   /* 与 loader 的单块合成看门狗一致（超时回 504） */

  var SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
    'stroke-linejoin="round" class="lucide lucide-volume-2 size-3.5" aria-hidden="true">' +
    '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/>' +
    '<path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/></svg>' +
    '<span class="sr-only">朗读</span>';

  var STYLE_ID = "readaloud-style";
  var ACCENT = "#4f9cf9";
  var CSS =
    'button[data-readaloud="1"]{transition:color .15s ease,background-color .15s ease,opacity .15s ease;border-radius:6px}' +
    'button[data-readaloud="1"][data-readaloud-state="loading"]{opacity:.55}' +
    /* 播放态不能只改 color：宿主主题的 --color-primary 实算为 #fff，改字色等于没提示。
       用固定 accent 背景 tint + 内描边，深浅主题下都看得见（aria-pressed 同步给读屏）。 */
    'button[data-readaloud="1"][data-readaloud-state="playing"],' +
    'button[data-readaloud="1"][aria-pressed="true"]{' +
    'background-color:rgba(79,156,249,.22);color:' + ACCENT + ';' +
    'box-shadow:inset 0 0 0 1px rgba(79,156,249,.6)}' +
    'button[data-readaloud="1"][data-readaloud-state="playing"] svg,' +
    'button[data-readaloud="1"][aria-pressed="true"] svg{color:' + ACCENT + '}' +
    /* 倍速小按钮：贴着喇叭右侧，18px 高（操作栏 24px，不撑高），透明背景吃宿主主题字色；
       倍速 ≠ 1.0 时用 accent 色提示「已改过速」。 */
    'button[data-readaloud-speed="1"]{height:18px;min-height:0;padding:0 2px;border:0;' +
    'background:transparent;font-size:11px;line-height:18px;color:inherit;opacity:.7;' +
    'cursor:pointer;border-radius:4px;font-variant-numeric:tabular-nums;' +
    'transition:color .15s ease,opacity .15s ease}' +
    'button[data-readaloud-speed="1"]:hover{opacity:1}' +
    'button[data-readaloud-speed="1"][data-readaloud-speed-on="1"]{color:' + ACCENT + ';opacity:1}';

  function log() {
    try {
      if (window.console && console.warn) {
        console.warn.apply(console, ["[readaloud]"].concat([].slice.call(arguments)));
      }
    } catch (e) {
      /* ignore */
    }
  }

  /* 先拆旧的（重复注入 / 热重载） */
  if (window.__readaloudDispose) {
    try {
      window.__readaloudDispose();
    } catch (e) {
      /* ignore */
    }
  }

  var disposed = false;
  var observer = null;
  var burstStart = 0;
  var timer = 0;
  var current = null;      /* 当前播放会话 */
  var ttsReady = null;     /* null=未知 true=可用 false=不可用 */
  var voiceList = null;
  var state = { rate: 1 }; /* 播放倍速（1.0 = 原速）；boot() 时从 localStorage 恢复 */

  /* ------------------------------------------------------------ 工具 */

  function classStr(el) {
    return el && typeof el.className === "string" ? el.className : "";
  }

  function clampNum(n, lo, hi) {
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  /* 只认 0.5–3 之间的有限数；其它（空串/NaN/负数/离谱值）一律回落 1.0 */
  function normalizeRate(v) {
    var n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v));
    if (!isFinite(n) || n < 0.5 || n > 3) return 1;
    return n;
  }

  function readStoredRate() {
    try {
      var raw = window.localStorage ? window.localStorage.getItem(RATE_KEY) : null;
      if (raw == null || raw === "") return 1;
      return normalizeRate(raw);
    } catch (e) {
      return 1;   /* 隐私模式/禁用存储：用默认值，不抛错 */
    }
  }

  function saveRate(r) {
    try {
      if (window.localStorage) window.localStorage.setItem(RATE_KEY, String(r));
    } catch (e) {
      /* 存不进去只影响下次恢复，不影响本次播放 */
    }
  }

  /* 1 → "1.0×"、1.25 → "1.25×"、1.5 → "1.5×"、0.75 → "0.75×" */
  function rateLabel(r) {
    var s = String(Math.round(Number(r) * 100) / 100);
    if (s.indexOf(".") === -1) s += ".0";
    return s + "×";
  }

  /* 当前值在 RATE_STEPS 里就走下一档（末档回卷）；不在序列里就取第一个更大的档 */
  function nextRate(cur) {
    var i;
    for (i = 0; i < RATE_STEPS.length; i++) {
      if (Math.abs(RATE_STEPS[i] - cur) < 1e-9) return RATE_STEPS[(i + 1) % RATE_STEPS.length];
    }
    for (i = 0; i < RATE_STEPS.length; i++) {
      if (RATE_STEPS[i] > cur) return RATE_STEPS[i];
    }
    return RATE_STEPS[0];
  }

  function injectStyle() {
    try {
      if (document.getElementById(STYLE_ID)) return;
      var s = document.createElement("style");
      s.id = STYLE_ID;
      s.textContent = CSS;
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      /* 样式失败不影响功能 */
    }
  }

  /* ------------------------------------------------------------ DOM 定位 */

  /* 合格操作栏：直系子节点里必须有宿主动作按钮（赞/踩/复制）。
     这是「容器」与「操作栏」的唯一可靠区分——包裹整条消息的列容器里只有
     正文深处的「复制」，直系子节点全是 div，不算操作栏。 */
  function directButtonCount(el) {
    var kids;
    var n = 0;
    try {
      kids = el.children;
    } catch (e) {
      return 0;
    }
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] && kids[i].tagName === "BUTTON") n += 1;
    }
    return n;
  }

  function hasDirectActionButton(el) {
    var kids;
    try {
      kids = el.children;
    } catch (e) {
      return false;
    }
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (!k || k.tagName !== "BUTTON") continue;
      var label = null;
      try {
        label = k.getAttribute("aria-label");
      } catch (e) {
        label = null;
      }
      if (label === "赞" || label === "踩" || label === "复制") return true;
    }
    return false;
  }

  function isActionBar(el) {
    return !!el && el.nodeType === 1 && hasDirectActionButton(el);
  }

  /* 操作栏定位，按可靠性排序（绝不返回 turn 本身，也绝不返回不含动作按钮的容器）：
     1. 「赞」按钮的父节点——宿主动作栏最稳的锚（v0.1.0 实测）
     2. 「踩」按钮的父节点
     3. 「复制」按钮的父节点，且该父节点至少有 3 个直系 button 子节点
        （正文代码块/表格里的单复制按钮会被这条挡掉）
     4. 最后才回退到原 class 匹配（group-hover/assistant + 含 button），仍须通过
        isActionBar 校验——否则会重新把包裹整条消息的列容器当成操作栏。 */
  function findBar(turn) {
    if (!turn) return null;
    var i;
    var anchors = ["赞", "踩"];
    for (i = 0; i < anchors.length; i++) {
      var hit = null;
      try {
        hit = turn.querySelector('button[aria-label="' + anchors[i] + '"]');
      } catch (e) {
        hit = null;
      }
      var hitBar = hit && hit.parentElement;
      if (hitBar && hitBar !== turn && isActionBar(hitBar)) return hitBar;
    }

    var copy = null;
    try {
      copy = turn.querySelector('button[aria-label="复制"]');
    } catch (e) {
      copy = null;
    }
    var copyBar = copy && copy.parentElement;
    if (copyBar && copyBar !== turn && directButtonCount(copyBar) >= 3 && isActionBar(copyBar)) {
      return copyBar;
    }

    var kids;
    try {
      kids = turn.children;
    } catch (e) {
      kids = null;
    }
    if (kids) {
      for (i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (
          classStr(el).indexOf("group-hover/assistant") !== -1 &&
          el.querySelector &&
          el.querySelector("button") &&
          isActionBar(el)
        ) {
          return el;
        }
      }
    }
    return null;
  }

  function hasContent(turn) {
    try {
      return !!turn.querySelector(CONTENT_SEL);
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------ 注入按钮 */

  function ensureButton(turn) {
    var bar = findBar(turn);
    /* 插入守卫：目标必须是真正能容纳动作按钮的操作栏；不合格就不插，
       绝不 appendChild 到包裹整条消息的容器里（那会让按钮各占一行、错位）。 */
    if (!bar || bar === turn || !isActionBar(bar)) return false;

    var added = false;
    var btn = bar.querySelector(OUR);

    if (!btn) {
      var anchor = bar.querySelector('button[aria-label="复制"]') || bar.querySelector("button");
      if (!anchor) return false;

      try {
        btn = anchor.cloneNode(true);
      } catch (e) {
        return false;
      }

      /* 清掉 clone 带出来的标识（P2）：data-testid / data-slot / data-state / id / a11y 状态 */
      var attrs = [
        "data-testid", "data-slot", "data-state", "id", "aria-controls",
        "aria-expanded", "aria-haspopup", "aria-describedby", "aria-pressed",
        "name", "value", "form", "disabled"
      ];
      for (var i = 0; i < attrs.length; i++) {
        try {
          btn.removeAttribute(attrs[i]);
        } catch (e) {
          /* ignore */
        }
      }
      /* sr-only 文案随 innerHTML 一并换掉；这里再兜底清一遍并移除 id 引用 */
      btn.setAttribute("type", "button");
      btn.setAttribute("data-readaloud", "1");
      btn.setAttribute("aria-label", "朗读");
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("title", "朗读");
      btn.innerHTML = SVG;

      btn.addEventListener("click", function (ev) {
        try {
          ev.preventDefault();
          ev.stopPropagation();
        } catch (e) {
          /* ignore */
        }
        onButtonClick(turn, btn);
      });

      try {
        /* anchor 必须是操作栏的直系子节点才能 insertBefore；否则会抛 NotFoundError，
           异常被吞掉后按钮永远不出现、needsWork() 又一直为真（观察器空转）。 */
        if (anchor.parentNode === bar && anchor.nextSibling) bar.insertBefore(btn, anchor.nextSibling);
        else bar.appendChild(btn);
      } catch (e) {
        return false;
      }
      added = true;
    }

    if (ensureSpeedButton(bar, btn)) added = true;
    return added;
  }

  /* 栏内已有的倍速按钮（只认直系子节点：React 重渲染后 clone 会把旧按钮带回来） */
  function speedButtonsOf(bar) {
    var out = [];
    var kids;
    try {
      kids = bar.children;
    } catch (e) {
      return out;
    }
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el && el.getAttribute && el.getAttribute("data-readaloud-speed") === "1") out.push(el);
    }
    return out;
  }

  function updateSpeedButton(btn) {
    if (!btn) return;
    try {
      /* 文案相同就不写：textContent 赋值会换掉文本节点，白给 Observer 一轮 mutation */
      var label = rateLabel(state.rate);
      if (btn.textContent !== label) btn.textContent = label;
      if (Math.abs(state.rate - 1) > 1e-9) btn.setAttribute("data-readaloud-speed-on", "1");
      else btn.removeAttribute("data-readaloud-speed-on");
    } catch (e) {
      /* ignore */
    }
  }

  /* 倍速是全局状态：所有回合的倍速按钮文案一起刷新 */
  function refreshSpeedButtons() {
    var list;
    try {
      list = document.querySelectorAll(SPEED_SEL);
    } catch (e) {
      return;
    }
    for (var i = 0; i < list.length; i++) updateSpeedButton(list[i]);
  }

  function cycleRate() {
    state.rate = nextRate(state.rate);
    saveRate(state.rate);
    refreshSpeedButtons();
    log("rate ->", rateLabel(state.rate), "(playbackRate)");
    /* 播放器侧变速：正在播的块直接改 playbackRate——声音立即变速、进度连续、
       绝不发新的 /tts 请求（旧实现重开 ttsUrl 重合成，要等好几秒才出声）。
       每个新创建的 audio 元素在 playServerChunk 里也初始带当前倍速。
       停止状态（current 为空）/ 首块返回前（c.audio 未创建）只改状态，不启动播放；
       降级模式下一块仍用 speechSynthesis 的 u.rate。 */
    if (current && !current.stopped && current.audio) {
      try {
        current.audio.playbackRate = state.rate;
      } catch (e) {
        /* ignore */
      }
    }
  }

  /* 倍速按钮插在喇叭之后；已有则只同步文案（不重建 DOM，避免 Observer 自激） */
  function ensureSpeedButton(bar, ourBtn) {
    /* 同 ensureButton 的插入守卫：父容器不合格宁可不插，也不制造游离按钮 */
    if (!bar || !isActionBar(bar)) return false;
    var found = speedButtonsOf(bar);
    var i;
    for (i = 1; i < found.length; i++) {
      try {
        if (found[i].parentNode) found[i].parentNode.removeChild(found[i]);
      } catch (e) {
        /* ignore */
      }
    }
    if (found.length) {
      updateSpeedButton(found[0]);
      return false;
    }

    var btn;
    try {
      btn = document.createElement("button");
    } catch (e) {
      return false;
    }
    btn.setAttribute("type", "button");
    btn.setAttribute("data-readaloud-speed", "1");
    btn.setAttribute("aria-label", "朗读倍速");
    btn.setAttribute("title", "朗读倍速");
    btn.addEventListener("click", function (ev) {
      try {
        ev.preventDefault();
        ev.stopPropagation();
      } catch (e) {
        /* ignore */
      }
      cycleRate();
    });
    updateSpeedButton(btn);

    try {
      if (ourBtn && ourBtn.parentNode === bar && ourBtn.nextSibling) bar.insertBefore(btn, ourBtn.nextSibling);
      else bar.appendChild(btn);
    } catch (e) {
      return false;
    }
    return true;
  }

  /* 清理游离按钮：父容器不是合格操作栏的 OUR/SPEED 一律摘掉。
     典型来源是旧版本把按钮追加进了包裹整条消息的列容器（flex-col 布局会把
     🔊 与倍速各撑成一行）；新版本插入前已拦截，这里只负责清历史残留。
     只看父节点、幂等，没有游离按钮时完全不碰 DOM。 */
  function removeStrayButtons() {
    var list;
    var removed = 0;
    try {
      list = document.querySelectorAll(OUR + "," + SPEED_SEL);
    } catch (e) {
      return 0;
    }
    for (var i = 0; i < list.length; i++) {
      var btn = list[i];
      var parent = btn.parentNode;
      if (parent && parent.nodeType === 1 && isActionBar(parent)) continue;
      try {
        if (parent) parent.removeChild(btn);
        removed += 1;
      } catch (e) {
        /* ignore */
      }
    }
    return removed;
  }

  /* 同步一轮：没有缺失时完全不碰 DOM（否则 MutationObserver 会自激） */
  function sync() {
    injectStyle();
    removeStrayButtons();
    var turns;
    try {
      turns = document.querySelectorAll(TURN_SEL);
    } catch (e) {
      return 0;
    }
    var added = 0;
    for (var i = 0; i < turns.length; i++) {
      var turn = turns[i];
      if (!hasContent(turn)) continue;
      if (ensureButton(turn)) added += 1;
    }
    return added;
  }

  function needsWork() {
    var turns;
    try {
      turns = document.querySelectorAll(TURN_SEL);
    } catch (e) {
      return false;
    }
    /* 游离按钮也算「有活要干」：否则 sync() 被 needsWork() 挡在门外，清不掉旧残留 */
    var all;
    try {
      all = document.querySelectorAll(OUR + "," + SPEED_SEL);
    } catch (e) {
      all = [];
    }
    for (var k = 0; k < all.length; k++) {
      var p = all[k].parentNode;
      if (!p || p.nodeType !== 1 || !isActionBar(p)) return true;
    }
    for (var i = 0; i < turns.length; i++) {
      var turn = turns[i];
      if (!hasContent(turn)) continue;
      var bar = findBar(turn);
      if (!bar) continue;
      if (!bar.querySelector(OUR)) return true;
      if (!speedButtonsOf(bar).length) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ 取文 */

  function textOf(turn) {
    var nodes;
    try {
      nodes = turn.querySelectorAll(CONTENT_SEL);
    } catch (e) {
      return "";
    }
    var parts = [];
    for (var i = 0; i < nodes.length; i++) {
      /* 必须读活节点的 innerText：clone 后 innerText 退化成 textContent，段落分隔会丢 */
      var t = nodes[i].innerText;
      if (t && t.trim()) parts.push(String(t).replace(/\r\n/g, "\n").trim());
    }
    var text = parts.join("\n\n");

    /* 剔除按钮自带文字（图标按钮 innerText 为空，这里只防有文本按钮/表格工具条） */
    var labels = {};
    var btns;
    try {
      btns = turn.querySelectorAll("button");
    } catch (e) {
      btns = [];
    }
    var hasLabels = false;
    for (var j = 0; j < btns.length; j++) {
      var bt = (btns[j].innerText || "").trim();
      if (bt) {
        labels[bt] = 1;
        hasLabels = true;
      }
    }
    if (hasLabels) {
      text = text
        .split("\n")
        .filter(function (line) {
          return !labels[line.trim()];
        })
        .join("\n");
    }
    return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  /* 按句切块：先按句末标点/换行拆句，再拼到 <=max；超长单句硬切 */
  function chunkText(text, max) {
    var limit = max || MAX_CHUNK;
    var sentences = [];
    var buf = "";
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      buf += ch;
      if ("。！？!?；;\n".indexOf(ch) !== -1) {
        sentences.push(buf);
        buf = "";
      }
    }
    if (buf) sentences.push(buf);

    var out = [];
    var cur = "";
    for (var j = 0; j < sentences.length; j++) {
      var s = sentences[j];
      while (s.length > limit) {
        if (cur) {
          out.push(cur);
          cur = "";
        }
        out.push(s.slice(0, limit));
        s = s.slice(limit);
      }
      if (!s) continue;
      if (cur.length + s.length > limit) {
        if (cur) out.push(cur);
        cur = s;
      } else {
        cur += s;
      }
    }
    if (cur) out.push(cur);
    return out.filter(function (x) {
      return x.trim().length > 0;
    });
  }

  /* ------------------------------------------------------------ 按钮状态 */

  function setBtnState(btn, st) {
    if (!btn) return;
    try {
      if (st === "idle" || !st) {
        btn.removeAttribute("data-readaloud-state");
        btn.setAttribute("aria-pressed", "false");
        btn.setAttribute("aria-label", "朗读");
        btn.setAttribute("title", "朗读");
      } else if (st === "loading") {
        btn.setAttribute("data-readaloud-state", "loading");
        btn.setAttribute("aria-pressed", "false");
        btn.setAttribute("aria-label", "朗读（合成中）");
        btn.setAttribute("title", "合成中…");
      } else {
        btn.setAttribute("data-readaloud-state", "playing");
        btn.setAttribute("aria-pressed", "true");
        btn.setAttribute("aria-label", "停止朗读");
        btn.setAttribute("title", "停止朗读");
      }
    } catch (e) {
      /* ignore */
    }
  }

  function flash(btn, msg) {
    if (!btn) return;
    try {
      btn.setAttribute("title", msg);
      window.setTimeout(function () {
        if (current && current.btn === btn) return;
        try {
          btn.setAttribute("title", "朗读");
        } catch (e) {
          /* ignore */
        }
      }, 2500);
    } catch (e) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------ 播放 */

  /* 合成统一原速 +0%：倍速由播放器 playbackRate 实现，切速不再重合成；
     保留 rate 参数（loader 的 RATE_RE 只收 [+-]\d{1,3}%，缺省时也是 +0%）。 */
  function ttsUrl(chunk) {
    return (
      BASE +
      "/tts?t=" + encodeURIComponent(TOKEN) +
      "&voice=" + encodeURIComponent(CFG_VOICE) +
      "&rate=" + encodeURIComponent("+0%") +
      "&text=" + encodeURIComponent(chunk)
    );
  }

  function pickVoice() {
    try {
      var synth = window.speechSynthesis;
      if (!synth || !synth.getVoices) return null;
      if (!voiceList) voiceList = synth.getVoices() || [];
      if (!voiceList.length) {
        voiceList = synth.getVoices() || [];
      }
      var zh = [];
      for (var i = 0; i < voiceList.length; i++) {
        var v = voiceList[i];
        if (v && v.lang && String(v.lang).toLowerCase().indexOf("zh") === 0) zh.push(v);
      }
      if (!zh.length) return null;
      var prefer = ["xiaoxiao", "xiaoyi", "huihui", "yaoyao", "kangkang", "female"];
      for (var p = 0; p < prefer.length; p++) {
        for (var k = 0; k < zh.length; k++) {
          if (String(zh[k].name || "").toLowerCase().indexOf(prefer[p]) !== -1) return zh[k];
        }
      }
      return zh[0];
    } catch (e) {
      return null;
    }
  }

  function finishPlayback() {
    var c = current;
    current = null;
    if (c) {
      c.settleCurrent = null;
      if (c.btn) setBtnState(c.btn, "idle");
    }
  }

  function stopPlayback() {
    var c = current;
    current = null;
    if (!c) return;
    c.stopped = true;
    c.settleCurrent = null;
    if (c.audio) {
      try {
        c.audio.pause();
        c.audio.removeAttribute("src");
        c.audio.load();
      } catch (e) {
        /* ignore */
      }
      c.audio = null;
    }
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (e) {
      /* ignore */
    }
    setBtnState(c.btn, "idle");
  }

  function playServerChunk() {
    var c = current;
    if (!c || c.stopped) return;
    if (c.idx >= c.chunks.length) {
      finishPlayback();
      return;
    }
    if (!BASE || !TOKEN) {
      c.mode = "fallback";
      playFallbackChunk();
      return;
    }
    setBtnState(c.btn, c.idx === 0 ? "loading" : "playing");

    var audio;
    try {
      c.chunkAt = Date.now();
      audio = new Audio(ttsUrl(c.chunks[c.idx]));
      audio.preload = "auto";
      /* 新块初始即带当前倍速（>1 加速 <1 减速，0.75–2.0 全支持，
         preservePitch 默认保留音高）：切速后新开的块也用新倍速。 */
      audio.playbackRate = state.rate;
    } catch (e) {
      c.mode = "fallback";
      playFallbackChunk();
      return;
    }

    c.audio = audio;
    var settled = false;
    /* 本块音频的「当前句柄」：只认自己那块 audio（旧句柄清不掉新块），
       块推进 / 停止 / 完成（advance、degrade、stopPlayback、finishPlayback）
       时句柄一并作废。 */
    c.settleCurrent = { audio: audio };

    function advance() {
      if (settled) return;
      settled = true;
      if (c.settleCurrent && c.settleCurrent.audio === audio) c.settleCurrent = null;
      if (current !== c || c.stopped) return;
      c.audio = null;
      c.idx += 1;
      playServerChunk();
    }

    function degrade() {
      if (settled) return;
      settled = true;
      if (c.settleCurrent && c.settleCurrent.audio === audio) c.settleCurrent = null;
      if (current !== c || c.stopped) return;
      var waited = c.chunkAt ? Date.now() - c.chunkAt : 0;
      log("audio failed, falling back to speechSynthesis");
      try {
        audio.pause();
      } catch (e) {
        /* ignore */
      }
      c.audio = null;
      c.mode = "fallback";
      /* 本次先标记不可用（下次点击会先探 /health 再决定），但不再像旧实现那样
         一次失败就永久封死到刷新页面；同时后台探一次，通了就把 ttsReady 恢复，
         下次点击回到神经音色。只有明确不可达才继续判死。 */
      ttsReady = false;
      probeHealth(function (ok) {
        if (ok) log("bridge recovered; neural tts available on the next click");
      });
      playFallbackChunk();
      if (waited >= TTS_TIMEOUT_MS - 2000) flash(c.btn, "合成超时，已切换系统语音");
    }

    audio.addEventListener("ended", advance);
    audio.addEventListener("error", degrade);

    var p;
    try {
      p = audio.play();
    } catch (e) {
      degrade();
      return;
    }
    if (p && typeof p.then === "function") {
      p.then(function () {
        if (current === c && !c.stopped) setBtnState(c.btn, "playing");
      }, function (err) {
        log("play() rejected:", (err && err.message) || err);
        degrade();
      });
    }
  }

  function playFallbackChunk() {
    var c = current;
    if (!c || c.stopped) return;
    if (c.idx >= c.chunks.length) {
      finishPlayback();
      return;
    }
    if (!("speechSynthesis" in window) || typeof window.SpeechSynthesisUtterance !== "function") {
      flash(c.btn, "系统语音不可用");
      stopPlayback();
      return;
    }
    setBtnState(c.btn, c.idx === 0 ? "loading" : "playing");

    var u;
    try {
      u = new window.SpeechSynthesisUtterance(c.chunks[c.idx]);
    } catch (e) {
      stopPlayback();
      return;
    }
    u.lang = "zh-CN";
    /* speechSynthesis 的 rate 合法区间 0.1–10，夹紧防越界（Chrome 会直接抛/静音） */
    u.rate = clampNum(state.rate, 0.1, 10);
    var v = pickVoice();
    if (v) {
      u.voice = v;
      if (v.lang) u.lang = v.lang;
    }

    var settled = false;
    function next() {
      if (settled) return;
      settled = true;
      if (current !== c || c.stopped) return;
      c.utter = null;
      c.idx += 1;
      playFallbackChunk();
    }
    u.onend = next;
    u.onerror = function (e) {
      var kind = e && e.error;
      if (kind === "interrupted" || kind === "canceled") return;
      log("speechSynthesis error:", kind);
      next();
    };
    c.utter = u;
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
      /* 系统语音没有可靠的「开始播放」事件（onstart 在部分实现里不触发），
         speak() 返回即视为已进入播放态；「合成中」只用于首个块的建连等待 */
      setBtnState(c.btn, "playing");
    } catch (e) {
      flash(c.btn, "朗读失败");
      stopPlayback();
    }
  }

  function onButtonClick(turn, btn) {
    if (current && current.btn === btn) {
      stopPlayback();
      return;
    }
    stopPlayback();

    var text;
    try {
      text = textOf(turn);
    } catch (e) {
      text = "";
    }
    if (!text) {
      flash(btn, "这条消息没有可朗读的文本");
      return;
    }

    var chunks = chunkText(text, MAX_CHUNK);
    if (!chunks.length) {
      flash(btn, "这条消息没有可朗读的文本");
      return;
    }

    var session = {
      btn: btn,
      turn: turn,
      chunks: chunks,
      idx: 0,
      audio: null,
      utter: null,
      stopped: false,
      mode: "server",
      chunkAt: 0,
    };
    current = session;
    setBtnState(btn, "loading");

    if (!BASE || !TOKEN) {
      playFallbackChunk();
      return;
    }
    if (ttsReady !== false) {
      playServerChunk();
      return;
    }
    /* 上次音频失败过：先重试 /health，通了就恢复神经音色，明确不可用才降级。
       （不再像旧实现那样一次失败就永久禁用直到刷新页面） */
    probeHealth(function (ok) {
      if (current !== session || session.stopped) return;
      if (ok) {
        playServerChunk();
        return;
      }
      session.mode = "fallback";
      playFallbackChunk();
    });
  }

  /* ------------------------------------------------------------ 健康检查 */

  function healthCheck(attempt) {
    if (!BASE || !TOKEN || typeof fetch !== "function") return;
    var tries = attempt || 0;
    if (tries > 10) return;   /* 最多追 10 次（~8s），别无限轮询 */
    var ctrl = null;
    var opts = { cache: "no-store" };
    try {
      if (typeof AbortController === "function") {
        ctrl = new AbortController();
        opts.signal = ctrl.signal;
        window.setTimeout(function () {
          try {
            ctrl.abort();
          } catch (e) {
            /* ignore */
          }
        }, 3000);
      }
    } catch (e) {
      /* ignore */
    }
    fetch(BASE + "/health?t=" + encodeURIComponent(TOKEN), opts)
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (j) {
        if (!j || j.ok !== true) {
          ttsReady = false;
          return;
        }
        if (j.pending) {
          window.setTimeout(function () {
            healthCheck(tries + 1);
          }, 800);
          return;
        }
        ttsReady = j.tts === true;
        if (j.voice && typeof j.voice === "string") CFG_VOICE = j.voice;
      })
      .catch(function () {
        /* 桥不可达：保持 null，点击时仍先试音频、失败再降级 */
      });
  }

  /* 单飞 /health 探测：只用于「上一次失败过」之后的恢复判断。
     明确不可达（网络错误 / HTTP 非 2xx）才把 ttsReady 钉成 false；
     python 还在探测（pending）时不下判死结论，交给下一次点击再试。 */
  var healthProbe = null;

  function probeHealth(done) {
    if (healthProbe) {
      if (done) healthProbe.push(done);
      return;
    }
    var waiters = done ? [done] : [];
    healthProbe = waiters;
    var finished = false;
    var guard = null;

    function finish(ok, why) {
      if (finished) return;
      finished = true;
      healthProbe = null;
      if (guard) {
        try {
          window.clearTimeout(guard);
        } catch (e) {
          /* ignore */
        }
        guard = null;
      }
      if (!ok && why) log("health probe:", why);
      for (var i = 0; i < waiters.length; i++) {
        try {
          waiters[i](ok, why);
        } catch (e) {
          /* ignore */
        }
      }
    }

    if (!BASE || !TOKEN || typeof fetch !== "function") {
      finish(false, "no bridge config");
      return;
    }

    /* fetch 卡死（端口被防火墙丢包等）时不能让点击永远停在 loading */
    guard = window.setTimeout(function () {
      finish(false, "health probe timed out");
    }, 3500);

    var opts = { cache: "no-store" };
    var ctrl = null;
    try {
      if (typeof AbortController === "function") {
        ctrl = new AbortController();
        opts.signal = ctrl.signal;
        window.setTimeout(function () {
          try {
            ctrl.abort();
          } catch (e) {
            /* ignore */
          }
        }, 2000);
      }
    } catch (e) {
      /* ignore */
    }

    fetch(BASE + "/health?t=" + encodeURIComponent(TOKEN), opts)
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (j) {
        if (!j || j.ok !== true) {
          ttsReady = false;
          finish(false, "bridge health not ok");
          return;
        }
        if (typeof j.voice === "string" && j.voice) CFG_VOICE = j.voice;
        if (j.pending) {
          finish(false, "python detection pending");
          return;
        }
        ttsReady = j.tts === true;
        finish(ttsReady, ttsReady ? "" : "edge_tts unavailable");
      }, function (e) {
        ttsReady = false;
        finish(false, "bridge unreachable: " + String((e && e.message) || e));
      });
  }

  /* ------------------------------------------------------------ Observer */

  function flush() {
    if (disposed) return;
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
    }
    burstStart = 0;
    try {
      /* 合并窗口结束后才判定「有没有缺失」：流式输出期间 mutation 每秒几十次，
         每次同步扫 DOM 太贵；这里被节流到最多 ~6 次/秒，无缺失直接 no-op。
         自己的插入也会触发一轮 mutation，但那时 needsWork() 为 false，不再改 DOM，
         observer 自然收敛。 */
      if (!needsWork()) return;
      sync();
    } catch (e) {
      log("sync failed:", (e && e.message) || e);
    }
  }

  function schedule() {
    if (disposed) return;
    var now = Date.now();
    if (!burstStart) burstStart = now;
    /* 最长等 800ms：持续变更也要及时收敛 */
    if (now - burstStart >= 800) {
      flush();
      return;
    }
    /* 最少 150ms 合并窗口 */
    if (timer) return;
    timer = window.setTimeout(flush, 150);
  }

  function onMutations() {
    if (disposed) return;
    schedule();
  }

  function startObserver() {
    var root = document.documentElement || document.body;
    if (!root) {
      window.setTimeout(startObserver, 200);
      return;
    }
    try {
      observer = new MutationObserver(onMutations);
      observer.observe(root, { childList: true, subtree: true });
    } catch (e) {
      log("observer failed:", (e && e.message) || e);
    }
  }

  /* ------------------------------------------------------------ 启动 / 公开 API */

  function boot() {
    disposed = false;
    /* 热重载 / __readaloudReload 都走 boot：倍速以 localStorage 为准恢复 */
    state.rate = readStoredRate();
    injectStyle();
    try {
      sync();
    } catch (e) {
      log("initial sync failed:", (e && e.message) || e);
    }
    startObserver();
    healthCheck();
  }

  window.__readaloudDispose = function () {
    disposed = true;
    try {
      if (observer) observer.disconnect();
    } catch (e) {
      /* ignore */
    }
    observer = null;
    if (timer) {
      try {
        window.clearTimeout(timer);
      } catch (e) {
        /* ignore */
      }
      timer = 0;
    }
    burstStart = 0;
    try {
      stopPlayback();
    } catch (e) {
      /* ignore */
    }
    var btns;
    try {
      btns = document.querySelectorAll(OUR + "," + SPEED_SEL);
    } catch (e) {
      btns = [];
    }
    for (var i = 0; i < btns.length; i++) {
      try {
        if (btns[i].parentNode) btns[i].parentNode.removeChild(btns[i]);
      } catch (e) {
        /* ignore */
      }
    }
    var st = document.getElementById(STYLE_ID);
    if (st && st.parentNode) {
      try {
        st.parentNode.removeChild(st);
      } catch (e) {
        /* ignore */
      }
    }
    window.__readaloudInstalled = false;
  };

  window.__readaloudReload = function () {
    try {
      window.__readaloudDispose();
    } catch (e) {
      /* ignore */
    }
    boot();
    window.__readaloudInstalled = true;
    return { version: VERSION, buttons: document.querySelectorAll(OUR).length };
  };

  window.__readaloudVersion = VERSION;
  window.__readaloudDebug = {
    version: VERSION,
    sync: function () {
      return sync();
    },
    counts: function () {
      var turns = document.querySelectorAll(TURN_SEL);
      var n = 0;
      for (var i = 0; i < turns.length; i++) {
        /* [class*="assistant-turn"] 会同时命中回合容器和操作栏
           （栏自身 class 里带 group-hover/assistant-turn），
           只把真正包着 assistant-row 的节点算作回合，避免一格算两次。 */
        try {
          if (turns[i].querySelector(ROW_SEL)) n += 1;
        } catch (e) {
          /* ignore */
        }
      }
      return {
        turns: n,
        buttons: document.querySelectorAll(OUR).length,
        ttsReady: ttsReady,
        playing: !!current,
      };
    },
    textOf: function (turn) {
      return textOf(turn);
    },
    chunk: chunkText,
    /* 倍速：只读当前值 + 实际会拼出的 URL（离线自检用，不改状态） */
    getRate: function () {
      return state.rate;
    },
    /* 播放会话快照（热验证用：播放中切倍速时看 playbackRate 生效 + 进度连续） */
    getCurrent: function () {
      if (!current) return null;
      return {
        idx: current.idx,
        total: current.chunks.length,
        mode: current.mode,
        stopped: !!current.stopped,
        hasAudio: !!current.audio,
        playbackRate: current.audio ? current.audio.playbackRate : null,
        currentTimeMs: current.audio ? Math.round(current.audio.currentTime * 1000) : null,
      };
    },
    rateSteps: RATE_STEPS.slice(0),
    ttsUrl: function (chunk) {
      return ttsUrl(String(chunk == null ? "" : chunk));
    },
  };

  boot();
  window.__readaloudInstalled = true;

  log("renderer v" + VERSION + " ready (base=" + (BASE || "none") + ")");
})();
