// public/i18n.js — lightweight UI translation for omo.
//
// Default UI language is English. The user can flip to Simplified Chinese
// either via a UI toggle or by telling the agent ("translate the app to
// Chinese", "switch UI to English"). The agent calls the server tool
// `set_ui_language`, which broadcasts a `ui_lang` event onto /omo/ws —
// every open tab listens and flips its UI in place.
//
// Conventions:
//  · The English string IS the dictionary key. No symbol-keys, no JSON
//    bundles. Keeps source readable and avoids a translation maintenance
//    burden for strings that don't have a Chinese match (they fall back
//    to English transparently).
//  · HTML opt-in: add `data-i18n` on any element whose textContent should
//    be translated. The module captures the original English on first
//    apply (stashed in dataset.i18nSrc) so re-applying later works.
//  · JS opt-in: call `window.i18n.t("ENGLISH STRING")` anywhere a string
//    is assigned dynamically. If lang is "en" or the dictionary lacks an
//    entry, the input string is returned unchanged.
//  · Brand names (STRIPE, GMAIL, META ADS, GOOGLE DRIVE) are intentionally
//    NOT translated — they're product identities, not UI chrome.

(function () {
  const STORAGE_KEY = "omo.ui.lang";
  const DEFAULT_LANG = "en";
  const SUPPORTED = new Set(["en", "zh"]);

  // EN → ZH dictionary. Add entries here when you tag new strings. Missing
  // entries fall back to the English source, so partial coverage is fine.
  const DICT_ZH = {
    // ─── Connect modal (hq.html) ───────────────────────────────────────
    "[ ESC ] CANCEL": "[ ESC ] 取消",
    "[ ESC ] CLOSE": "[ ESC ] 关闭",
    "[ ENTER ] AUTHORIZE": "[ ENTER ] 授权",
    "[ ENTER ] CONNECT": "[ ENTER ] 连接",
    "[ ENTER ] RETRY": "[ ENTER ] 重试",
    "[ ENTER ] SIGN IN WITH GOOGLE": "[ ENTER ] 用 Google 登录",
    "[ NOT CONNECTED ]": "[ 未连接 ]",
    "[ CONNECT ▸ ]": "[ 连接 ▸ ]",
    "[ CONNECTED ✓ ]": "[ 已连接 ✓ ]",
    "[ CONNECTING… ]": "[ 连接中… ]",

    // ─── HQ topbar / windows ───────────────────────────────────────────
    "TODAY": "今日",
    "7D": "7天",
    "30D": "30天",
    "SPAWN AGENT": "派智能体",
    "uptime": "运行",
    "heard": "听到",
    "wds": "字",
    "integ": "集成",
    "[ DATA ▸ ]": "[ 数据 ▸ ]",
    "[ DUMP ▸ ]": "[ 转储 ▸ ]",

    // ─── Stripe panel ──────────────────────────────────────────────────
    "REVENUE": "收入",
    "· today": "· 今日",
    "MRR": "MRR",
    "SUBS": "订阅",
    "FAIL %": "失败率",
    "NEXT POUT": "下次到账",
    "NEXT PAYOUT": "下次到账",
    "FAIL RATE": "失败率",
    "REFUND RATE": "退款率",
    "DISPUTES": "争议",
    "ARPU": "ARPU",
    "ACCOUNT": "账户",
    "MODE": "模式",
    "AVG CHARGE": "平均订单",
    "LAST SYNC": "最近同步",
    "NEW CUSTOMERS · 30d": "新客户 · 30天",
    "◆ 30-DAY REVENUE": "◆ 30 天收入",
    "◆ ACTIVE PLANS": "◆ 活跃套餐",
    "◆ TOP CUSTOMERS · 30d": "◆ 主要客户 · 30天",
    "◆ LIVE CHARGE FEED": "◆ 实时交易流",
    "◆ PAYOUTS": "◆ 打款",
    "◆ RISK & FAILS · 30d": "◆ 风险与失败 · 30天",
    "PLAN": "套餐",
    "ARR": "ARR",
    "CUSTOMER": "客户",
    "TXNS": "笔数",
    "PAID": "已付",
    "gross revenue": "总收入",
    "7d avg": "7 天均值",
    "failed": "失败",
    "loading revenue…": "加载收入…",
    "loading…": "加载中…",
    "loading charges…": "加载交易…",
    "loading plans…": "加载套餐…",
    "loading customers…": "加载客户…",
    "no payouts yet…": "暂无打款…",
    "nothing to flag · clean": "无异常 · 都好",

    // ─── Meta panel ────────────────────────────────────────────────────
    "ADS": "广告",
    "· adsets · today": "· 广告组 · 今日",
    "spend": "花销",
    "SPEND": "花销",
    "ROAS": "ROAS",
    "CTR": "CTR",
    "CPC": "CPC",
    "CPM": "CPM",
    "loading adsets…": "加载广告组…",

    // ─── Gmail panel ───────────────────────────────────────────────────
    "INBOX": "收件箱",
    "unread": "未读",
    "last 7d": "近 7 天",
    "needs reply": "待回复",
    "loading inbox…": "加载收件箱…",
    "all clear": "都清空啦",
    "filter inbox · sender, subject, snippet…": "过滤收件箱 · 发件人、主题、摘要…",
    "account": "账户",
    "total msgs": "邮件总数",
    "threads": "会话",
    "last poll": "最近轮询",
    "deep sync": "深度同步",
    "persisted": "已存储",

    // ─── Drive panel ───────────────────────────────────────────────────
    "DOCS": "文档",
    "TOTAL FILES": "总文件",
    "MODIFIED TODAY": "今日修改",
    "ACTIVE · 1H": "活跃 · 1H",
    "DOC BODIES": "已索引",
    "STORAGE": "存储",
    "▦ FILE TYPES": "▦ 文件类型",
    "◎ TOP COLLABORATORS": "◎ 主要协作人",
    "⚡ HOT · edited <1h": "⚡ 热点 · 1h 内修改",
    "⟐ RECENT ACTIVITY": "⟐ 最近活动",
    "◉ ACCOUNT": "◉ 账户",
    "▣ ALL FILES": "▣ 全部文件",
    "awaiting index…": "等待索引中…",
    "no co-owners seen yet…": "暂无协作人…",
    "nothing hot right now…": "暂无热点…",
    "no activity in last 24h…": "近 24 小时无活动…",
    "no files persisted yet…": "暂无已存储文件…",
    "email": "邮箱",
    "last index": "最近索引",
    "quota": "配额",

    // ─── Transcript panel ──────────────────────────────────────────────
    "OVERHEARD": "环境聆听",
    "· local · idle": "· 本地 · 空闲",

    // ─── Holo cylinder toolbar ─────────────────────────────────────────
    "BG": "底色",
    "SAVE POS": "保存位置",
    "CALIBRATE": "校准",
    "TEST": "测试",
    "FULLSCREEN": "全屏",
    "RESET": "重置",
    "SAVE": "保存",
    "AGENT": "智能体",
    "FRONT·BACK": "前·后",
    "CYLINDER": "圆柱",
    "CYL 360°": "圆柱 360°",
    "SAVE AS DEFAULT": "保存为默认",

    // ─── Agents grid / shared status verbs ─────────────────────────────
    "IDLE": "空闲",
    "BUSY": "运行中",
    "DONE": "完成",
    "ERROR": "出错",
    "RUNNING": "运行中",
    "READY": "就绪",
    "OFFLINE": "离线",
    "TIME": "时间",
    "probing…": "探测中…",
    "offline": "离线",
    "MANUAL DISPATCH": "手动派发",
    "task description for the agent": "给智能体的任务描述",
    "auto-pick slot": "自动选格",
    "atlas · research": "atlas · 研究",
    "cinder · code": "cinder · 代码",
    "prism · data": "prism · 数据",
    "quill · writing": "quill · 写作",
    "browser · live": "浏览器 · 实时",
    "low": "低",
    "medium": "中",
    "high": "高",
    "DISPATCH →": "派发 →",
  };

  const DICTS = { en: null, zh: DICT_ZH };

  function readPersisted() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v && SUPPORTED.has(v)) return v;
    } catch {}
    return DEFAULT_LANG;
  }

  let currentLang = readPersisted();

  function t(s) {
    if (s == null) return s;
    if (currentLang === "en") return s;
    const dict = DICTS[currentLang];
    if (!dict) return s;
    return Object.prototype.hasOwnProperty.call(dict, s) ? dict[s] : s;
  }

  function apply(root) {
    const scope = root || document;
    // 1) textContent translation — `<el data-i18n>HELLO</el>`.
    for (const el of scope.querySelectorAll("[data-i18n]")) {
      // Capture the English source the first time we touch this element,
      // so subsequent lang flips translate from the canonical text rather
      // than from whatever Chinese we last set.
      if (!el.dataset.i18nSrc) {
        el.dataset.i18nSrc = el.textContent;
      }
      const src = el.dataset.i18nSrc;
      const out = t(src);
      if (el.textContent !== out) el.textContent = out;
    }
    // 2) Attribute translation — `<el data-i18n-placeholder="search…">`,
    //    `<el data-i18n-title="open">`, `<el data-i18n-aria-label="…">`.
    //    Value of the attribute IS the English source. Convention: use any
    //    `data-i18n-<attr>` and the value will land on `<attr>`.
    for (const el of scope.querySelectorAll("*")) {
      if (!el.dataset) continue;
      for (const k of Object.keys(el.dataset)) {
        if (k === "i18n" || k === "i18nSrc") continue;
        if (!k.startsWith("i18n")) continue;
        // dataset key `i18nPlaceholder` → attribute `placeholder`,
        // `i18nAriaLabel` → `aria-label`. Strip the i18n prefix and
        // convert camelCase tail into kebab-case.
        const tail = k.slice(4);
        if (!tail) continue;
        const attrName = tail
          .replace(/^[A-Z]/, (c) => c.toLowerCase())
          .replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
        const src = el.dataset[k];
        if (!src) continue;
        const out = t(src);
        if (el.getAttribute(attrName) !== out) el.setAttribute(attrName, out);
      }
    }
    // <html lang> is consumed by browsers (font hints, screen readers, etc.)
    try { document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en"; } catch {}
  }

  function set(lang) {
    if (!SUPPORTED.has(lang)) return false;
    if (lang === currentLang) return true;
    currentLang = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
    apply();
    try { window.dispatchEvent(new CustomEvent("i18n:change", { detail: { lang } })); } catch {}
    return true;
  }

  function get() { return currentLang; }

  // Set an element's text content from an English source string, recording
  // the canonical English on the node so a later lang flip re-translates
  // from the right key (rather than from whatever was last visible).
  // This is the helper to use for any JS-driven textContent update that
  // currently writes English directly (modal buttons, status labels, etc.).
  function setText(el, en) {
    if (!el) return;
    el.dataset.i18n = "";
    el.dataset.i18nSrc = en;
    el.textContent = t(en);
  }

  // Cross-tab sync: localStorage `storage` events fire in OTHER tabs of
  // the same origin when one tab writes. Pick up the new lang there.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    if (!SUPPORTED.has(e.newValue) || e.newValue === currentLang) return;
    currentLang = e.newValue;
    apply();
    try { window.dispatchEvent(new CustomEvent("i18n:change", { detail: { lang: currentLang } })); } catch {}
  });

  // Server broadcast sync: when the agent calls set_ui_language, the tool
  // emits a `ui_lang` event on the dataCore bus → /omo/ws. We listen here
  // so all open tabs flip in unison without each one needing its own
  // tool call.
  function startServerSync() {
    if (location.protocol === "file:") return;
    let ws = null;
    function connect() {
      try {
        const url = new URL("/omo/ws", location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(url.href);
      } catch { return; }
      ws.addEventListener("message", (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        if (msg?.type !== "event") return;
        const ev = msg.event;
        if (ev?.kind !== "ui_lang") return;
        const lang = ev?.data?.lang;
        if (lang && SUPPORTED.has(lang)) set(lang);
      });
      ws.addEventListener("close", () => {
        ws = null;
        // Light reconnect — no aggressive backoff needed; this is a tiny channel.
        setTimeout(connect, 3000);
      });
      ws.addEventListener("error", () => { try { ws?.close(); } catch {} });
    }
    connect();
  }

  // Boot: apply current lang to whatever's in the DOM right now, and again
  // after DOMContentLoaded for elements added by inline scripts running
  // during initial parse.
  function boot() {
    apply();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => apply(), { once: true });
    }
    startServerSync();
  }

  window.i18n = { t, set, get, apply, setText };
  boot();
})();
