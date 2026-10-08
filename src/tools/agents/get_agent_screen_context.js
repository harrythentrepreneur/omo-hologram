// src/tools/get_agent_screen_context.js
//
// Voice tool: read what's currently on one agent's monitor — active
// panel kind/label, tail of its content, recent reasoning, recent
// tools, files touched, status, last error if any. Lets omo answer
// "what is Cinder doing?" with specifics instead of generic chatter.

import * as hermes from "../../hermes/index.js";
import { refOrFocused } from "./agent_context.js";

export const definition = {
  type: "function",
  name: "get_agent_screen_context",
  description:
    "Read what's currently on one agent's screen — the file/search/url they have open, the tail of its content, recent reasoning, recent tools, status, last error. Call this BEFORE answering any 'what is X doing / what did X find / what changed / why is X stuck' question — without it you can only say generic things. Cheap to call. Pass the agent's callsign or agent_id, or omit it when the user is looking at a focused /feather tile.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description:
          "Which agent. Accepts the callsign (e.g. 'Nimbus') or agent_id. Case-insensitive; prefix-match works.",
      },
    },
    additionalProperties: false,
  },
};

function fmtElapsed(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m + "m" + (r < 10 ? "0" : "") + r + "s";
}

export async function run(args) {
  const ref = refOrFocused(args?.agent);
  if (!ref) {
    return {
      error: "missing agent reference",
      note: "Tell the user which agent — name/id, or focus a /feather tile first.",
    };
  }
  // Disambiguate first so we don't silently pick "Cinder-1" when the
  // user might have meant "Cinder-2".
  const matches = hermes.resolveActiveAgents(ref);
  if (matches.length === 0) {
    return {
      error: `no active agent matches "${ref}"`,
      note: "Tell the user that agent isn't on stage. Don't fabricate activity.",
    };
  }
  if (matches.length > 1) {
    return {
      error: `ambiguous: "${ref}" matches ${matches.length} agents`,
      candidates: matches.map((m) => ({ name: m.name, agent_id: m.agent_id })),
      note: "Ask the user WHICH agent — name them by their full callsigns. Don't guess and don't summarize across them.",
    };
  }
  const ctx = hermes.getScreenContext(matches[0].agent_id);
  if (ctx?.error) {
    return {
      error: ctx.error,
      note: "Tell the user that agent isn't on stage. Don't fabricate activity.",
    };
  }
  const elapsed = fmtElapsed(ctx.elapsed_ms);

  // Pre-bake a single conversational summary line omo can riff on,
  // following the same idiom as agent_status: structured payload first,
  // then a one-liner she can read aloud (or rephrase) without inventing.
  const lp = ctx.live_panel;
  const recentTools = (ctx.tools_recent || []).map((tt) => tt.tool).slice(-3).join(' → ');
  let summary;
  if (ctx.status === 'running') {
    if (lp && lp.kind === 'file') {
      summary = `${ctx.name} 正在 ${lp.label}${elapsed ? '，已经 ' + elapsed : ''}`;
    } else if (lp && lp.kind === 'search') {
      summary = `${ctx.name} 在搜 "${lp.label}"${elapsed ? '，已经 ' + elapsed : ''}`;
    } else if (lp && lp.kind === 'terminal') {
      summary = `${ctx.name} 在跑命令${elapsed ? '，已经 ' + elapsed : ''}`;
    } else if (lp && lp.kind === 'url') {
      summary = `${ctx.name} 在拉 ${lp.label}`;
    } else {
      summary = `${ctx.name} ${recentTools ? '刚跑了 ' + recentTools : '在思考'}${elapsed ? '，已经 ' + elapsed : ''}`;
    }
  } else if (ctx.last_error) {
    summary = `${ctx.name} 出错了：${ctx.last_error}`;
  } else {
    summary = `${ctx.name} 闲着`;
  }

  return {
    ...ctx,
    elapsed,
    summary,
    note:
      "Use the structured fields (live_panel.tail, thoughts_recent, files_touched, tools_recent, last_error) to NARRATE specifics in the SAME language the user just used. Don't read field names; weave them in like 'she's editing avatar.js, just added a smoothing line.' Don't dump file content verbatim — describe it. If last_error is set, lead with that.",
  };
}
