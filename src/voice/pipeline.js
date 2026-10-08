// Per-session orchestrator: glues VAD → STT → LLM → TTS together for
// one WS connection. Pure logic — the WS handler in ws.js is responsible
// for moving bytes on and off the socket.
//
// Lifecycle:
//   - Construct with a `send` callback that emits messages to the
//     browser ({type, ...payload}).
//   - Feed mic PCM via pushAudio().
//   - When the model wants to call a tool, the orchestrator emits a
//     `tool_call` message and the browser handles it via the existing
//     /tool path — exactly how Gemini Live works today. The browser
//     replies with submitToolResult().
//   - On model text deltas the orchestrator buffers by sentence and
//     pipes each completed sentence into TTS so audio starts playing
//     before the model finishes generating.

import { createVad } from './vad.js';
import { transcribe } from './stt.js';
import { synth } from './tts.js';
import { createConversation, buildSystemInstruction } from './llm.js';

const TTS_FRAME_BYTES = 960 * 2;     // 40 ms of 24 kHz int16 mono per WS frame

// Match a finished sentence — Chinese punctuation and English. We emit
// each finished sentence to TTS independently so audio can start within
// ~600 ms of LLM first-token instead of waiting for the full reply.
const SENTENCE_END_RE = /[。！？!?\.\n]+["”』）)]?\s*$/;

export async function createPipeline({ send }) {
  const systemInstruction = await buildSystemInstruction();
  const conversation = createConversation({ systemInstruction });
  let currentTtsAbort = null;
  let inTurn = false;

  async function speakSentence(text) {
    if (!text || !text.trim()) return;
    currentTtsAbort?.abort();
    currentTtsAbort = new AbortController();
    try {
      let firstFrame = true;
      for await (const chunk of synth(text, { signal: currentTtsAbort.signal })) {
        // chunk is a Buffer of raw int16 PCM @ 24 kHz mono.
        // Slice into ~40 ms frames so the cylinder's playback chain
        // schedules them tightly without a single huge buffer up front.
        for (let off = 0; off < chunk.length; off += TTS_FRAME_BYTES) {
          const slice = chunk.subarray(off, Math.min(chunk.length, off + TTS_FRAME_BYTES));
          send({ type: 'audio', pcm: slice.toString('base64'), sample_rate: 24000 });
        }
        if (firstFrame) {
          send({ type: 'speaking_start' });
          firstFrame = false;
        }
      }
    } catch (err) {
      console.warn('[voice/pipeline] tts err:', err.message);
    } finally {
      currentTtsAbort = null;
    }
  }

  async function runTurn(userText) {
    if (inTurn) return;
    inTurn = true;
    send({ type: 'transcript', role: 'user', text: userText });

    let sentenceBuf = '';
    const flushSentence = async () => {
      const ready = sentenceBuf;
      sentenceBuf = '';
      if (ready.trim()) {
        send({ type: 'transcript', role: 'assistant', text: ready, partial: false });
        await speakSentence(ready);
      }
    };

    try {
      for await (const ev of conversation.turn(userText)) {
        if (ev.type === 'text_delta') {
          sentenceBuf += ev.text;
          send({ type: 'transcript', role: 'assistant', text: ev.text, partial: true });
          // Emit on sentence boundary — keeps TTS pipelined with LLM.
          if (SENTENCE_END_RE.test(sentenceBuf)) {
            await flushSentence();
          }
        } else if (ev.type === 'tool_call') {
          // Hand it to the browser — mirrors Gemini Live's toolCall shape.
          send({ type: 'tool_call', id: ev.id, name: ev.name, args: ev.args });
        } else if (ev.type === 'turn_end') {
          await flushSentence();
        } else if (ev.type === 'error') {
          console.warn('[voice/pipeline] turn error:', ev.message);
          break;
        }
      }
    } finally {
      send({ type: 'speaking_end' });
      inTurn = false;
    }
  }

  const vad = createVad({
    onSpeechStart: () => {
      send({ type: 'listening_start' });
      // User started talking — interrupt any in-flight TTS.
      currentTtsAbort?.abort();
    },
    onUtterance: async ({ samples, durationMs }) => {
      send({ type: 'listening_end' });
      try {
        const { text } = await transcribe(samples);
        if (!text || !text.trim()) return;
        await runTurn(text.trim());
      } catch (err) {
        console.warn('[voice/pipeline] stt err:', err.message);
        send({ type: 'error', message: `STT failed: ${err.message}` });
      }
    },
  });

  return {
    pushAudio(int16) { vad.pushChunk(int16); },
    submitToolResult(callId, result) { conversation.submitToolResult(callId, result); },
    // Force the model to speak an opening greeting on session start.
    async greet(text) {
      await speakSentence(text);
      send({ type: 'transcript', role: 'assistant', text, partial: false });
      send({ type: 'speaking_end' });
    },
    close() { currentTtsAbort?.abort(); },
  };
}
