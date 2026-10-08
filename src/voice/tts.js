// TTS — two backends, selected via TTS_BACKEND env:
//
//   TTS_BACKEND=edge_tts  (default) — wraps the `edge-tts` Python CLI
//                          (Microsoft Edge's free neural-voice endpoint),
//                          piped through ffmpeg to 24 kHz mono int16 PCM.
//   TTS_BACKEND=mlx_omni  — POSTs text to mlx-omni-server's
//                          /v1/audio/speech (F5-TTS-MLX, fully local).
//                          Returns WAV; we strip the header and yield
//                          int16 PCM at the file's sample rate.
//
// Both backends produce: AsyncIterable<Buffer of int16 PCM @ 24 kHz mono>
// so the WS layer can frame them identically.

import { spawn } from 'node:child_process';

const BACKEND = process.env.TTS_BACKEND || 'edge_tts';

const DEFAULT_VOICE = process.env.TTS_VOICE || 'zh-CN-XiaoxiaoNeural';
const DEFAULT_RATE = process.env.TTS_RATE || '+8%';
const DEFAULT_PITCH = process.env.TTS_PITCH || '+2Hz';
const EDGE_TTS_BIN = process.env.EDGE_TTS_BIN || 'edge-tts';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';

const MLX_BASE_URL = process.env.MLX_OMNI_BASE_URL || 'http://localhost:10240/v1';
const MLX_TTS_MODEL = process.env.MLX_TTS_MODEL || 'lucasnewman/f5-tts-mlx';
const MLX_TTS_VOICE = process.env.MLX_TTS_VOICE || 'alloy';

let availability = null;
export async function ensureTtsAvailable() {
  if (availability) return availability;
  availability = (async () => {
    if (BACKEND === 'mlx_omni') {
      try {
        const r = await fetch(`${MLX_BASE_URL}/models`, { signal: AbortSignal.timeout(2000) });
        if (!r.ok) return { ok: false, reason: `mlx-omni-server unreachable at ${MLX_BASE_URL} (${r.status})` };
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: `mlx-omni-server unreachable at ${MLX_BASE_URL}: ${err.message}` };
      }
    }
    const checkBin = (bin, args) => new Promise((resolve) => {
      const p = spawn(bin, args, { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0 || code === 1 || code === 2));
    });
    if (!(await checkBin(EDGE_TTS_BIN, ['--help']))) {
      return { ok: false, reason: `${EDGE_TTS_BIN} not on PATH — run bin/install-voice-deps.sh (pipx install edge-tts)` };
    }
    if (!(await checkBin(FFMPEG_BIN, ['-version']))) {
      return { ok: false, reason: `${FFMPEG_BIN} not on PATH — brew install ffmpeg` };
    }
    return { ok: true };
  })();
  return availability;
}

// ─── edge_tts backend ──────────────────────────────────────────────
async function* synthEdgeTts(text, { voice, rate, pitch, signal }) {
  if (!text || !text.trim()) return;
  const ttsArgs = [
    '--voice', voice || DEFAULT_VOICE,
    '--rate',  rate  || DEFAULT_RATE,
    '--pitch', pitch || DEFAULT_PITCH,
    '--text',  text,
  ];
  const ttsProc = spawn(EDGE_TTS_BIN, ttsArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  ttsProc.stderr.on('data', (d) => {
    const s = d.toString();
    if (/error|exception|failed/i.test(s)) console.warn('[tts]', s.trim());
  });

  const ffArgs = [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-ac', '1',
    '-ar', '24000',
    '-f', 's16le',
    'pipe:1',
  ];
  const ffProc = spawn(FFMPEG_BIN, ffArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  ttsProc.stdout.pipe(ffProc.stdin);
  ttsProc.stdout.on('error', () => {});
  ffProc.stdin.on('error', () => {});

  const onAbort = () => { try { ttsProc.kill('SIGTERM'); } catch {} try { ffProc.kill('SIGTERM'); } catch {} };
  if (signal) {
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    for await (const chunk of ffProc.stdout) yield chunk;
  } finally {
    onAbort();
  }
}

// ─── mlx_omni backend ──────────────────────────────────────────────
// Strip a RIFF/WAVE header and return { sampleRate, pcm: Buffer of int16 }.
function parseWav(buf) {
  if (buf.length < 44 || buf.slice(0, 4).toString() !== 'RIFF' || buf.slice(8, 12).toString() !== 'WAVE') {
    throw new Error('mlx-omni TTS: response is not a WAV');
  }
  // Walk the chunks to find 'data' — header is normally 44 bytes for
  // PCM but some encoders pad with a 'LIST' or 'JUNK' chunk first.
  let off = 12;
  let sampleRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.slice(off, off + 4).toString();
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      sampleRate = buf.readUInt32LE(off + 8 + 4);
    } else if (id === 'data') {
      const start = off + 8;
      const end = Math.min(buf.length, start + size);
      return { sampleRate, pcm: buf.subarray(start, end) };
    }
    off += 8 + size + (size % 2); // word-aligned
  }
  throw new Error('mlx-omni TTS: WAV had no data chunk');
}

// Linear-interpolation resample. F5-TTS emits 24 kHz natively so this
// is usually a no-op; safety-net for other models.
function resampleInt16(srcInt16, srcRate, dstRate) {
  if (srcRate === dstRate) return Buffer.from(srcInt16.buffer, srcInt16.byteOffset, srcInt16.byteLength);
  const ratio = srcRate / dstRate;
  const dstLen = Math.floor(srcInt16.length / ratio);
  const dst = new Int16Array(dstLen);
  for (let i = 0; i < dstLen; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(srcInt16.length - 1, i0 + 1);
    const t = x - i0;
    dst[i] = (srcInt16[i0] * (1 - t) + srcInt16[i1] * t) | 0;
  }
  return Buffer.from(dst.buffer);
}

async function* synthMlxOmni(text, { voice, signal }) {
  if (!text || !text.trim()) return;
  const res = await fetch(`${MLX_BASE_URL}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MLX_TTS_MODEL,
      input: text,
      voice: voice || MLX_TTS_VOICE,
      response_format: 'wav',
    }),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`mlx-omni TTS ${res.status}: ${t.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const { sampleRate, pcm } = parseWav(buf);
  // pcm is little-endian int16 — view as Int16Array (need an aligned copy
  // so the underlying ArrayBuffer's byteOffset is 0).
  const int16 = new Int16Array(pcm.byteLength / 2);
  for (let i = 0; i < int16.length; i++) {
    int16[i] = pcm.readInt16LE(i * 2);
  }
  // Yield in ~40 ms frames at 24 kHz so the cylinder schedules them
  // tightly without one giant buffer up front. (Resample first if needed.)
  const out = resampleInt16(int16, sampleRate, 24000);
  const frameBytes = 24000 * 0.04 * 2;   // 1920 bytes
  for (let off = 0; off < out.length; off += frameBytes) {
    yield out.subarray(off, Math.min(out.length, off + frameBytes));
  }
}

export async function* synth(text, opts = {}) {
  const status = await ensureTtsAvailable();
  if (!status.ok) throw new Error(status.reason);
  if (BACKEND === 'mlx_omni') {
    yield* synthMlxOmni(text, opts);
  } else {
    yield* synthEdgeTts(text, opts);
  }
}
