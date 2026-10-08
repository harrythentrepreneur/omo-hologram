// Server-side voice activity detection. Energy-based — simple, cheap,
// good enough for the spike. The mic stream is 16 kHz int16 PCM, arriving
// in ~20–60 ms chunks from the browser worklet.
//
// Algorithm: maintain a rolling RMS over the most recent frames. When
// RMS crosses a "speech-on" threshold, mark speech start and start
// collecting samples. After RMS stays below "speech-off" for at least
// SILENCE_HANGOVER_MS, emit the collected samples as one utterance.
//
// We swap this for silero-vad in the browser later — that runs at ~5 ms
// frames with neural quality, but for proving the pipeline a simple
// energy gate is fine.

const SAMPLE_RATE = 16000;
// Tuned for typical mic levels off the AudioWorklet path. Override via
// env if needed; speech-off is intentionally lower than speech-on so
// short pauses inside a sentence don't end the turn.
const SPEECH_ON_RMS = Number(process.env.VAD_SPEECH_ON_RMS) || 800;
const SPEECH_OFF_RMS = Number(process.env.VAD_SPEECH_OFF_RMS) || 400;
const SILENCE_HANGOVER_MS = Number(process.env.VAD_SILENCE_HANGOVER_MS) || 600;
const MIN_UTTERANCE_MS = 250;        // discard accidental clicks
const MAX_UTTERANCE_MS = 30_000;     // safety: force end if model never stops

function rms(int16, start, end) {
  let sum = 0;
  const n = end - start;
  if (n <= 0) return 0;
  for (let i = start; i < end; i++) {
    const v = int16[i];
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

export function createVad({ onSpeechStart, onUtterance } = {}) {
  /** @type {number[]} */
  const buffer = [];                 // int16 samples since speech-on
  let inSpeech = false;
  let speechStartTs = 0;
  let lastVoiceTs = 0;

  function reset() {
    buffer.length = 0;
    inSpeech = false;
    speechStartTs = 0;
    lastVoiceTs = 0;
  }

  function flush(reason) {
    if (!inSpeech) return;
    const durationMs = (buffer.length / SAMPLE_RATE) * 1000;
    inSpeech = false;
    if (durationMs < MIN_UTTERANCE_MS) {
      buffer.length = 0;
      return;
    }
    const samples = new Int16Array(buffer);
    buffer.length = 0;
    onUtterance?.({ samples, durationMs, reason });
  }

  // Push a new chunk of int16 PCM. Returns the current state for
  // observability (the WS layer uses this to broadcast listening flags).
  function pushChunk(int16) {
    if (!int16 || int16.length === 0) return { inSpeech };
    const energy = rms(int16, 0, int16.length);
    const now = Date.now();

    if (!inSpeech) {
      if (energy >= SPEECH_ON_RMS) {
        inSpeech = true;
        speechStartTs = now;
        lastVoiceTs = now;
        for (let i = 0; i < int16.length; i++) buffer.push(int16[i]);
        onSpeechStart?.();
      }
      // else: still silent, drop the chunk on the floor.
    } else {
      for (let i = 0; i < int16.length; i++) buffer.push(int16[i]);
      if (energy >= SPEECH_OFF_RMS) lastVoiceTs = now;

      const sinceVoice = now - lastVoiceTs;
      const utteranceMs = now - speechStartTs;
      if (sinceVoice >= SILENCE_HANGOVER_MS) {
        flush('silence');
      } else if (utteranceMs >= MAX_UTTERANCE_MS) {
        flush('max-duration');
      }
    }
    return { inSpeech, energy };
  }

  return { pushChunk, flush, reset, get inSpeech() { return inSpeech; } };
}
