// Real Opus encoding/decoding service using Web Workers
interface OpusEncoderConfig {
  sampleRate: number;
  channels: number;
  bitRate?: number;
  frameSize?: number; // in ms
}

export class RealOpusService {
  private config: OpusEncoderConfig | null = null;
  private encoderWorker: Worker | null = null;
  private decoderWorker: Worker | null = null;
  private encoderReady = false;
  private decoderReady = false;
  private encodeCallbacks = new Map<number, (data: Uint8Array) => void>();
  private decodeCallbacks = new Map<number, (data: Float32Array) => void>();
  private messageId = 0;
  
  async initialize(config: OpusEncoderConfig): Promise<void> {
    this.config = config;
    console.log('[RealOpusService] Initializing with config:', config);
    
    // Initialize encoder worker
    try {
      // Get the base URL from the current page
      const base = window.location.pathname.includes('/call/') 
        ? window.location.pathname.split('/call/')[0] 
        : '';
      const encoderUrl = `${base}/opus-worker-encoder.js`;
      console.log('[RealOpusService] Loading encoder from:', encoderUrl);
      console.log('[RealOpusService] Current location:', window.location.href);
      console.log('[RealOpusService] Base path:', base);
      
      try {
        this.encoderWorker = new Worker(encoderUrl);
      } catch (error) {
        console.error('[RealOpusService] Failed to create encoder worker:', error);
        throw error;
      }
      
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Encoder initialization timeout')), 5000);
        
        this.encoderWorker!.onmessage = (e) => {
          if (e.data.type === 'ready') {
            clearTimeout(timeout);
            this.encoderReady = true;
            console.log('[RealOpusService] Encoder ready');
            resolve();
          }
        };
        
        this.encoderWorker!.onerror = (error) => {
          clearTimeout(timeout);
          console.error('[RealOpusService] Encoder worker error event:', error);
          // Check if it's a network error
          if (error && error.message && error.message.includes('Failed to fetch')) {
            reject(new Error(`Failed to load encoder worker from ${encoderUrl}`));
          } else {
            reject(error);
          }
        };
        
        // Initialize encoder
        this.encoderWorker!.postMessage({
          type: 'init',
          data: {
            sampleRate: config.sampleRate,
            channels: config.channels,
            bitRate: config.bitRate || 32000,
            frameSize: Math.floor(config.sampleRate * (config.frameSize || 20) / 1000)
          }
        });
      });
    } catch (error) {
      console.error('[RealOpusService] Failed to initialize encoder:', error);
      throw error;
    }
    
    // Initialize decoder worker
    try {
      // Get the base URL from the current page
      const base = window.location.pathname.includes('/call/') 
        ? window.location.pathname.split('/call/')[0] 
        : '';
      const decoderUrl = `${base}/opus-worker-decoder.js`;
      console.log('[RealOpusService] Loading decoder from:', decoderUrl);
      
      try {
        this.decoderWorker = new Worker(decoderUrl);
      } catch (error) {
        console.error('[RealOpusService] Failed to create decoder worker:', error);
        throw error;
      }
      
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Decoder initialization timeout')), 5000);
        
        this.decoderWorker!.onmessage = (e) => {
          if (e.data.type === 'ready') {
            clearTimeout(timeout);
            this.decoderReady = true;
            console.log('[RealOpusService] Decoder ready');
            resolve();
          }
        };
        
        this.decoderWorker!.onerror = (error) => {
          clearTimeout(timeout);
          reject(error);
        };
        
        // Initialize decoder
        this.decoderWorker!.postMessage({
          command: 'init',
          decoderSampleRate: config.sampleRate,
          outputBufferSampleRate: config.sampleRate,
          channels: config.channels
        });
      });
    } catch (error) {
      console.error('[RealOpusService] Failed to initialize decoder:', error);
      throw error;
    }
    
    // Set up message handlers
    this.setupMessageHandlers();
  }
  
  private setupMessageHandlers(): void {
    if (this.encoderWorker) {
      this.encoderWorker.onmessage = (e) => {
        if (e.data.type === 'encoded' && e.data.id !== undefined) {
          const callback = this.encodeCallbacks.get(e.data.id);
          if (callback) {
            callback(new Uint8Array(e.data.data));
            this.encodeCallbacks.delete(e.data.id);
          }
        }
      };
    }
    
    if (this.decoderWorker) {
      this.decoderWorker.onmessage = (e) => {
        if (e.data.type === 'decoded' && e.data.id !== undefined) {
          const callback = this.decodeCallbacks.get(e.data.id);
          if (callback) {
            callback(new Float32Array(e.data.data));
            this.decodeCallbacks.delete(e.data.id);
          }
        } else if (e.data && e.data.length > 0) {
          // Legacy format - decoder returns Float32Array directly
          const id = this.messageId - 1; // Last message id
          const callback = this.decodeCallbacks.get(id);
          if (callback) {
            callback(new Float32Array(e.data[0]));
            this.decodeCallbacks.delete(id);
          }
        } else if (e.data === null) {
          // End of stream
          console.log('[RealOpusService] Decoder end of stream');
        }
      };
    }
  }
  
  async encode(audioData: Float32Array): Promise<Uint8Array> {
    if (!this.encoderReady || !this.encoderWorker) {
      throw new Error('[RealOpusService] Encoder not ready');
    }
    
    const id = this.messageId++;
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.encodeCallbacks.delete(id);
        reject(new Error('Encoding timeout'));
      }, 1000);
      
      this.encodeCallbacks.set(id, (data) => {
        clearTimeout(timeout);
        
        // Add header
        const result = new Uint8Array(data.length + 4);
        result[0] = 0x4F; // 'O'
        result[1] = 0x52; // 'R' for real opus
        result[2] = (data.length >> 8) & 0xFF;
        result[3] = data.length & 0xFF;
        result.set(data, 4);
        
        resolve(result);
      });
      
      // Send audio data to encoder
      this.encoderWorker!.postMessage({
        type: 'encode',
        id: id,
        buffer: audioData.buffer
      }, [audioData.buffer]);
    });
  }
  
  async decode(opusData: Uint8Array): Promise<Float32Array> {
    // Check header
    if (opusData.length < 4 || opusData[0] !== 0x4F) {
      throw new Error('Invalid data format');
    }
    
    const isRealOpus = opusData[1] === 0x52;
    if (!isRealOpus) {
      throw new Error('Not real Opus data');
    }
    
    if (!this.decoderReady || !this.decoderWorker) {
      throw new Error('[RealOpusService] Decoder not ready');
    }
    
    const id = this.messageId++;
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.decodeCallbacks.delete(id);
        reject(new Error('Decoding timeout'));
      }, 1000);
      
      this.decodeCallbacks.set(id, (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
      
      // Extract opus data (skip header)
      const opusPayload = opusData.slice(4);
      
      // Send to decoder with our protocol
      this.decoderWorker!.postMessage({
        type: 'decode',
        data: opusPayload,
        id: id
      }, [opusPayload.buffer]);
    });
  }
  
  destroy() {
    if (this.encoderWorker) {
      this.encoderWorker.terminate();
      this.encoderWorker = null;
    }
    if (this.decoderWorker) {
      this.decoderWorker.terminate();
      this.decoderWorker = null;
    }
    this.encoderReady = false;
    this.decoderReady = false;
    this.encodeCallbacks.clear();
    this.decodeCallbacks.clear();
  }
}

// Singleton instance
let instance: RealOpusService | null = null;

export function getRealOpusService(): RealOpusService {
  if (!instance) {
    instance = new RealOpusService();
  }
  return instance;
}

export function destroyRealOpusService() {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}