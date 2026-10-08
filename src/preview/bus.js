// src/preview/bus.js — server → holo WS push channel for preview commands.
//
// The /omo/preview/ws endpoint is a tiny broadcast WS used exclusively
// to send voice-driven preview commands from the preview tools (which
// run server-side) down to the holo client (which forwards them into
// the /preview pane via postMessage).
//
// Why a separate channel instead of /omo/ws? Two reasons:
//   1. /omo/ws is broadcast to every connected page (/hq, /squad, …).
//      Preview commands are scoped to the holo's preview pane; spamming
//      them across all clients is noise.
//   2. The holo can open this WS only while a /preview pane is mounted
//      (and close it on dismount), so the commands have nowhere to land
//      when they shouldn't apply. Easier mental model.
//
// Hard rules:
//   • never throw at module load
//   • broadcast() is a no-op when no holo is connected (lets the ack
//     timeout in src/preview/acks.js do the right thing)

import { WebSocketServer } from 'ws';

const clients = new Set();
let wss = null;

export function mountWebSocket(httpServer) {
  if (wss) return wss;
  wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket) => {
    clients.add(socket);
    // Hello so the client can confirm it landed on the right WS.
    try { socket.send(JSON.stringify({ type: 'hello', v: 1, ts: Date.now() })); } catch {}
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
  httpServer.on('upgrade', (req, sock, head) => {
    const path = (req.url || '').split('?')[0];
    if (path !== '/omo/preview/ws') return;
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req));
  });
  return wss;
}

// Push a command envelope to every connected holo. Returns the number of
// clients we attempted to reach (0 = nobody listening, ack will time out).
export function broadcast(envelope) {
  if (!envelope || typeof envelope !== 'object') return 0;
  const text = JSON.stringify(envelope);
  let reached = 0;
  for (const sock of clients) {
    try {
      if (sock.readyState === 1) {
        sock.send(text);
        reached += 1;
      }
    } catch {}
  }
  return reached;
}

export function clientCount() { return clients.size; }
