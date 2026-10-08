// Temporary voice-preview utility. Renders the 30 Gemini prebuilt voices
// to short WAV clips using gemini-3.1-flash-tts-preview so we can audition
// them before committing to a GEMINI_VOICE in .env. Not part of the core
// Momo runtime — safe to delete once a voice is picked.

import { GoogleGenAI } from '@google/genai';

const TTS_MODEL = process.env.TTS_MODEL || 'gemini-3.1-flash-tts-preview';
const SAMPLE_RATE = 24000; // Gemini TTS output is 24 kHz mono PCM16

export const VOICES = [
  { name: 'Zephyr',         vibe: 'Bright' },
  { name: 'Puck',           vibe: 'Upbeat' },
  { name: 'Charon',         vibe: 'Informative' },
  { name: 'Kore',           vibe: 'Firm' },
  { name: 'Fenrir',         vibe: 'Excitable' },
  { name: 'Leda',           vibe: 'Youthful' },
  { name: 'Orus',           vibe: 'Firm' },
  { name: 'Aoede',          vibe: 'Breezy' },
  { name: 'Callirrhoe',     vibe: 'Easy-going' },
  { name: 'Autonoe',        vibe: 'Bright' },
  { name: 'Enceladus',      vibe: 'Breathy' },
  { name: 'Iapetus',        vibe: 'Clear' },
  { name: 'Umbriel',        vibe: 'Easy-going' },
  { name: 'Algieba',        vibe: 'Smooth' },
  { name: 'Despina',        vibe: 'Smooth' },
  { name: 'Erinome',        vibe: 'Clear' },
  { name: 'Algenib',        vibe: 'Gravelly' },
  { name: 'Rasalgethi',     vibe: 'Informative' },
  { name: 'Laomedeia',      vibe: 'Upbeat' },
  { name: 'Achernar',       vibe: 'Soft' },
  { name: 'Alnilam',        vibe: 'Firm' },
  { name: 'Schedar',        vibe: 'Even' },
  { name: 'Gacrux',         vibe: 'Mature' },
  { name: 'Pulcherrima',    vibe: 'Forward' },
  { name: 'Achird',         vibe: 'Friendly' },
  { name: 'Zubenelgenubi',  vibe: 'Casual' },
  { name: 'Vindemiatrix',   vibe: 'Gentle' },
  { name: 'Sadachbia',      vibe: 'Lively' },
  { name: 'Sadaltager',     vibe: 'Knowledgeable' },
  { name: 'Sulafat',        vibe: 'Warm' },
];

const cache = new Map(); // key: `${voice}|${text}` → Buffer(wav)
const CACHE_MAX = 120;

function wavHeader(pcmLen, sampleRate = SAMPLE_RATE, numChannels = 1, bits = 16) {
  const byteRate = (sampleRate * numChannels * bits) / 8;
  const blockAlign = (numChannels * bits) / 8;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + pcmLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(pcmLen, 40);
  return buf;
}

function pcmToWav(pcm) {
  const header = wavHeader(pcm.length);
  return Buffer.concat([header, pcm]);
}

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const v = cache.get(key);
  cache.delete(key);
  cache.set(key, v); // LRU refresh
  return v;
}
function cacheSet(key, buf) {
  cache.set(key, buf);
  if (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

async function synthesize({ voice, text }) {
  if (!process.env.GEMINI_API_KEY) throw new Error('server missing GEMINI_API_KEY');
  const key = `${voice}|${text}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
  });

  const b64 = response?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) throw new Error('TTS returned no audio data');
  const pcm = Buffer.from(b64, 'base64');
  const wav = pcmToWav(pcm);
  cacheSet(key, wav);
  return wav;
}

export function mountRoutes(app) {
  app.get('/voices', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(new URL('../public/voice_preview.html', import.meta.url).pathname);
  });

  app.get('/voices/list', (_req, res) => {
    res.json({ voices: VOICES, model: TTS_MODEL, sampleRate: SAMPLE_RATE });
  });

  // GET so <audio src="..."> can load it directly. Text comes in the query
  // string, URL-encoded — kept short so we don't hit URL-length limits.
  app.get('/voices/sample.wav', async (req, res) => {
    const voice = String(req.query.voice || '').trim();
    const text = String(req.query.text || '').trim();
    if (!voice || !VOICES.find((v) => v.name === voice)) {
      return res.status(400).json({ error: 'unknown voice' });
    }
    if (!text || text.length > 400) {
      return res.status(400).json({ error: 'text must be 1–400 chars' });
    }
    try {
      const wav = await synthesize({ voice, text });
      res.set('Content-Type', 'audio/wav');
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(wav);
    } catch (err) {
      console.error('[voice-preview]', voice, err?.message || err);
      res.status(500).json({ error: String(err?.message || err) });
    }
  });
}
