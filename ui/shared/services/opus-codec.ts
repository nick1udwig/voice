export class OpusCodec {
  private encoder: Worker | null = null;
  private decoder: Worker | null = null;
  private encoderReady = false;
  private decoderReady = false;
  private pendingCallbacks = new Map<string, (data: any) => void>();
  private messageId = 0;
  private initPromise: Promise<void>;

  constructor() {
    this.initPromise = this.initializeWorkers()
      .catch(async (error) => {
        console.warn('[OpusCodec] Failed to load external workers, trying inline fallback:', error);
        // Fallback to inline workers
        await this.initializeInlineWorkers();
      });
  }
  
  async waitForReady(): Promise<void> {
    await this.initPromise;
  }

  private async initializeWorkers(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let encoderReady = false;
      let decoderReady = false;
      
      // Get the base URL and construct worker paths
      const BASE_URL = import.meta.env.BASE_URL || '';
      
      // In production, Vite serves static assets from the base path
      // We need to ensure the path is correct for both dev and prod
      // Add a slash between BASE_URL and filename
      const encoderPath = `${BASE_URL}/audio-encoder.js`;
      const decoderPath = `${BASE_URL}/audio-decoder.js`;
      
      console.log('[OpusCodec] Loading workers from:', { encoderPath, decoderPath, BASE_URL });
      
      const checkReady = () => {
        if (encoderReady && decoderReady) {
          resolve();
        }
      };
      
      // Initialize encoder worker
      try {
        // Use the full URL to ensure proper loading
        const encoderUrl = new URL(encoderPath, window.location.href).href;
        console.log('[OpusCodec] Creating encoder worker with URL:', encoderUrl);
        
        this.encoder = new Worker(encoderUrl);
        this.encoder.onmessage = (e) => {
          if (e.data.type === 'ready') {
            this.encoderReady = true;
            encoderReady = true;
            console.log('[OpusCodec] Encoder ready');
            checkReady();
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
        
        this.encoder.onerror = (error) => {
          console.error('[OpusCodec] Encoder worker error:', error);
          console.error('[OpusCodec] Failed URL was:', encoderUrl);
          reject(new Error('Failed to load encoder worker'));
        };
      } catch (error) {
        console.error('[OpusCodec] Failed to create encoder worker:', error);
        reject(error);
        return;
      }

      // Initialize decoder worker
      try {
        // Use the full URL to ensure proper loading
        const decoderUrl = new URL(decoderPath, window.location.href).href;
        console.log('[OpusCodec] Creating decoder worker with URL:', decoderUrl);
        
        this.decoder = new Worker(decoderUrl);
        this.decoder.onmessage = (e) => {
          if (e.data.type === 'ready') {
            this.decoderReady = true;
            decoderReady = true;
            console.log('[OpusCodec] Decoder ready');
            checkReady();
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
        
        this.decoder.onerror = (error) => {
          console.error('[OpusCodec] Decoder worker error:', error);
          console.error('[OpusCodec] Failed URL was:', decoderUrl);
          reject(new Error('Failed to load decoder worker'));
        };
      } catch (error) {
        console.error('[OpusCodec] Failed to create decoder worker:', error);
        reject(error);
        return;
      }

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
      
      // Add timeout
      setTimeout(() => {
        if (!encoderReady || !decoderReady) {
          reject(new Error(`Opus codec initialization timeout - encoder: ${encoderReady}, decoder: ${decoderReady}`));
        }
      }, 5000);
    });
  }
  
  private async initializeInlineWorkers(): Promise<void> {
    console.log('[OpusCodec] Using inline worker fallback');
    
    // Create inline encoder worker
    const encoderCode = `
      const OPUS_FRAME_SIZE = 960;
      const COMPRESSION_RATIO = 10;
      
      class SimpleOpusEncoder {
        constructor(config) {
          this.sampleRate = config.sampleRate || 48000;
          this.channels = config.channels || 1;
          this.frameSize = OPUS_FRAME_SIZE;
        }
        
        encode(pcmData) {
          const float32 = new Float32Array(pcmData);
          const int16 = new Int16Array(float32.length);
          
          for (let i = 0; i < float32.length; i++) {
            const sample = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = Math.floor(sample * 0x7FFF);
          }
          
          const compressedSize = Math.ceil(int16.length / COMPRESSION_RATIO) * 2;
          const compressed = new Uint8Array(compressedSize);
          
          compressed[0] = 0x4F;
          compressed[1] = 0x50;
          compressed[2] = (int16.length >> 8) & 0xFF;
          compressed[3] = int16.length & 0xFF;
          
          let writeIndex = 4;
          for (let i = 0; i < int16.length && writeIndex < compressed.length - 1; i += COMPRESSION_RATIO) {
            const sample = int16[i];
            compressed[writeIndex++] = (sample >> 8) & 0xFF;
            compressed[writeIndex++] = sample & 0xFF;
          }
          
          return compressed;
        }
      }
      
      let encoder = null;
      
      self.onmessage = function(e) {
        const { type, data } = e.data;
        
        switch (type) {
          case 'init':
            encoder = new SimpleOpusEncoder(data);
            self.postMessage({ type: 'ready' });
            break;
            
          case 'encode':
            if (encoder) {
              try {
                const encoded = encoder.encode(data.buffer);
                self.postMessage({
                  type: 'encoded',
                  data: encoded,
                  id: data.id
                }, [encoded.buffer]);
              } catch (error) {
                self.postMessage({
                  type: 'error',
                  error: error.message,
                  id: data.id
                });
              }
            }
            break;
            
          case 'destroy':
            encoder = null;
            break;
        }
      };
    `;
    
    const decoderCode = `
      const COMPRESSION_RATIO = 10;
      
      class SimpleOpusDecoder {
        constructor(config) {
          this.sampleRate = config.sampleRate || 48000;
          this.channels = config.channels || 1;
        }
        
        decode(compressedData) {
          const compressed = new Uint8Array(compressedData);
          
          if (compressed.length < 4 || compressed[0] !== 0x4F || compressed[1] !== 0x50) {
            throw new Error('Invalid Opus-like data format');
          }
          
          const originalSize = (compressed[2] << 8) | compressed[3];
          const float32 = new Float32Array(originalSize);
          
          let readIndex = 4;
          let writeIndex = 0;
          
          while (readIndex < compressed.length - 1 && writeIndex < originalSize) {
            const sample = (compressed[readIndex] << 8) | compressed[readIndex + 1];
            const signedSample = sample > 0x7FFF ? sample - 0x10000 : sample;
            const floatSample = signedSample / 0x7FFF;
            
            let nextSample = floatSample;
            const nextReadIndex = readIndex + 2;
            
            if (nextReadIndex < compressed.length - 1) {
              const next = (compressed[nextReadIndex] << 8) | compressed[nextReadIndex + 1];
              const signedNext = next > 0x7FFF ? next - 0x10000 : next;
              nextSample = signedNext / 0x7FFF;
            }
            
            for (let i = 0; i < COMPRESSION_RATIO && writeIndex < originalSize; i++) {
              const t = i / COMPRESSION_RATIO;
              float32[writeIndex++] = floatSample * (1 - t) + nextSample * t;
            }
            
            readIndex += 2;
          }
          
          return float32;
        }
      }
      
      let decoder = null;
      
      self.onmessage = function(e) {
        const { type, data } = e.data;
        
        switch (type) {
          case 'init':
            decoder = new SimpleOpusDecoder(data);
            self.postMessage({ type: 'ready' });
            break;
            
          case 'decode':
            if (decoder) {
              try {
                const decoded = decoder.decode(data.buffer);
                self.postMessage({
                  type: 'decoded',
                  data: decoded,
                  id: data.id
                }, [decoded.buffer]);
              } catch (error) {
                self.postMessage({
                  type: 'error',
                  error: error.message,
                  id: data.id
                });
              }
            }
            break;
            
          case 'destroy':
            decoder = null;
            break;
        }
      };
    `;
    
    // Create blob URLs and workers
    const encoderBlob = new Blob([encoderCode], { type: 'application/javascript' });
    const encoderUrl = URL.createObjectURL(encoderBlob);
    
    const decoderBlob = new Blob([decoderCode], { type: 'application/javascript' });
    const decoderUrl = URL.createObjectURL(decoderBlob);
    
    return new Promise<void>((resolve, reject) => {
      let encoderReady = false;
      let decoderReady = false;
      
      const checkReady = () => {
        if (encoderReady && decoderReady) {
          resolve();
        }
      };
      
      try {
        this.encoder = new Worker(encoderUrl);
        this.encoder.onmessage = (e) => {
          if (e.data.type === 'ready') {
            this.encoderReady = true;
            encoderReady = true;
            console.log('[OpusCodec] Inline encoder ready');
            checkReady();
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
        
        this.decoder = new Worker(decoderUrl);
        this.decoder.onmessage = (e) => {
          if (e.data.type === 'ready') {
            this.decoderReady = true;
            decoderReady = true;
            console.log('[OpusCodec] Inline decoder ready');
            checkReady();
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
        
        // Cleanup blob URLs after use
        setTimeout(() => {
          URL.revokeObjectURL(encoderUrl);
          URL.revokeObjectURL(decoderUrl);
        }, 1000);
        
      } catch (error) {
        console.error('[OpusCodec] Failed to create inline workers:', error);
        reject(error);
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