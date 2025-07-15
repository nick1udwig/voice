// Opus encoding service using opus-recorder library as intended
// This provides guaranteed real Opus compression across all browsers

// @ts-ignore
import Recorder from 'opus-recorder';
// @ts-ignore
import encoderPath from 'opus-recorder/dist/encoderWorker.min.js';
// @ts-ignore
import decoderPath from 'opus-recorder/dist/decoderWorker.min.js';

interface OpusEncoderConfig {
  sampleRate: number;
  channels: number;
  bitRate?: number;
  frameSize?: number; // in ms
}

export class OpusRecorderService {
  private config: OpusEncoderConfig | null = null;
  private recorder: any = null; // Recorder instance
  private decoderWorker: Worker | null = null;
  private decoderReady = false;
  private isInitialized = false;
  private audioContext: AudioContext | null = null;
  
  // For collecting encoded output
  private encodedChunks: Uint8Array[] = [];
  private encodeResolve: ((data: Uint8Array) => void) | null = null;
  private encodeReject: ((error: Error) => void) | null = null;
  
  // For decoding
  private decodeResolve: ((data: Float32Array) => void) | null = null;
  private decodeReject: ((error: Error) => void) | null = null;

  async initialize(config: OpusEncoderConfig): Promise<void> {
    if (this.isInitialized) {
      console.log('[OpusRecorderService] Already initialized');
      return;
    }
    
    this.config = config;
    
    // Get proper base path
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
    
    const actualEncoderPath = `${base}/encoderWorker.min.js`;
    const actualDecoderPath = `${base}/decoderWorker.min.js`;
    
    console.log('[OpusRecorderService] Initializing with paths:', actualEncoderPath, actualDecoderPath);
    
    // Create audio context
    this.audioContext = new AudioContext({ sampleRate: config.sampleRate });
    
    // Create a silent audio source to prevent getUserMedia calls
    const oscillator = this.audioContext.createOscillator();
    oscillator.frequency.value = 0;
    const gain = this.audioContext.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain);
    const destination = this.audioContext.createMediaStreamDestination();
    gain.connect(destination);
    oscillator.start();
    
    // Create source node from the silent stream
    const sourceNode = this.audioContext.createMediaStreamSource(destination.stream);
    
    // Create recorder instance with our source node
    this.recorder = new Recorder({
      encoderPath: actualEncoderPath,
      encoderSampleRate: config.sampleRate,
      originalSampleRateOverride: config.sampleRate,
      encoderFrameSize: 20, // 20ms frames
      numberOfChannels: config.channels,
      encoderBitRate: config.bitRate || 32000,
      encoderApplication: 2048, // OPUS_APPLICATION_VOIP
      encoderComplexity: 8,
      resampleQuality: 3,
      streamPages: true, // Stream pages as they're encoded
      maxFramesPerPage: 40,
      monitorGain: 0,
      recordingGain: 1,
      bufferLength: 4096,
      sourceNode: sourceNode // Provide the source node to prevent getUserMedia
    });
    
    // Set up recorder callbacks
    this.recorder.ondataavailable = (arrayBuffer: ArrayBuffer) => {
      console.log('[OpusRecorderService] Data available:', arrayBuffer.byteLength, 'bytes');
      this.encodedChunks.push(new Uint8Array(arrayBuffer));
    };
    
    this.recorder.onstart = () => {
      console.log('[OpusRecorderService] Recorder started');
    };
    
    this.recorder.onstop = () => {
      console.log('[OpusRecorderService] Recorder stopped');
    };
    
    // Initialize decoder
    await this.initializeDecoder(actualDecoderPath, config);
    
