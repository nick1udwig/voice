// Direct encoder that uses the worker API
export class OpusStreamEncoder {
  private encoderWorker: Worker | null = null;
  private decoderWorker: Worker | null = null;
  private config: any;
  private pageAccumulator: Uint8Array[] = [];
  private currentResolve: ((data: Uint8Array) => void) | null = null;
  
  constructor(config: { sampleRate: number; channels: number; bitRate?: number }) {
    this.config = {
      encoderSampleRate: config.sampleRate,
      originalSampleRate: config.sampleRate,
      originalSampleRateOverride: config.sampleRate,
      numberOfChannels: config.channels,
      encoderBitRate: config.bitRate || 32000,
      encoderApplication: 2048, // VOIP
      encoderFrameSize: 20, // 20ms
      encoderComplexity: 8,
      resampleQuality: 3,
      bufferLength: 4096,
      maxFramesPerPage: 40,
      streamPages: true // Important: we want pages as they're ready
    };
  }
  
  async initialize(): Promise<void> {
    // Get proper base path - need to handle the voice:voice:sys prefix
    let base = '';
    if (window.location.pathname.includes('/voice:voice:sys')) {
      base = '/voice:voice:sys';
    } else if (window.location.pathname.includes('/call/')) {
      base = window.location.pathname.split('/call/')[0];
    } else {
      const pathParts = window.location.pathname.split('/');
      pathParts.pop();
      base = pathParts.join('/');
    }
    
    console.log('[OpusStreamEncoder] Current pathname:', window.location.pathname);
    console.log('[OpusStreamEncoder] Base path:', base);
    
    // Initialize encoder
    await this.initEncoder(`${base}/encoderWorker.min.js`);
    
    // Initialize decoder
    await this.initDecoder(`${base}/decoderWorker.min.js`);
  }
  
