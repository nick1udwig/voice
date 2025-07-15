// Simple Opus encoding/decoding service using opus-recorder workers directly
interface OpusEncoderConfig {
  sampleRate: number;
  channels: number;
  bitRate?: number;
  frameSize?: number; // in ms
}

export class SimpleOpusService {
  private config: OpusEncoderConfig | null = null;
  private encoderWorker: Worker | null = null;
  private decoderWorker: Worker | null = null;
  private encoderReady = false;
  private decoderReady = false;
  
  // For encoder state
  private encoderInitialized = false;
  private encoderCallback: ((data: Uint8Array) => void) | null = null;
  
  // For decoder state  
  private decoderCallback: ((data: Float32Array) => void) | null = null;
  private decoderInitialized = false;
  
  async initialize(config: OpusEncoderConfig): Promise<void> {
    this.config = config;
    console.log('[SimpleOpusService] Initializing with config:', config);
    
    // Initialize encoder worker
    await this.initializeEncoder(config);
    
    // Initialize decoder worker
    await this.initializeDecoder(config);
    
    console.log('[SimpleOpusService] Initialization complete');
  }
  
  private async initializeEncoder(config: OpusEncoderConfig): Promise<void> {
    try {
      const base = window.location.pathname.includes('/call/') 
        ? window.location.pathname.split('/call/')[0] 
        : '';
      const encoderUrl = `${base}/encoderWorker.min.js`;
      console.log('[SimpleOpusService] Loading encoder from:', encoderUrl);
      
      this.encoderWorker = new Worker(encoderUrl);
      
      // Set up message handler before sending init
      this.encoderWorker.onmessage = (e) => {
        if (e.data === 'ready') {
          console.log('[SimpleOpusService] Encoder worker loaded');
          this.encoderInitialized = true;
          this.encoderReady = true;
        } else if (e.data && e.data.length > 0 && e.data[0] instanceof ArrayBuffer) {
          // This is encoded data
          console.log('[SimpleOpusService] Received encoded data:', e.data.length, 'chunks');
          if (this.encoderCallback) {
            // Concatenate all chunks
            let totalLength = 0;
            e.data.forEach((chunk: ArrayBuffer) => totalLength += chunk.byteLength);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            e.data.forEach((chunk: ArrayBuffer) => {
              result.set(new Uint8Array(chunk), offset);
              offset += chunk.byteLength;
            });
            
            const callback = this.encoderCallback;
            this.encoderCallback = null;
            callback(result);
          }
        }
      };
      
      this.encoderWorker.onerror = (error) => {
        console.error('[SimpleOpusService] Encoder worker error:', error);
      };
      
      // Wait for worker to be ready
      await new Promise<void>((resolve) => {
        const checkReady = () => {
          if (this.encoderInitialized) {
            resolve();
          } else {
            setTimeout(checkReady, 10);
          }
        };
        setTimeout(checkReady, 100);
      });
      
      // Initialize encoder with proper config
      this.encoderWorker.postMessage({
        command: 'init',
        encoderSampleRate: config.sampleRate,
        outputBufferSampleRate: config.sampleRate,
        encoderApplication: 2048, // OPUS_APPLICATION_VOIP
        encoderFrameSize: Math.floor(config.sampleRate * (config.frameSize || 20) / 1000),
        encoderComplexity: 8,
        encoderBitRate: config.bitRate || 32000,
        streamPages: true,
        numberOfChannels: config.channels,
        originalSampleRateOverride: config.sampleRate
      });
      
      console.log('[SimpleOpusService] Encoder initialized');
    } catch (error) {
      console.error('[SimpleOpusService] Failed to initialize encoder:', error);
      throw error;
    }
  }
  
  private async initializeDecoder(config: OpusEncoderConfig): Promise<void> {
    try {
      const base = window.location.pathname.includes('/call/') 
        ? window.location.pathname.split('/call/')[0] 
        : '';
      const decoderUrl = `${base}/decoderWorker.min.js`;
      console.log('[SimpleOpusService] Loading decoder from:', decoderUrl);
      
      this.decoderWorker = new Worker(decoderUrl);
      
      // Set up message handler
      this.decoderWorker.onmessage = (e) => {
        console.log('[SimpleOpusService] Decoder message:', e.data);
        
        if (e.data === null) {
          // Decoder finished processing
          console.log('[SimpleOpusService] Decoder finished processing');
        } else if (Array.isArray(e.data) && e.data.length > 0 && e.data[0] instanceof Float32Array) {
          // This is decoded audio data
          console.log('[SimpleOpusService] Received decoded audio:', e.data[0].length, 'samples');
          if (this.decoderCallback) {
            const callback = this.decoderCallback;
            this.decoderCallback = null;
            callback(e.data[0]); // Use first channel for mono
          }
        }
      };
      
      this.decoderWorker.onerror = (error) => {
        console.error('[SimpleOpusService] Decoder worker error:', error);
      };
      
      // Initialize decoder
      this.decoderWorker.postMessage({
        command: 'init',
        decoderSampleRate: config.sampleRate,
        outputBufferSampleRate: config.sampleRate,
        numberOfChannels: config.channels,
        bufferLength: 4096
      });
      
      // Mark as ready after a short delay
      setTimeout(() => {
        this.decoderReady = true;
        console.log('[SimpleOpusService] Decoder marked as ready');
      }, 100);
      
    } catch (error) {
      console.error('[SimpleOpusService] Failed to initialize decoder:', error);
      throw error;
    }
  }
  
