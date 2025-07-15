// Direct Opus encoding/decoding service using the workers without opus-recorder wrapper
interface OpusEncoderConfig {
  sampleRate: number;
  channels: number;
  bitRate?: number;
  frameSize?: number; // in ms
}

export class DirectOpusService {
  private config: OpusEncoderConfig | null = null;
  private encoderWorker: Worker | null = null;
  private decoderWorker: Worker | null = null;
  private encoderReady = false;
  private decoderReady = false;
  
  // For encoder state
  private encodeResolve: ((data: Uint8Array) => void) | null = null;
  private encodeBuffer: ArrayBuffer[] = [];
  
  // For decoder state  
  private decodeResolve: ((data: Float32Array) => void) | null = null;
  
  // Message logging
  private messageLog: any[] = [];
  
  async initialize(config: OpusEncoderConfig): Promise<void> {
    this.config = config;
    console.log('[DirectOpusService] Initializing with config:', config);
    
    // Initialize encoder worker
    await this.initializeEncoder(config);
    
    // Initialize decoder worker
    await this.initializeDecoder(config);
    
    console.log('[DirectOpusService] Initialization complete');
  }
  
  private async initializeEncoder(config: OpusEncoderConfig): Promise<void> {
    try {
      // Get proper base path - for host, use the current pathname up to the last /
      // For listener in /call/, use the path before /call/
      let base = '';
      if (window.location.pathname.includes('/call/')) {
        base = window.location.pathname.split('/call/')[0];
      } else {
        // For host, use the directory containing the current page
        const pathParts = window.location.pathname.split('/');
        pathParts.pop(); // Remove the current page (likely index.html or empty)
        base = pathParts.join('/');
      }
      const encoderUrl = `${base}/encoderWorker.min.js`;
      console.log('[DirectOpusService] Current location:', window.location.pathname);
      console.log('[DirectOpusService] Resolved base path:', base);
      console.log('[DirectOpusService] Loading encoder from:', encoderUrl);
      
      this.encoderWorker = new Worker(encoderUrl);
      
      // Set up message handler
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Encoder init timeout')), 5000);
        
        this.encoderWorker!.onmessage = (e) => {
          const logEntry = {
            time: Date.now(),
            type: 'encoder',
            message: e.data.message,
            hasPage: !!e.data.page,
            pageSize: e.data.page?.byteLength,
            samplePosition: e.data.samplePosition,
            data: e.data
          };
          this.messageLog.push(logEntry);
          if (this.messageLog.length > 50) this.messageLog.shift();
          
          console.log('[DirectOpusService] Raw encoder message:', JSON.stringify({
            message: e.data.message,
            hasPage: !!e.data.page,
            pageSize: e.data.page?.byteLength,
            samplePosition: e.data.samplePosition,
            timestamp: Date.now()
          }));
          
          if (e.data.message === 'ready') {
            clearTimeout(timeout);
            this.encoderReady = true;
            console.log('[DirectOpusService] Encoder ready');
            
            // Request initial pages to establish the stream
            console.log('[DirectOpusService] Requesting header pages');
            this.encoderWorker!.postMessage({ command: 'getHeaderPages' });
            resolve();
          } else if (e.data.message === 'page') {
            // Handle encoded page
            console.log(`[DirectOpusService] Page received: ${e.data.page.byteLength} bytes, sample position: ${e.data.samplePosition}`);
            if (this.encodeResolve) {
              this.encodeBuffer.push(e.data.page);
              console.log(`[DirectOpusService] Buffer now has ${this.encodeBuffer.length} pages`);
            } else {
              console.warn('[DirectOpusService] Received page but no encode resolve callback');
            }
          } else if (e.data.message === 'flushed') {
            console.log(`[DirectOpusService] Flushed message received, buffer has ${this.encodeBuffer.length} pages`);
            // All data has been flushed, combine buffers
            if (this.encodeResolve && this.encodeBuffer.length > 0) {
              const totalLength = this.encodeBuffer.reduce((sum, buf) => sum + buf.byteLength, 0);
              console.log(`[DirectOpusService] Combining ${this.encodeBuffer.length} pages, total ${totalLength} bytes`);
              const combined = new Uint8Array(totalLength);
              let offset = 0;
              for (const buf of this.encodeBuffer) {
                combined.set(new Uint8Array(buf), offset);
                offset += buf.byteLength;
              }
              
              const resolve = this.encodeResolve;
              this.encodeResolve = null;
              this.encodeBuffer = [];
              resolve(combined);
            } else if (this.encodeResolve && this.encodeBuffer.length === 0) {
              console.warn('[DirectOpusService] Flushed but no pages in buffer!');
            }
          }
        };
        
        this.encoderWorker!.onerror = (error) => {
          clearTimeout(timeout);
          console.error('[DirectOpusService] Encoder worker error:', error);
          reject(error);
        };
        
        // Initialize encoder - opus-recorder expects direct data properties, not wrapped in command
        this.encoderWorker!.postMessage({
          command: 'init',
          encoderSampleRate: config.sampleRate,
          originalSampleRate: config.sampleRate,
          originalSampleRateOverride: config.sampleRate,
          encoderApplication: 2048, // OPUS_APPLICATION_VOIP
          encoderFrameSize: Math.floor(config.sampleRate * (config.frameSize || 20) / 1000),
          encoderComplexity: 8,
          encoderBitRate: config.bitRate || 32000,
          bufferLength: 4096,
          numberOfChannels: config.channels,
          maxFramesPerPage: 1,
          streamPages: true
        });
      });
      
    } catch (error) {
      console.error('[DirectOpusService] Failed to initialize encoder:', error);
      throw error;
    }
  }
  
  private async initializeDecoder(config: OpusEncoderConfig): Promise<void> {
    try {
      // Get proper base path - for host, use the current pathname up to the last /
      // For listener in /call/, use the path before /call/
      let base = '';
      if (window.location.pathname.includes('/call/')) {
        base = window.location.pathname.split('/call/')[0];
      } else {
        // For host, use the directory containing the current page
        const pathParts = window.location.pathname.split('/');
        pathParts.pop(); // Remove the current page (likely index.html or empty)
        base = pathParts.join('/');
      }
      const decoderUrl = `${base}/decoderWorker.min.js`;
      console.log('[DirectOpusService] Current location:', window.location.pathname);
      console.log('[DirectOpusService] Resolved base path:', base);
      console.log('[DirectOpusService] Loading decoder from:', decoderUrl);
      
      this.decoderWorker = new Worker(decoderUrl);
      
      // The decoder initializes on first message
      this.decoderWorker.onmessage = (e) => {
        console.log('[DirectOpusService] Decoder message:', typeof e.data === 'object' ? JSON.stringify(e.data) : e.data);
        
        if (e.data === null) {
          // Decoder finished
          console.log('[DirectOpusService] Decoder finished processing');
        } else if (Array.isArray(e.data) && e.data.length > 0) {
          // Decoded audio data
          if (e.data[0] instanceof Float32Array && this.decodeResolve) {
            const resolve = this.decodeResolve;
            this.decodeResolve = null;
            resolve(e.data[0]);
          }
        }
      };
      
      this.decoderWorker.onerror = (error) => {
        console.error('[DirectOpusService] Decoder worker error:', error);
      };
      
      // Send init command
      this.decoderWorker.postMessage({
        command: 'init',
        decoderSampleRate: config.sampleRate,
        outputBufferSampleRate: config.sampleRate,
        numberOfChannels: config.channels,
        bufferLength: 4096,
        resampleQuality: 3
      });
      
      // Mark as ready after init
      this.decoderReady = true;
      console.log('[DirectOpusService] Decoder initialized');
      
    } catch (error) {
      console.error('[DirectOpusService] Failed to initialize decoder:', error);
      throw error;
    }
  }
  
  async encode(audioData: Float32Array): Promise<Uint8Array> {
    if (!this.encoderWorker || !this.encoderReady) {
      throw new Error('Opus encoder not ready');
    }
    
    return new Promise((resolve, reject) => {
      this.encodeResolve = (data: Uint8Array) => {
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
        // Clear buffer
        this.encodeBuffer = [];
        
        // Convert Float32 to Int16 as required by opus-recorder
        const int16Buffer = new ArrayBuffer(audioData.length * 2);
        const int16View = new Int16Array(int16Buffer);
        
        for (let i = 0; i < audioData.length; i++) {
          // Clamp to [-1, 1] and convert to Int16
          const clamped = Math.max(-1, Math.min(1, audioData[i]));
          int16View[i] = Math.floor(clamped * 0x7FFF);
        }
        
        console.log('[DirectOpusService] Converted', audioData.length, 'Float32 samples to Int16');
        console.log('[DirectOpusService] Sending encode command with buffer size:', int16Buffer.byteLength, 'bytes');
        
        // Send audio to encode - opus-recorder expects direct command and buffers as separate properties
        this.encoderWorker!.postMessage({
          command: 'encode',
          buffers: [int16Buffer]
        }, [int16Buffer]); // Transfer the buffer for efficiency
        
        // Flush to get all data
        console.log('[DirectOpusService] Sending flush command');
        this.encoderWorker!.postMessage({
          command: 'flush'
        });
        
      } catch (error) {
        console.error('[DirectOpusService] Encode error:', error);
        this.encodeResolve = null;
        reject(error);
      }
      
      // Timeout
      setTimeout(() => {
        if (this.encodeResolve) {
          this.encodeResolve = null;
          reject(new Error('Encode timeout'));
        }
      }, 2000);
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
      
      this.decodeResolve = resolve;
      
      // Send pages to decoder
      this.decoderWorker!.postMessage({
        command: 'decode',
        pages: actualOpusData.buffer
      });
      
      // Signal end of stream
      this.decoderWorker!.postMessage({
        command: 'done'
      });
      
      // Timeout
      setTimeout(() => {
        if (this.decodeResolve) {
          this.decodeResolve = null;
          reject(new Error('Decode timeout'));
        }
      }, 2000);
    });
  }
  
  getMessageLog(): any[] {
    return [...this.messageLog];
  }
  
  destroy() {
    console.log('[DirectOpusService] Destroying, message log:', this.getMessageLog());
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
    this.encodeResolve = null;
    this.decodeResolve = null;
  }
}

// Singleton instance
let serviceInstance: DirectOpusService | null = null;

export function getDirectOpusService(): DirectOpusService {
  if (!serviceInstance) {
    serviceInstance = new DirectOpusService();
    // Expose for debugging
    (window as any).directOpusService = serviceInstance;
  }
  return serviceInstance;
}

export function destroyDirectOpusService() {
  if (serviceInstance) {
    serviceInstance.destroy();
    serviceInstance = null;
  }
}