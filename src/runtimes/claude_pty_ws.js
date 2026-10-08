// src/runtimes/claude_pty_ws.js — WebSocket bridge for the Claude PTY.
//
// One WS endpoint: /claude-tty/ws/<agent_id>. Each connected client gets:
//   • on attach: a "claude_pty_attach" JSON header + the recent-bytes
//     replay buffer so the screen comes back populated
//   • binary frames out  → raw VT bytes from the PTY
//   • binary frames in   → raw key bytes typed at xterm's onData
//   • text frames in     → JSON control messages (resize, signal, etc.)
//   • text frames out    → JSON status events (claude_pty_exit, etc.)
//
// Multiple clients can subscribe to the same agent's PTY — keyboard
// from any of them is multiplexed into the same process; output fans
// out to all of them. This is what makes the squad-monitor tab AND
// /claude-deck see the same live session.
//
// Spawn semantics: the WS does NOT spawn a PTY on its own. The hermes
// coordinator (or a voice tool calling claude_pty.sessionFor) is the
// only thing that creates them — the WS just attaches/detaches. If the
// agent has no live PTY, the WS attach still succeeds and the client
// sees the "alive: false" header so it can render a "click to launch"
// affordance.
//
// Auth: rides the same trust model as /hermes/ws — if you can reach
// the loopback port, you can drive any agent. That's deliberate; the
// hologram and squad UIs are first-party.

import { WebSocketServer } from "ws";

import * as claudePty from "./claude_pty.js";

const WS_PATH_PREFIX = "/claude-tty/ws/";

// Optional spawn callback — caller can pass a function that knows how
// to (re)create a session for a given agent_id when the client asks
// for one explicitly. Keeps the WS free of identity / worktree logic.
let spawnRequest = null;
export function setSpawnRequestHandler(fn) {
  spawnRequest = typeof fn === "function" ? fn : null;
}

export function mountWebSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (socket, agent_id) => {
    let session = claudePty.getSession(agent_id);

    const subscriber = {
      send(payload) {
        if (socket.readyState !== 1) return;
        try {
          if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
            socket.send(payload, { binary: true });
          } else {
            socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
          }
        } catch {}
      },
    };

    function attachTo(s) {
      if (!s) return;
      session = s;
      try { s.attach(subscriber); } catch {}
    }

    function detach() {
      if (!session) return;
      try { session.detach(subscriber); } catch {}
    }

    // Poll for the session to appear. Race condition: when
    // spawn_agent_task fires, the agent_appear event lands in the
    // browser before the adapter's async `claudePty.sessionFor()` has
    // created the PTY. Without polling, the client gets one
    // `alive: false` and the late-arriving PTY has no listener.
    //
    // Strategy: try once. If miss, send alive:false so the UI can show
    // "spinning up…", then poll every 200ms for up to ~10s. When the
    // session appears, attach AND re-send the attach header with
    // alive:true so the client UI flips its status dot.
    let pollTimer = null;
    function tryLateAttach() {
      const s = claudePty.getSession(agent_id);
      if (!s) return false;
      attachTo(s);
      try {
        socket.send(JSON.stringify({
          type: "claude_pty_attach",
          agent_id,
          alive: !!s.alive,
          cols: s.cols || 0,
          rows: s.rows || 0,
          started_at: s.startedAt || Date.now(),
          exit_code: null,
          exit_signal: null,
          note: "pty appeared after initial attach",
        }));
      } catch {}
      return true;
    }
    if (session) {
      attachTo(session);
    } else {
      try {
        socket.send(JSON.stringify({
          type: "claude_pty_attach",
          agent_id,
          alive: false,
          cols: 0,
          rows: 0,
          started_at: 0,
          exit_code: null,
          exit_signal: null,
          note: "no live pty — waiting up to 10s for the runtime to spawn one",
        }));
      } catch {}
      let attempts = 0;
      pollTimer = setInterval(() => {
        if (++attempts > 50 || socket.readyState !== 1 || tryLateAttach()) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }, 200);
    }

    socket.on("message", async (raw, isBinary) => {
      // Binary frames: raw key bytes from xterm's data event. Pipe
      // straight into the PTY. No interpretation — that's the whole
      // point; we want the literal terminal experience.
      if (isBinary) {
        if (!session || !session.alive) return;
        session.write(raw);
        return;
      }
      // Text frames: JSON control messages.
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "input": {
          // String input convenience — same as a binary frame but JSON.
          if (!session || !session.alive) return;
          session.write(String(msg.text || ""));
          return;
        }
        case "resize": {
          const cols = Number(msg.cols) | 0;
          const rows = Number(msg.rows) | 0;
          if (!cols || !rows) return;
          if (session) session.resize(cols, rows);
          return;
        }
        case "signal": {
          if (session && session.alive) {
            session.signal(String(msg.signal || "SIGINT"));
          }
          return;
        }
        case "request_spawn": {
          // Caller-driven spawn — only honored when a spawn handler is
          // registered (so the WS doesn't accidentally edit the user's
          // real checkout). Hermes will register one.
          if (!spawnRequest) {
            try {
              socket.send(JSON.stringify({
                type: "claude_pty_error",
                agent_id,
                error: "no spawn handler installed",
              }));
            } catch {}
            return;
          }
          try {
            const fresh = await spawnRequest(agent_id, msg);
            if (fresh) attachTo(fresh);
          } catch (err) {
            try {
              socket.send(JSON.stringify({
                type: "claude_pty_error",
                agent_id,
                error: String(err?.message || err),
              }));
            } catch {}
          }
          return;
        }
        default:
          return;
      }
    });

    socket.on("close", () => { detach(); if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } });
    socket.on("error", () => { detach(); if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } });
  });

  httpServer.on("upgrade", (req, sock, head) => {
    const path = (req.url || "").split("?")[0];
    if (!path.startsWith(WS_PATH_PREFIX)) return;
    const agent_id = decodeURIComponent(path.slice(WS_PATH_PREFIX.length)).trim();
    if (!agent_id) {
      try { sock.destroy(); } catch {}
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, agent_id));
  });

  return wss;
}