  async encode(audioData: Float32Array): Promise<Uint8Array> {
    if (!this.encoderWorker || !this.encoderReady) {
      throw new Error('Opus encoder not ready');
    }
    
    return new Promise((resolve, reject) => {
      this.encoderCallback = (data: Uint8Array) => {
        // Add our header format
        const withHeader = new Uint8Array(data.length + 4);
        withHeader[0] = 0x4F; // 'O'
        withHeader[1] = 0x52; // 'R' for real opus
        withHeader[2] = (data.length >> 8) & 0xFF;
        withHeader[3] = data.length & 0xFF;
        withHeader.set(data, 4);
        resolve(withHeader);
      };
      
      try {
        // Convert Float32Array to ArrayBuffer format expected by encoder
        const buffer = audioData.buffer.slice(
          audioData.byteOffset,
          audioData.byteOffset + audioData.byteLength
        );
        
        // Send to encoder
        this.encoderWorker!.postMessage({
          command: 'encode',
          buffers: [buffer]
        }, [buffer]);
        
        // Also send finish command to flush
        this.encoderWorker!.postMessage({
          command: 'finish'
        });
        
      } catch (error) {
        console.error('[SimpleOpusService] Encode error:', error);
        this.encoderCallback = null;
        reject(error);
      }
      
      // Timeout
      setTimeout(() => {
        if (this.encoderCallback) {
          this.encoderCallback = null;
          reject(new Error('Encode timeout'));
        }
      }, 1000);
    });
  }
  
  async decode(opusData: Uint8Array): Promise<Float32Array> {
    if (!this.decoderWorker || !this.decoderReady) {
      throw new Error('Opus decoder not ready');
    }
    
    return new Promise((resolve, reject) => {
      // Check header and extract actual Opus data
      let actualOpusData: Uint8Array;
      
      if (opusData.length >= 4 && opusData[0] === 0x4F) {
        if (opusData[1] === 0x52) {
          // Our opus header format
          const dataLength = (opusData[2] << 8) | opusData[3];
          actualOpusData = opusData.slice(4, 4 + dataLength);
        } else if (opusData[1] === 0x50) {
          // Legacy PCM format - convert directly
          const dataLength = (opusData[2] << 8) | opusData[3];
          const pcmData = opusData.slice(4, 4 + dataLength);
          const int16Count = dataLength / 2;
          const int16Data = new Int16Array(pcmData.buffer, pcmData.byteOffset, int16Count);
          const float32Data = new Float32Array(int16Data.length);
          for (let i = 0; i < int16Data.length; i++) {
            float32Data[i] = int16Data[i] / 0x7FFF;
          }
          resolve(float32Data);
          return;
        } else {
          reject(new Error(`Unknown header format: ${opusData[0]},${opusData[1]}`));
          return;
        }
      } else {
        actualOpusData = opusData;
      }
      
      this.decoderCallback = resolve;
      
      // Send to decoder - it expects raw Opus pages
      const buffer = actualOpusData.buffer.slice(
        actualOpusData.byteOffset,
        actualOpusData.byteOffset + actualOpusData.byteLength
      );
      
      this.decoderWorker!.postMessage({
        command: 'decode',
        pages: buffer
      }, [buffer]);
      
      // Send done command to flush
      this.decoderWorker!.postMessage({
        command: 'done'
      });
      
      // Timeout
      setTimeout(() => {
        if (this.decoderCallback) {
          this.decoderCallback = null;
          reject(new Error('Decode timeout'));
        }
      }, 1000);
    });
  }
  
  destroy() {
    if (this.encoderWorker) {
      this.encoderWorker.postMessage({ command: 'close' });
      this.encoderWorker.terminate();
      this.encoderWorker = null;
    }
    if (this.decoderWorker) {
      this.decoderWorker.postMessage({ command: 'close' });
      this.decoderWorker.terminate();
      this.decoderWorker = null;
    }
    this.encoderCallback = null;
    this.decoderCallback = null;
  }
}

// Singleton instance
let serviceInstance: SimpleOpusService | null = null;

export function getSimpleOpusService(): SimpleOpusService {
  if (!serviceInstance) {
    serviceInstance = new SimpleOpusService();
  }
  return serviceInstance;
}

export function destroySimpleOpusService() {
  if (serviceInstance) {
    serviceInstance.destroy();
    serviceInstance = null;
  }
}