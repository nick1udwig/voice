export class OpusCodec {
  private encoder: Worker | null = null;
  private decoder: Worker | null = null;
  private encoderReady = false;
  private decoderReady = false;
  private pendingCallbacks = new Map<string, (data: any) => void>();
  private messageId = 0;

  constructor() {
    this.initializeWorkers();
  }

  private initializeWorkers() {
    // Initialize encoder worker
    this.encoder = new Worker('/audio-encoder.js');
    this.encoder.onmessage = (e) => {
      if (e.data.type === 'ready') {
        this.encoderReady = true;
        console.log('[OpusCodec] Encoder ready');
      } else if (e.data.type === 'encoded') {
        const callback = this.pendingCallbacks.get(e.data.id);
        if (callback) {
          callback(e.data.data);
          this.pendingCallbacks.delete(e.data.id);
        }
      } else if (e.data.type === 'error') {
        console.error('[OpusCodec] Encoder error:', e.data.error);
        const callback = this.pendingCallbacks.get(e.data.id);
        if (callback) {
          this.pendingCallbacks.delete(e.data.id);
        }
      }
    };

    // Initialize decoder worker
    this.decoder = new Worker('/audio-decoder.js');
    this.decoder.onmessage = (e) => {
      if (e.data.type === 'ready') {
        this.decoderReady = true;
        console.log('[OpusCodec] Decoder ready');
      } else if (e.data.type === 'decoded') {
        const callback = this.pendingCallbacks.get(e.data.id);
        if (callback) {
          callback(e.data.data);
          this.pendingCallbacks.delete(e.data.id);
        }
      } else if (e.data.type === 'error') {
        console.error('[OpusCodec] Decoder error:', e.data.error);
        const callback = this.pendingCallbacks.get(e.data.id);
        if (callback) {
          this.pendingCallbacks.delete(e.data.id);
        }
      }
    };

    // Initialize workers
    this.encoder.postMessage({
      type: 'init',
      data: {
        sampleRate: 48000,
        channels: 1
      }
    });

    this.decoder.postMessage({
      type: 'init',
      data: {
        sampleRate: 48000,
        channels: 1
      }
    });
  }

  async encode(audioData: Float32Array): Promise<Uint8Array> {
    if (!this.encoderReady || !this.encoder) {
      throw new Error('Opus encoder not ready');
    }

    return new Promise((resolve) => {
      const id = `encode_${this.messageId++}`;
      this.pendingCallbacks.set(id, resolve);
      
      // Transfer the buffer to avoid copying
      const buffer = audioData.buffer.slice(0);
      this.encoder!.postMessage({
        type: 'encode',
        data: {
          buffer: buffer,
          id: id
        }
      }, [buffer]);
    });
  }

  async decode(opusData: Uint8Array): Promise<Float32Array> {
    if (!this.decoderReady || !this.decoder) {
      throw new Error('Opus decoder not ready');
    }

    return new Promise((resolve, reject) => {
      const id = `decode_${this.messageId++}`;
      this.pendingCallbacks.set(id, resolve);
      
      // Transfer the buffer to avoid copying
      const buffer = opusData.buffer.slice(0);
      this.decoder!.postMessage({
        type: 'decode',
        data: {
          buffer: buffer,
          id: id
        }
      }, [buffer]);
      
      // Add timeout
      setTimeout(() => {
        if (this.pendingCallbacks.has(id)) {
          this.pendingCallbacks.delete(id);
          reject(new Error('Decode timeout'));
        }
      }, 1000);
    });
  }

  destroy() {
    if (this.encoder) {
      this.encoder.postMessage({ type: 'destroy' });
      this.encoder.terminate();
      this.encoder = null;
    }
    if (this.decoder) {
      this.decoder.terminate();
      this.decoder = null;
    }
    this.pendingCallbacks.clear();
  }
}

// Singleton instance
let codecInstance: OpusCodec | null = null;

export function getOpusCodec(): OpusCodec {
  if (!codecInstance) {
    codecInstance = new OpusCodec();
  }
  return codecInstance;
}

export function destroyOpusCodec() {
  if (codecInstance) {
    codecInstance.destroy();
    codecInstance = null;
  }
}