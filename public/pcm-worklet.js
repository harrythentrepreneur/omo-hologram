// AudioWorklet: converts mic Float32 samples to Int16 PCM and posts
// ~25ms chunks back to the main thread as transferable ArrayBuffers.
// Paired with an AudioContext running at 16 kHz, which means Gemini Live
// receives audio in its expected format (audio/pcm;rate=16000) with no
// resampling on our side.

class PCM16Worklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Int16Array(0);
    // ~25ms @ 16 kHz = 400 samples. Small enough for snappy VAD, big
    // enough not to spam postMessage.
    this._chunkSize = 400;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch0 = input[0]; // mono

    // Float32 (−1…1) → Int16.
    const out = new Int16Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) {
      const s = Math.max(-1, Math.min(1, ch0[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    // Accumulate until we have at least one chunk, then ship chunks.
    const merged = new Int16Array(this._buf.length + out.length);
    merged.set(this._buf);
    merged.set(out, this._buf.length);

    let offset = 0;
    while (merged.length - offset >= this._chunkSize) {
      const slice = merged.slice(offset, offset + this._chunkSize);
      this.port.postMessage(slice.buffer, [slice.buffer]);
      offset += this._chunkSize;
    }
    this._buf = merged.slice(offset);
    return true;
  }
}

registerProcessor('pcm16-worklet', PCM16Worklet);
