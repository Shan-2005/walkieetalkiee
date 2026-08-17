// AudioWorkletProcessor: captures raw PCM and posts Int16 chunks back to the main thread.
// This replaces the deprecated ScriptProcessorNode which silently produces silence on desktop Chrome 127+.

class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // Accumulate 4096 samples before sending (one socket packet per ~92ms at 44.1kHz)
    this._buffer = [];
    this._chunkSize = 4096;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];
    for (let i = 0; i < channelData.length; i++) {
      this._buffer.push(channelData[i]);
    }

    if (this._buffer.length >= this._chunkSize) {
      const slice = this._buffer.splice(0, this._chunkSize);
      const int16 = new Int16Array(this._chunkSize);
      for (let i = 0; i < this._chunkSize; i++) {
        const s = Math.max(-1, Math.min(1, slice[i]));
        int16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      // Transfer ownership of the buffer to main thread (zero-copy)
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }

    return true; // Keep processor alive
  }
}

registerProcessor('pcm-capture', PCMCapture);
