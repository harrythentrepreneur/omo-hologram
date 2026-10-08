// WebSocket handler for the local voice pipeline. Mirrors the
// Gemini Live message shape closely enough that the cylinder can branch
// on a single line in connect() rather than forking the whole UI path.
//
// Inbound (browser → server):
//   { type: "audio", pcm: <base64 16 kHz int16 PCM> }
//   { type: "tool_result", id, output }
//   { type: "interrupt" }                       // user talked over
//   { type: "client_text", text }               // text-channel chat
//
// Outbound (server → browser):
//   { type: "ready" }                           // pipeline is constructed
//   { type: "audio", pcm: <base64 24 kHz>, sample_rate: 24000 }
//   { type: "tool_call", id, name, args }
//   { type: "transcript", role, text, partial? }
//   { type: "listening_start" } / { type: "listening_end" }
//   { type: "speaking_start" }   / { type: "speaking_end" }
//   { type: "error", message }

import { WebSocketServer } from 'ws';
import { createPipeline } from './pipeline.js';
import { ensureWhisperAvailable } from './stt.js';
import { ensureTtsAvailable } from './tts.js';

const OPENING_GREETING = process.env.VOICE_OPENING_GREETING
  || 'Hi~ I\'m omo. What\'s up?';

export function attachVoiceWebSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, sock, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/voice/ws') return;
    wss.handleUpgrade(req, sock, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (ws) => {
    const send = (msg) => {
      if (ws.readyState !== ws.OPEN) return;
      try { ws.send(JSON.stringify(msg)); } catch {}
    };

    // Preflight: surface a clean error message if Whisper or edge-tts
    // isn't installed instead of failing on the first utterance.
    const [stt, tts] = await Promise.all([ensureWhisperAvailable(), ensureTtsAvailable()]);
    if (!stt.ok) { send({ type: 'error', message: stt.reason }); ws.close(); return; }
    if (!tts.ok) { send({ type: 'error', message: tts.reason }); ws.close(); return; }

    let pipeline;
    try {
      pipeline = await createPipeline({ send });
    } catch (err) {
      send({ type: 'error', message: `pipeline init failed: ${err.message}` });
      ws.close();
      return;
    }

    send({ type: 'ready' });
    // Speak the opening line so it matches the Gemini Live UX.
    pipeline.greet(OPENING_GREETING).catch((err) => console.warn('[voice/ws] greet err:', err.message));

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;          // we use JSON-over-text frames
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'audio' && typeof msg.pcm === 'string') {
        const buf = Buffer.from(msg.pcm, 'base64');
        // 16 kHz int16 mono — view the buffer as Int16Array.
        const int16 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
        pipeline.pushAudio(int16);
      } else if (msg.type === 'tool_result') {
        pipeline.submitToolResult(msg.id, msg.output);
      } else if (msg.type === 'interrupt') {
        pipeline.close();              // aborts in-flight TTS
      }
    });

    ws.on('close', () => {
      pipeline?.close();
    });
  });

  return wss;
}
