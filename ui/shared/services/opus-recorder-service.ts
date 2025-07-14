// Opus encoding service using opus-recorder library as intended
// This provides guaranteed real Opus compression across all browsers

// @ts-ignore
import Recorder from 'opus-recorder';

interface OpusEncoderConfig {
  sampleRate: number;
  channels: number;
  bitRate?: number;
  frameSize?: number; // in ms
}

export class OpusRecorderService {
  private config: OpusEncoderConfig | null = null;
  private encoder: any = null; // Recorder instance
  private decoder: Worker | null = null;
  private decoderReady = false;
  private encoderReady = false;
  private dummyContext: AudioContext | null = null;
  
  // For collecting encoded output
  private encodePendingResolve: ((data: Uint8Array) => void) | null = null;
  private encodePendingReject: ((error: Error) => void) | null = null;
  private collectedData: Uint8Array[] = [];
  
  // For decoder callbacks
  private decoderCallbacks = new Map<number, (data: Float32Array) => void>();
  private messageId = 0;

  async initialize(config: OpusEncoderConfig): Promise<void> {
    this.config = config;
    
    // Use the imported Recorder class
    const RecorderClass = Recorder;
    
    // Initialize encoder using opus-recorder
    const BASE_URL = import.meta.env.BASE_URL || '';
    const encoderPath = `${BASE_URL}/encoderWorker.min.js`;
    
    console.log('[OpusRecorderService] Initializing encoder with config:', config);
    
    // Create a dummy audio context and source to satisfy opus-recorder's requirements
    this.dummyContext = new AudioContext({ sampleRate: config.sampleRate });
    const dummyBuffer = this.dummyContext.createBuffer(1, 1, config.sampleRate);
    const dummySource = this.dummyContext.createBufferSource();
    dummySource.buffer = dummyBuffer;
    const dummyNode = this.dummyContext.createMediaStreamDestination();
    dummySource.connect(dummyNode);
    
    // Create recorder instance with our config and dummy source
    this.encoder = new RecorderClass({
      encoderPath: encoderPath,
      encoderSampleRate: config.sampleRate,
      encoderFrameSize: Math.floor(config.sampleRate * (config.frameSize || 20) / 1000),
      numberOfChannels: config.channels,
      encoderBitRate: config.bitRate || 32000,
      encoderApplication: 2048, // Voice
      streamPages: true, // Stream pages as they're encoded
      maxFramesPerPage: 1, // Send immediately
      originalSampleRateOverride: config.sampleRate,
      sourceNode: {
        context: this.dummyContext,
        mediaStream: dummyNode.stream,
        connect: () => {} // Dummy connect function
      },
      monitorGain: 0, // No monitoring
      recordingGain: 1
    });
    
    // Set up encoder callbacks
    this.encoder.ondataavailable = (arrayBuffer: ArrayBuffer) => {
      console.log('[OpusRecorderService] Data available from encoder:', arrayBuffer.byteLength, 'bytes');
      if (this.encodePendingResolve) {
        // For streaming mode, resolve immediately
        const data = new Uint8Array(arrayBuffer);
        const resolve = this.encodePendingResolve;
        this.encodePendingResolve = null;
        this.encodePendingReject = null;
        resolve(data);
      } else {
        // Collect data for later
        this.collectedData.push(new Uint8Array(arrayBuffer));
      }
    };
    
    this.encoder.onstart = () => {
      console.log('[OpusRecorderService] Encoder started');
      this.encoderReady = true;
    };
    
    // Initialize decoder worker directly
    const decoderPath = `${BASE_URL}/decoderWorker.min.js`;
    console.log('[OpusRecorderService] Loading decoder from:', decoderPath);
    
    this.decoder = new Worker(decoderPath);
    
    this.decoder.postMessage({
      command: 'init',
      decoderSampleRate: config.sampleRate,
      outputBufferSampleRate: config.sampleRate,
      numberOfChannels: config.channels
    });
    
    // Set up decoder message handler
    this.decoder.onmessage = (e) => {
      console.log('[OpusRecorderService] Decoder message:', e.data);
      
      if (e.data === 'done' || (e.data && e.data.message === 'done')) {
        console.log('[OpusRecorderService] Decoder initialized');
        this.decoderReady = true;
      } else if (e.data && e.data.channelBuffers) {
        // Handle decoded audio
        const channelData = e.data.channelBuffers[0]; // Mono
        const float32Data = new Float32Array(channelData);
        
        // Find and call the callback
        if (this.decoderCallbacks.size > 0) {
          const entry = this.decoderCallbacks.entries().next().value;
          if (entry) {
            const [id, callback] = entry;
            callback(float32Data);
            this.decoderCallbacks.delete(id);
          }
        }
      }
    };
    
    this.decoder.onerror = (error) => {
      console.error('[OpusRecorderService] Decoder worker error:', error);
    };
    
    // Start the encoder to initialize it
    console.log('[OpusRecorderService] Starting encoder for initialization');
    await this.encoder.start();
    
    // Wait for encoder to be ready (decoder is optional)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.encoderReady) {
          console.warn('[OpusRecorderService] Decoder initialization timed out, continuing with encoder only');
          resolve();
        } else {
          reject(new Error('Timeout waiting for encoder initialization'));
        }
      }, 5000);
      
      const checkReady = () => {
        if (this.encoderReady) {
          // Wait a bit more for decoder, but don't block
          setTimeout(() => {
            clearTimeout(timeout);
            if (!this.decoderReady) {
              console.warn('[OpusRecorderService] Decoder not ready, but encoder is ready');
            }
            resolve();
          }, 500);
        } else {
          setTimeout(checkReady, 10);
        }
      };
      checkReady();
    });
    
    console.log('[OpusRecorderService] Initialization complete');
  }

  async encode(audioData: Float32Array): Promise<Uint8Array> {
    if (!this.encoder || !this.encoderReady) {
      throw new Error('Opus encoder not ready');
    }

    return new Promise((resolve, reject) => {
      this.encodePendingResolve = (data: Uint8Array) => {
        // Add our header format
        const withHeader = new Uint8Array(data.length + 4);
        withHeader[0] = 0x4F; // 'O'
        withHeader[1] = 0x52; // 'R' for opus-recorder
        withHeader[2] = (data.length >> 8) & 0xFF;
        withHeader[3] = data.length & 0xFF;
        withHeader.set(data, 4);
        resolve(withHeader);
      };
      this.encodePendingReject = reject;
      
      try {
        // Access the encoder's internal worker to send data directly
        if (this.encoder.encoder && this.encoder.encoder.postMessage) {
          // Convert to Int16Array as expected by the encoder
          const int16Data = new Int16Array(audioData.length);
          for (let i = 0; i < audioData.length; i++) {
            const sample = Math.max(-1, Math.min(1, audioData[i]));
            int16Data[i] = Math.floor(sample * 0x7FFF);
          }
          
          // Create proper ArrayBuffer
          const buffer = new ArrayBuffer(int16Data.length * 2);
          const view = new DataView(buffer);
          for (let i = 0; i < int16Data.length; i++) {
            view.setInt16(i * 2, int16Data[i], true);
          }
          
          // Send to encoder
          this.encoder.encoder.postMessage({
            command: 'encode',
            buffers: [buffer]
          }, [buffer]);
          
          // Force flush to get the encoded data immediately
          setTimeout(() => {
            if (this.encoder.encoder) {
              this.encoder.encoder.postMessage({
                command: 'flush'
              });
            }
          }, 10);
        } else {
          reject(new Error('Encoder worker not accessible'));
        }
      } catch (error) {
        console.error('[OpusRecorderService] Encode error:', error);
        this.encodePendingResolve = null;
        this.encodePendingReject = null;
        reject(error);
      }
      
      // Timeout
      setTimeout(() => {
        if (this.encodePendingReject) {
          this.encodePendingResolve = null;
          const rej = this.encodePendingReject;
          this.encodePendingReject = null;
          rej(new Error('Encode timeout'));
        }
      }, 1000);
    });
  }

  async decode(opusData: Uint8Array): Promise<Float32Array> {
    if (!this.decoderReady || !this.decoder) {
      throw new Error('Opus decoder not ready');
    }

    return new Promise((resolve, reject) => {
      // Check header and extract actual Opus data
      let actualOpusData: Uint8Array;
      
      if (opusData.length >= 4 && opusData[0] === 0x4F) {
        if (opusData[1] === 0x52 || opusData[1] === 0x50) {
          // Our header format
          const dataLength = (opusData[2] << 8) | opusData[3];
          actualOpusData = opusData.slice(4, 4 + dataLength);
          
          // If it's old PCM format (OP), handle it
          if (opusData[1] === 0x50) {
            // Direct PCM data
            const int16Count = dataLength / 2;
            const int16Data = new Int16Array(actualOpusData.buffer, actualOpusData.byteOffset, int16Count);
            const float32Data = new Float32Array(int16Data.length);
            for (let i = 0; i < int16Data.length; i++) {
              float32Data[i] = int16Data[i] / 0x7FFF;
            }
            resolve(float32Data);
            return;
          }
        } else {
          reject(new Error(`Unknown header format: ${opusData[0]},${opusData[1]}`));
          return;
        }
      } else {
        actualOpusData = opusData;
      }
      
      const id = this.messageId++;
      this.decoderCallbacks.set(id, resolve);
      
      // Send to decoder
      const buffer = actualOpusData.buffer.slice(
        actualOpusData.byteOffset,
        actualOpusData.byteOffset + actualOpusData.byteLength
      );
      
      this.decoder!.postMessage({
        command: 'decode',
        pages: [buffer]
      }, [buffer]);
      
      // Timeout
      setTimeout(() => {
        if (this.decoderCallbacks.has(id)) {
          this.decoderCallbacks.delete(id);
          reject(new Error('Decode timeout'));
        }
      }, 1000);
    });
  }

  destroy() {
    if (this.encoder) {
      try {
        if (this.encoder.stop) {
          this.encoder.stop();
        }
        if (this.encoder.close) {
          this.encoder.close();
        }
      } catch (e) {
        console.error('[OpusRecorderService] Error stopping encoder:', e);
      }
      this.encoder = null;
    }
    if (this.decoder) {
      this.decoder.postMessage({ command: 'close' });
      this.decoder.terminate();
      this.decoder = null;
    }
    if (this.dummyContext) {
      this.dummyContext.close();
      this.dummyContext = null;
    }
    this.decoderCallbacks.clear();
    this.collectedData = [];
  }
}

// Singleton instance
let encoderInstance: OpusRecorderService | null = null;

export function getOpusEncoder(): OpusRecorderService {
  if (!encoderInstance) {
    encoderInstance = new OpusRecorderService();
  }
  return encoderInstance;
}

export function destroyOpusEncoder() {
  if (encoderInstance) {
    encoderInstance.destroy();
    encoderInstance = null;
  }
}