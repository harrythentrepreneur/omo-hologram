// get_screen_context — returns whatever pane / panel / drill-down the
// user is currently looking at, as reported by the browser. Lets Momo
// answer "what's this?" / "who is that customer?" / "tell me more about
// that email" without guessing — she just peeks at the current view first.

import * as view from '../../momo/view.js';

export const definition = {
  type: 'function',
  name: 'get_screen_context',
  description:
    'Peek at what the user is currently looking at on the hologram (which pane is open, which panel is focused, and what detail if any is drilled into). Call this FIRST whenever the user says "this", "that", "it", "the one I just opened", "the email/charge/campaign/file I\'m looking at" — before any other tool. Returns a tiny JSON snapshot; no side effects. If nothing is open, returns ok:true with view:null.',
  parameters: { type: 'object', properties: {} },
};

export function run() {
  const v = view.getView();
  if (!v) return { ok: true, view: null, summary: 'No pane open — user is looking at the avatar only.' };
  const parts = [];
  if (v.page) parts.push(`page=${v.page}`);
  if (v.panel) parts.push(`panel=${v.panel}`);
  if (v.slot != null) parts.push(`slot=${v.slot}`);
  if (v.drilldown && v.drilldown.kind) {
    parts.push(`drilled_into=${v.drilldown.kind}`);
    if (v.drilldown.id) parts.push(`id=${v.drilldown.id}`);
    if (v.drilldown.label) parts.push(`label="${v.drilldown.label}"`);
  }
  // /feather pushes focused_agent here so short voice replies ("yes", "y",
  // "1") route to the right PTY. Surface it in the summary so the model
  // doesn't have to dig through the raw view object.
  if (v.focused_agent && (v.focused_agent.name || v.focused_agent.agent_id)) {
    const fa = v.focused_agent;
    const bits = [fa.name || fa.agent_id];
    if (fa.runtime) bits.push(String(fa.runtime));
    if (fa.status) bits.push(String(fa.status));
    if (fa.awaiting) bits.push(`awaiting=${fa.awaiting.kind || 'input'}`);
    parts.push(`focused_agent=${bits.join(' ')}`);
  }
  if (v.awaiting_agent && (v.awaiting_agent.name || v.awaiting_agent.agent_id)) {
    const aa = v.awaiting_agent;
    parts.push(`awaiting_agent=${aa.name || aa.agent_id}${aa.prompt_kind ? ` kind=${aa.prompt_kind}` : ''}${aa.question ? ` question="${aa.question}"` : ''}`);
  }
  if (v.layout && v.layout.mode) {
    parts.push(`layout=${v.layout.mode}`);
  }
  if (v.drawer && v.drawer.open) {
    const da = v.drawer.agent;
    parts.push(`drawer=${v.drawer.mode || 'open'}${da?.name ? ` agent=${da.name}` : ''}${v.drawer.selected_file ? ` file=${v.drawer.selected_file}` : ''}`);
  }
  const summary = parts.length ? parts.join(' · ') : 'Pane is open but nothing specific focused.';
  return { ok: true, view: v, summary };
}