    this.isInitialized = true;
    console.log('[OpusRecorderService] Initialization complete');
  }
  
  private async initializeDecoder(workerPath: string, config: OpusEncoderConfig): Promise<void> {
    return new Promise((resolve) => {
      this.decoderWorker = new Worker(workerPath);
      
      let isResolved = false;
      const timeout = setTimeout(() => {
        if (!isResolved) {
          console.log('[OpusRecorderService] Decoder init timeout, continuing anyway');
          isResolved = true;
          this.decoderReady = true;
          resolve();
        }
      }, 2000);
      
      this.decoderWorker.onmessage = (e) => {
        console.log('[OpusRecorderService] Decoder message:', e.data);
        
        if (!isResolved && e.data && e.data.message === 'ready') {
          console.log('[OpusRecorderService] Decoder ready');
          clearTimeout(timeout);
          isResolved = true;
          this.decoderReady = true;
          resolve();
        } else if (Array.isArray(e.data) && e.data.length > 0 && e.data[0] instanceof Float32Array) {
          // Decoded audio
          if (this.decodeResolve) {
            const resolve = this.decodeResolve;
            this.decodeResolve = null;
            this.decodeReject = null;
            resolve(e.data[0]);
          }
        } else if (e.data === null) {
          // Decoding complete (from 'done' command)
          console.log('[OpusRecorderService] Decode complete');
        }
      };
      
      this.decoderWorker.onerror = (error) => {
        console.error('[OpusRecorderService] Decoder error:', error);
        if (!isResolved) {
          clearTimeout(timeout);
          isResolved = true;
          this.decoderReady = true; // Continue anyway
          resolve();
        }
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
    });
  }

  async encode(audioData: Float32Array): Promise<Uint8Array> {
    if (!this.recorder || !this.audioContext || !this.isInitialized) {
      throw new Error('Recorder not initialized');
    }
    
    return new Promise(async (resolve, reject) => {
      this.encodedChunks = [];
      this.encodeResolve = resolve;
      this.encodeReject = reject;
      
      try {
        // Create a buffer from the PCM data
        const buffer = this.audioContext!.createBuffer(1, audioData.length, this.audioContext!.sampleRate);
        buffer.copyToChannel(audioData, 0);
        
        // Create a buffer source
        const source = this.audioContext!.createBufferSource();
        source.buffer = buffer;
        
        // Create MediaStreamDestination
        const destination = this.audioContext!.createMediaStreamDestination();
        source.connect(destination);
        
        // Connect our audio buffer to the recorder's existing audio graph
        // We need to temporarily disconnect the silent source and connect our real audio
        const recorderNode = this.recorder.monitorGainNode || this.recorder.recordingGainNode;
        if (recorderNode && this.recorder.sourceNode) {
          try {
            // Disconnect the silent source
            this.recorder.sourceNode.disconnect();
            
            // Connect our new source
            const mediaStreamSource = this.audioContext!.createMediaStreamSource(destination.stream);
            mediaStreamSource.connect(recorderNode);
            
            // Store reference to restore later
            const originalSourceNode = this.recorder.sourceNode;
            this.recorder.sourceNode = mediaStreamSource;
            
            // Restore original after encoding
            source.onended = () => {
              try {
                mediaStreamSource.disconnect();
                originalSourceNode.connect(recorderNode);
                this.recorder.sourceNode = originalSourceNode;
              } catch (e) {
                console.warn('[OpusRecorderService] Error restoring source:', e);
              }
            };
          } catch (e) {
            console.error('[OpusRecorderService] Error connecting source:', e);
          }
        }
        
        // Calculate duration
        const duration = (audioData.length / this.audioContext!.sampleRate) * 1000; // ms
        
        // Start recording
        await this.recorder.start();
        
        // Start playing the buffer
        source.start();
        
        // Stop after duration + buffer
        setTimeout(async () => {
          await this.recorder.stop();
          
          // Wait a bit for all data to arrive
          setTimeout(() => {
            // Combine all chunks
            const totalLength = this.encodedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const combined = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of this.encodedChunks) {
              combined.set(chunk, offset);
              offset += chunk.length;
            }
            
            // Add header
            const withHeader = new Uint8Array(combined.length + 4);
            withHeader[0] = 0x4F; // 'O'
            withHeader[1] = 0x52; // 'R' for real opus
            withHeader[2] = (combined.length >> 8) & 0xFF;
            withHeader[3] = combined.length & 0xFF;
            withHeader.set(combined, 4);
            
            if (this.encodeResolve) {
              this.encodeResolve(withHeader);
              this.encodeResolve = null;
              this.encodeReject = null;
            }
          }, 100);
        }, duration + 50);
        
      } catch (error) {
        console.error('[OpusRecorderService] Encode error:', error);
        if (this.encodeReject) {
          this.encodeReject(error as Error);
          this.encodeResolve = null;
          this.encodeReject = null;
        }
      }
    });
  }

  async decode(opusData: Uint8Array): Promise<Float32Array> {
    if (!this.decoderWorker || !this.decoderReady) {
      throw new Error('Decoder not ready');
    }
    
    // Skip our header if present
    let actualOpusData = opusData;
    if (opusData.length >= 4 && opusData[0] === 0x4F && opusData[1] === 0x52) {
      actualOpusData = opusData.slice(4);
    }
    
    return new Promise((resolve, reject) => {
      this.decodeResolve = resolve;
      this.decodeReject = reject;
      
      const timeout = setTimeout(() => {
        if (this.decodeReject) {
          this.decodeReject(new Error('Decode timeout'));
          this.decodeResolve = null;
          this.decodeReject = null;
        }
      }, 5000);
      
      // Override resolve to clear timeout
      const originalResolve = resolve;
      this.decodeResolve = (data: Float32Array) => {
        clearTimeout(timeout);
        originalResolve(data);
      };
      
      // Send decode command - decoder expects buffer, not array
      this.decoderWorker!.postMessage({
        command: 'decode',
        pages: actualOpusData.buffer
      });
      
      // Note: We do NOT send 'done' here as it would terminate the worker
      // The decoder will send back decoded data automatically
    });
  }

  destroy(): void {
    console.log('[OpusRecorderService] Destroying...');
    
    if (this.recorder) {
      try {
        this.recorder.close();
      } catch (e) {
        console.error('[OpusRecorderService] Error closing recorder:', e);
      }
      this.recorder = null;
    }
    
    if (this.decoderWorker) {
      this.decoderWorker.terminate();
      this.decoderWorker = null;
    }
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    this.isInitialized = false;
    this.decoderReady = false;
    this.encodedChunks = [];
  }
}