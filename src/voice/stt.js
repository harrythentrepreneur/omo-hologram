// Whisper STT — two backends, selected via STT_BACKEND env:
//
//   STT_BACKEND=whisper_cpp  (default) — shells out to the `whisper-cli`
//                            binary from `brew install whisper-cpp`.
//                            16 kHz int16 PCM in → text out.
//   STT_BACKEND=mlx_omni     — POSTs WAV to mlx-omni-server's
//                            /v1/audio/transcriptions endpoint (OpenAI-
//                            compatible). The server runs MLX-Whisper on
//                            Metal, no subprocess.
//
// Both produce { text, durationMs }.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const BACKEND = process.env.STT_BACKEND || 'whisper_cpp';
const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL_PATH
  || path.join(os.homedir(), '.cache/whisper/ggml-large-v3-turbo.bin');
const WHISPER_LANG = process.env.WHISPER_LANG || 'auto';
const WHISPER_THREADS = Number(process.env.WHISPER_THREADS) || Math.max(2, Math.min(8, os.cpus().length - 2));

const MLX_BASE_URL = process.env.MLX_OMNI_BASE_URL || 'http://localhost:10240/v1';
const MLX_STT_MODEL = process.env.MLX_STT_MODEL || 'mlx-community/whisper-large-v3-turbo';

let availability = null;

export async function ensureWhisperAvailable() {
  if (availability) return availability;
  availability = (async () => {
    if (BACKEND === 'mlx_omni') {
      // Cheap probe — does the server answer at all?
      try {
        const r = await fetch(`${MLX_BASE_URL}/models`, { signal: AbortSignal.timeout(2000) });
        if (!r.ok) return { ok: false, reason: `mlx-omni-server unreachable at ${MLX_BASE_URL} (${r.status})` };
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: `mlx-omni-server unreachable at ${MLX_BASE_URL}: ${err.message}` };
      }
    }
    try { await fs.access(WHISPER_MODEL); }
    catch { return { ok: false, reason: `whisper model not found at ${WHISPER_MODEL} — run bin/install-voice-deps.sh` }; }
    const which = await new Promise((resolve) => {
      const p = spawn(WHISPER_BIN, ['--help'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0 || code === 1));
    });
    if (!which) return { ok: false, reason: `${WHISPER_BIN} not on PATH — run bin/install-voice-deps.sh (brew install whisper-cpp)` };
    return { ok: true };
  })();
  return availability;
}

// Build an in-memory 16 kHz mono int16 PCM WAV — used by both backends.
function pcm16ToWav(int16) {
  const sampleRate = 16000;
  const byteRate = sampleRate * 2;
  const dataLen = int16.byteLength;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).copy(buf, 44);
  return buf;
}

async function transcribeWhisperCpp(int16, language) {
  const wav = pcm16ToWav(int16);
  const tmpDir = os.tmpdir();
  const id = randomUUID().slice(0, 8);
  const wavPath = path.join(tmpDir, `omo-stt-${id}.wav`);
  await fs.writeFile(wavPath, wav);

  const args = [
    '-m', WHISPER_MODEL,
    '-f', wavPath,
    '-l', language || WHISPER_LANG,
    '-t', String(WHISPER_THREADS),
    '-otxt', '-of', wavPath.replace(/\.wav$/, ''),
    '--no-prints', '--no-timestamps',
  ];

  await new Promise((resolve, reject) => {
    const p = spawn(WHISPER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`whisper-cli exit ${code}: ${stderr.slice(0, 400)}`)));
  });

  const txtPath = wavPath.replace(/\.wav$/, '.txt');
  let text = '';
  try { text = (await fs.readFile(txtPath, 'utf8')).trim(); } catch {}
  fs.unlink(wavPath).catch(() => {});
  fs.unlink(txtPath).catch(() => {});
  return text;
}

async function transcribeMlxOmni(int16, language) {
  const wav = pcm16ToWav(int16);
  // Build a multipart/form-data body manually — avoids pulling in
  // form-data on Node 20+ where Blob+FormData are native.
  const form = new FormData();
  form.set('model', MLX_STT_MODEL);
  if (language && language !== 'auto') form.set('language', language);
  form.set('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');

  const res = await fetch(`${MLX_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`mlx-omni STT ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.text || '').trim();
}

export async function transcribe(int16, { language } = {}) {
  const status = await ensureWhisperAvailable();
  if (!status.ok) throw new Error(status.reason);
  if (!int16 || int16.length === 0) return { text: '', durationMs: 0 };

  const t0 = Date.now();
  const text = BACKEND === 'mlx_omni'
    ? await transcribeMlxOmni(int16, language)
    : await transcribeWhisperCpp(int16, language);
  return { text, durationMs: Date.now() - t0 };
}
