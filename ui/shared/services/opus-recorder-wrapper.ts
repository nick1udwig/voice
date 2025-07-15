// Wrapper around opus-recorder that matches its exact API
declare class OggOpusEncoder {
  constructor(config: any);
  encode(buffers: Float32Array[]): void;
  close(): void;
}

declare global {
  interface Window {
    OggOpusEncoder: typeof OggOpusEncoder;
  }
}

interface EncoderMessage {
  message?: string;
  page?: Uint8Array;
  samplePosition?: number;
}

export class OpusRecorderWrapper {
  private encoder: Worker | null = null;
  private decoder: Worker | null = null;
  private encodeResolve: ((data: Uint8Array) => void) | null = null;
  private decodeResolve: ((data: Float32Array) => void) | null = null;
  private pageBuffer: Uint8Array[] = [];
  private pageTimeout: NodeJS.Timeout | null = null;
  
  async initialize(config: { sampleRate: number; channels: number }) {
    // Initialize encoder
    await this.initEncoder(config);
    await this.initDecoder(config);
  }
  
  private async initEncoder(config: { sampleRate: number; channels: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      // Get proper base path
      let base = '';
      if (window.location.pathname.includes('/call/')) {
        base = window.location.pathname.split('/call/')[0];
      } else {
        const pathParts = window.location.pathname.split('/');
        pathParts.pop();
        base = pathParts.join('/');
      }
      
      this.encoder = new Worker(`${base}/encoderWorker.min.js`);
      
      const timeout = setTimeout(() => {
        reject(new Error('Encoder initialization timeout'));
      }, 5000);
      
      // Set up the message handler first
      this.encoder.onmessage = (e) => {
        // Handle opus-recorder message format
        if (e.data.message === 'ready') {
          clearTimeout(timeout);
          console.log('[OpusRecorderWrapper] Encoder ready');
          resolve();
        } else if (e.data.message === 'page') {
          // Collect pages
          if (e.data.page) {
            this.pageBuffer.push(new Uint8Array(e.data.page));
            console.log('[OpusRecorderWrapper] Received page:', e.data.page.byteLength, 'bytes, total pages:', this.pageBuffer.length);
            
            // Check if this is the last page for current encode operation
            // When streamPages is false, all pages come at once after encoding
            if (this.encodeResolve) {
              // Give it a small delay to see if more pages are coming
              if (this.pageTimeout) clearTimeout(this.pageTimeout);
              this.pageTimeout = setTimeout(() => {
                if (this.encodeResolve && this.pageBuffer.length > 0) {
                  const totalLength = this.pageBuffer.reduce((sum, page) => sum + page.length, 0);
                  const combined = new Uint8Array(totalLength);
                  let offset = 0;
                  for (const page of this.pageBuffer) {
                    combined.set(page, offset);
                    offset += page.length;
                  }
                  
                  // Add our header
                  const withHeader = new Uint8Array(combined.length + 4);
                  withHeader[0] = 0x4F; // 'O'
                  withHeader[1] = 0x52; // 'R' for real opus
                  withHeader[2] = (combined.length >> 8) & 0xFF;
                  withHeader[3] = combined.length & 0xFF;
                  withHeader.set(combined, 4);
                  
                  const resolve = this.encodeResolve;
                  this.encodeResolve = null;
                  this.pageBuffer = [];
                  resolve(withHeader);
                }
              }, 50); // 50ms should be enough to collect all pages
            }
          }
        }
      };
      
      this.encoder.onerror = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      
      // Send init message
      this.encoder.postMessage({
        command: 'init',
        encoderSampleRate: config.sampleRate,
        originalSampleRate: config.sampleRate,
        originalSampleRateOverride: config.sampleRate,
        encoderApplication: 2048, // VOIP
        encoderFrameSize: 20, // 20ms
        encoderBitRate: 32000,
        bufferLength: 4096,
        numberOfChannels: config.channels,
        maxFramesPerPage: 40,
        resampleQuality: 3,
        streamPages: false
      });
    });
  }
  
  private async initDecoder(config: { sampleRate: number; channels: number }): Promise<void> {
    return new Promise((resolve) => {
      // Get proper base path
      let base = '';
      if (window.location.pathname.includes('/call/')) {
        base = window.location.pathname.split('/call/')[0];
      } else {
        const pathParts = window.location.pathname.split('/');
        pathParts.pop();
        base = pathParts.join('/');
      }
      
      this.decoder = new Worker(`${base}/decoderWorker.min.js`);
      
      this.decoder.onmessage = (e) => {
        if (e.data === null) {
          // Decoder finished
          console.log('[OpusRecorderWrapper] Decoder finished');
        } else if (Array.isArray(e.data) && e.data.length > 0 && e.data[0] instanceof Float32Array) {
          // Decoded audio
          if (this.decodeResolve) {
            const resolve = this.decodeResolve;
            this.decodeResolve = null;
            resolve(e.data[0]);
          }
        }
      };
      
      // Send init
      this.decoder.postMessage({
        command: 'init',
        decoderSampleRate: config.sampleRate,
        outputBufferSampleRate: config.sampleRate,
        numberOfChannels: config.channels,
        bufferLength: 4096,
        resampleQuality: 3
      });
      
      resolve();
    });
  }
  
  async encode(audioData: Float32Array): Promise<Uint8Array> {
    if (!this.encoder) {
      throw new Error('Encoder not initialized');
    }
    
    return new Promise((resolve, reject) => {
      this.encodeResolve = resolve;
      this.pageBuffer = [];
      
      // The opus-recorder expects Float32Array buffers, one per channel
      // For mono, just wrap in array
      const buffers = [audioData];
      
      // Send encode command
      this.encoder!.postMessage({
        command: 'encode',
        buffers: buffers
      });
      
      // Do NOT send 'done' - that closes the worker!
      // Pages will come back via 'page' messages
      
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
    if (!this.decoder) {
      throw new Error('Decoder not initialized');
    }
    
    return new Promise((resolve, reject) => {
      // Extract actual opus data
      let actualOpusData: Uint8Array;
      if (opusData.length >= 4 && opusData[0] === 0x4F && opusData[1] === 0x52) {
        const dataLength = (opusData[2] << 8) | opusData[3];
        actualOpusData = opusData.slice(4, 4 + dataLength);
      } else {
        actualOpusData = opusData;
      }
      
      this.decodeResolve = resolve;
      
      // Send to decoder
      this.decoder!.postMessage({
        command: 'decode',
        pages: actualOpusData.buffer
      });
      
      // Do NOT send 'done' - that closes the worker!
      // Decoder should send back decoded data automatically
      
      // Timeout
      setTimeout(() => {
        if (this.decodeResolve) {
          this.decodeResolve = null;
          reject(new Error('Decode timeout'));
        }
      }, 2000);
    });
  }
  
  destroy() {
    if (this.encoder) {
      this.encoder.postMessage({ command: 'close' });
      this.encoder.terminate();
      this.encoder = null;
    }
    if (this.decoder) {
      this.decoder.postMessage({ command: 'close' });
      this.decoder.terminate();
      this.decoder = null;
    }
  }
}