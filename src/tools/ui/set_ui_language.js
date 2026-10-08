// src/tools/set_ui_language.js — voice-driven UI language toggle.
//
// When the user says something like "translate the app to Chinese" / "give
// me the UI in English" / "把界面切成中文", Momo calls this tool. We emit a
// `ui_lang` event onto the dataCore bus → /omo/ws fanout. Every open tab's
// public/i18n.js subscribes to that channel and flips its UI in place
// without a reload. localStorage handles persistence + cross-tab sync.
//
// Default UI language is English; this tool is the only path that flips
// it back and forth. Voice itself is decoupled — Momo's spoken language
// follows the user's last utterance, regardless of UI language.

import * as dataCore from "../../data_core.js";

const SUPPORTED = new Set(["en", "zh"]);

// Map a few user-friendly aliases the model is likely to pass through.
const ALIASES = {
  english: "en",
  en: "en",
  "en-us": "en",
  "en-gb": "en",
  chinese: "zh",
  "simplified chinese": "zh",
  mandarin: "zh",
  zh: "zh",
  "zh-cn": "zh",
  cn: "zh",
  中文: "zh",
  简体中文: "zh",
  英文: "en",
};

function normaliseLang(input) {
  const k = String(input || "").trim().toLowerCase();
  if (!k) return null;
  if (ALIASES[k]) return ALIASES[k];
  if (SUPPORTED.has(k)) return k;
  return null;
}

export const definition = {
  type: "function",
  name: "set_ui_language",
  description:
    "Switch the on-screen UI language between English and Simplified Chinese. Use this when the user says things like \"translate the app to Chinese\", \"switch the UI to English\", \"把界面切成中文\", \"用英文显示\". Default is English. This ONLY changes the visible UI text on every open tab — your spoken voice still mirrors whatever language the user is speaking to you in. After calling, say one short cute sentence acknowledging the flip in the user's spoken language (don't reload the page; the change is instant).",
  parameters: {
    type: "object",
    properties: {
      lang: {
        type: "string",
        description:
          "Target UI language. Use 'en' for English or 'zh' for Simplified Chinese. Friendly aliases ('english', 'chinese', 'mandarin', '中文', '简体中文') are also accepted.",
      },
    },
    required: ["lang"],
    additionalProperties: false,
  },
};

export async function run(args) {
  const lang = normaliseLang(args?.lang);
  if (!lang) {
    return {
      error: `Unsupported language: ${JSON.stringify(args?.lang)}. Supported: 'en' (English), 'zh' (Simplified Chinese).`,
    };
  }

  // Broadcast onto /omo/ws — every open tab's i18n.js listens for kind=ui_lang.
  dataCore.emit({
    source: "system",
    kind: "ui_lang",
    ts: Date.now(),
    title: `UI language → ${lang}`,
    data: { lang },
  });

  return {
    ok: true,
    lang,
    note:
      lang === "zh"
        ? "界面已经切到中文啦~ 用一句很短的话告诉用户搞定了（用用户刚才说话的那种语言），不用重新加载页面。"
        : "UI is now in English. Acknowledge with one short sentence in the user's spoken language — no reload needed.",
  };
}