  private async initEncoder(workerPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.encoderWorker = new Worker(workerPath);
      
      let isResolved = false;
      const timeout = setTimeout(() => {
        if (!isResolved) {
          console.warn('[OpusStreamEncoder] Encoder init timeout, but continuing anyway');
          isResolved = true;
          resolve(); // Continue anyway - encoder might work
        }
      }, 2000);
      
      this.encoderWorker.onmessage = (e) => {
        if (!isResolved && e.data.message === 'ready') {
          console.log('[OpusStreamEncoder] Encoder ready');
          clearTimeout(timeout);
          isResolved = true;
          resolve();
        } else if (e.data.message === 'page') {
          // Handle encoded page
          if (e.data.page) {
            this.pageAccumulator.push(new Uint8Array(e.data.page));
            console.log('[OpusStreamEncoder] Page received:', e.data.page.byteLength, 'bytes');
          }
        } else if (e.data.message === 'done') {
          // Encoding session complete
          console.log('[OpusStreamEncoder] Encoding complete');
          if (this.currentResolve && this.pageAccumulator.length > 0) {
            // Combine all pages
            const totalLength = this.pageAccumulator.reduce((sum, page) => sum + page.length, 0);
            const combined = new Uint8Array(totalLength);
            let offset = 0;
            for (const page of this.pageAccumulator) {
              combined.set(page, offset);
              offset += page.length;
            }
            
            // Add header
            const withHeader = new Uint8Array(combined.length + 4);
            withHeader[0] = 0x4F; // 'O'
            withHeader[1] = 0x52; // 'R' for real opus
            withHeader[2] = (combined.length >> 8) & 0xFF;
            withHeader[3] = combined.length & 0xFF;
            withHeader.set(combined, 4);
            
            const resolve = this.currentResolve;
            this.currentResolve = null;
            this.pageAccumulator = [];
            resolve(withHeader);
          }
        }
      };
      
      this.encoderWorker.onerror = (error) => {
        console.error('[OpusStreamEncoder] Encoder error:', error);
        if (!isResolved) {
          clearTimeout(timeout);
          isResolved = true;
          reject(error);
        }
      };
      
      // Send init
      this.encoderWorker.postMessage({
        command: 'init',
        ...this.config
      });
    });
  }
  
  private async initDecoder(workerPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.decoderWorker = new Worker(workerPath);
      
      let isResolved = false;
      const timeout = setTimeout(() => {
        if (!isResolved) {
          console.warn('[OpusStreamEncoder] Decoder init timeout, but continuing anyway');
          isResolved = true;
          resolve(); // Continue anyway - decoder might work
        }
      }, 2000);
      
      this.decoderWorker.onmessage = (e) => {
        console.log('[OpusStreamEncoder] Decoder init message:', e.data);
        if (!isResolved) {
          if (e.data && e.data.message === 'ready') {
            console.log('[OpusStreamEncoder] Decoder ready');
            clearTimeout(timeout);
            isResolved = true;
            resolve();
          } else if (e.data && typeof e.data === 'object' && !e.data.message) {
            // Decoder might be ready without explicit 'ready' message
            console.log('[OpusStreamEncoder] Decoder initialized (no ready message)');
            clearTimeout(timeout);
            isResolved = true;
            resolve();
          }
        }
      };
      
      this.decoderWorker.onerror = (error) => {
        console.error('[OpusStreamEncoder] Decoder error:', error);
        if (!isResolved) {
          clearTimeout(timeout);
          isResolved = true;
          reject(error);
        }
      };
      
      // Send init
      this.decoderWorker.postMessage({
        command: 'init',
        decoderSampleRate: this.config.encoderSampleRate,
        outputBufferSampleRate: this.config.encoderSampleRate,
        numberOfChannels: this.config.numberOfChannels,
        bufferLength: 4096,
        resampleQuality: 3
      });
      
    });
  }
  
  async encode(pcmData: Float32Array): Promise<Uint8Array> {
    if (!this.encoderWorker) {
      throw new Error('Encoder not initialized');
    }
    
    return new Promise((resolve, reject) => {
      this.currentResolve = resolve;
      this.pageAccumulator = [];
      
      const timeout = setTimeout(() => {
        this.currentResolve = null;
        reject(new Error('Encode timeout'));
      }, 5000);
      
      this.currentResolve = (data: Uint8Array) => {
        clearTimeout(timeout);
        resolve(data);
      };
      
      // Encode the data
      this.encoderWorker!.postMessage({
        command: 'encode',
        buffers: [pcmData]
      });
      
      // Finish encoding (this triggers the 'done' message)
      this.encoderWorker!.postMessage({
        command: 'done'
      });
    });
  }
  
  async decode(opusData: Uint8Array): Promise<Float32Array> {
    if (!this.decoderWorker) {
      throw new Error('Decoder not initialized');
    }
    
    // Skip our header if present
    let actualOpusData = opusData;
    if (opusData.length >= 4 && opusData[0] === 0x4F && opusData[1] === 0x52) {
      actualOpusData = opusData.slice(4);
    }
    
    return new Promise((resolve, reject) => {
      let decodedBuffers: Float32Array[] = [];
      
      const timeout = setTimeout(() => {
        reject(new Error('Decode timeout'));
      }, 5000);
      
      const messageHandler = (e: MessageEvent) => {
        if (Array.isArray(e.data) && e.data.length > 0 && e.data[0] instanceof Float32Array) {
          // Decoded audio
          decodedBuffers = decodedBuffers.concat(e.data);
        } else if (e.data === null) {
          // Decoding complete
          this.decoderWorker!.removeEventListener('message', messageHandler);
          clearTimeout(timeout);
          
          if (decodedBuffers.length > 0) {
            // Combine all buffers
            const totalLength = decodedBuffers.reduce((sum, buf) => sum + buf.length, 0);
            const combined = new Float32Array(totalLength);
            let offset = 0;
            for (const buf of decodedBuffers) {
              combined.set(buf, offset);
              offset += buf.length;
            }
            resolve(combined);
          } else {
            reject(new Error('No decoded data received'));
          }
        }
      };
      
      this.decoderWorker!.addEventListener('message', messageHandler);
      
      // Send decode command
      this.decoderWorker!.postMessage({
        command: 'decode',
        pages: actualOpusData.buffer
      });
      
      // Send done to flush
      this.decoderWorker!.postMessage({
        command: 'done'
      });
    });
  }
  
  destroy(): void {
    // Need to re-create workers for next use since 'done' terminates them
    if (this.encoderWorker) {
      this.encoderWorker.terminate();
      this.encoderWorker = null;
    }
    
    if (this.decoderWorker) {
      this.decoderWorker.terminate();
      this.decoderWorker = null;
    }
  }
  
  // Re-initialize after destruction
  async reinitialize(): Promise<void> {
    await this.initialize();
  }
}