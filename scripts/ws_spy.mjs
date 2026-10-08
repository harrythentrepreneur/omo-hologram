import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:8080/omo/ws');
const seen = { task_spawn: 0, task_progress: 0, task_complete: 0 };
const narrated = [];
ws.on('open', () => console.log('[spy] connected'));
ws.on('message', (buf) => {
  let m;
  try { m = JSON.parse(buf.toString()); } catch { return; }
  if (m.type !== 'event' || m.event?.source !== 'agents') return;
  const ev = m.event;
  if (!['task_spawn','task_progress','task_complete'].includes(ev.kind)) return;
  seen[ev.kind]++;
  const turn = ev.data?.turn;
  const tag = ev.kind.padEnd(14);
  const nar = ev.data?.narrate === true ? 'NARRATE' : '       ';
  const info = ev.kind === 'task_complete'
    ? `status=${ev.data.status} result="${(ev.data.result || ev.data.error || '').slice(0,80)}"`
    : turn ? `turn.kind=${turn.kind} ${turn.kind === 'text' ? `text="${(turn.text||'').slice(0,70)}"` : turn.kind === 'tool_use' ? `${turn.toolName}(${(turn.toolInput||'').slice(0,50)})` : `snippet="${(turn.snippet||'').slice(0,50)}"${turn.isError?' [ERR]':''}`}`
    : `phase=${ev.data.phase || '-'} liveView=${ev.data.liveViewUrl ? 'yes' : 'no'}`;
  console.log(`${nar} ${tag} ${info}`);
  if (ev.data?.narrate) narrated.push({ kind: ev.kind, turn_kind: turn?.kind, preview: (turn?.text || turn?.snippet || ev.data.progressSummary || '').slice(0,60) });
});
setTimeout(() => {
  console.log('\n=== SUMMARY ===');
  console.log('counts:', seen);
  console.log('narrated events:', narrated.length);
  narrated.forEach((n,i) => console.log(`  ${i+1}. ${n.kind} (${n.turn_kind}) → "${n.preview}"`));
  process.exit(0);
}, 55000);
