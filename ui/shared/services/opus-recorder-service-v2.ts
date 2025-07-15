// @ts-ignore
import Recorder from 'opus-recorder';
// @ts-ignore
import encoderPath from 'opus-recorder/dist/encoderWorker.min.js';
// @ts-ignore
import decoderPath from 'opus-recorder/dist/decoderWorker.min.js';

interface OpusConfig {
  sampleRate: number;
  channels: number;
  bitRate?: number;
}

// Create an audio processor worklet that feeds data to the recorder
const createProcessorWorklet = () => {
  const processorCode = `
    class OpusFeederProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.frameSize = 960; // 20ms at 48kHz
        this.buffer = new Float32Array(this.frameSize);
        this.bufferIndex = 0;
      }
      
      process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0]) return true;
        
        const inputData = input[0];
        
        for (let i = 0; i < inputData.length; i++) {
          this.buffer[this.bufferIndex++] = inputData[i];
          
          if (this.bufferIndex >= this.frameSize) {
            // Send complete frame
            this.port.postMessage({
              type: 'audio-frame',
              buffer: this.buffer.slice()
            });
            this.bufferIndex = 0;
          }
        }
        
        return true;
      }
    }
    
    registerProcessor('opus-feeder-processor', OpusFeederProcessor);
  `;
  
  return new Blob([processorCode], { type: 'application/javascript' });
};

export class OpusRecorderServiceV2 {
  private recorder: any | null = null;
  private decoderWorker: Worker | null = null;
  private encodedChunks: Uint8Array[] = [];
  private isEncoding: boolean = false;
  private encodeResolve: ((data: Uint8Array) => void) | null = null;
  private decodeResolve: ((data: Float32Array) => void) | null = null;
  private config: OpusConfig;
  private audioContext: AudioContext | null = null;
  private processorNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  
  async initialize(config: OpusConfig): Promise<void> {
    console.log('[OpusRecorderServiceV2] Initializing with config:', config);
    this.config = config;
    
    // Get proper base path
    let base = '';
    if (window.location.pathname.includes('/call/')) {
      base = window.location.pathname.split('/call/')[0];
    } else {
      const pathParts = window.location.pathname.split('/');
      pathParts.pop();
      base = pathParts.join('/');
    }
    
    const actualEncoderPath = `${base}/encoderWorker.min.js`;
    const actualDecoderPath = `${base}/decoderWorker.min.js`;
    
    console.log('[OpusRecorderServiceV2] Encoder path:', actualEncoderPath);
    console.log('[OpusRecorderServiceV2] Decoder path:', actualDecoderPath);
    
    // Create a silent MediaStream for the recorder
    this.audioContext = new AudioContext({ sampleRate: config.sampleRate });
    
    // Create a constant source that outputs silence
    const oscillator = this.audioContext.createOscillator();
    oscillator.frequency.value = 0;
    oscillator.type = 'sine';
    
    const gainNode = this.audioContext.createGain();
    gainNode.gain.value = 0; // Silence
    
    oscillator.connect(gainNode);
    
    const destination = this.audioContext.createMediaStreamDestination();
    gainNode.connect(destination);
    
    oscillator.start();
    
    // Initialize recorder with the silent stream
    this.recorder = new Recorder({
      sourceNode: this.audioContext.createMediaStreamSource(destination.stream),
      encoderPath: actualEncoderPath,
      numberOfChannels: config.channels,
      encoderSampleRate: config.sampleRate,
      originalSampleRateOverride: config.sampleRate,
      encoderBitRate: config.bitRate || 32000,
      encoderApplication: 2048, // OPUS_APPLICATION_VOIP
      encoderFrameSize: 20, // 20ms frames
      encoderComplexity: 8,
      resampleQuality: 3,
      streamPages: true, // Stream pages as they become available
      monitorGain: 0,
      recordingGain: 1,
      bufferLength: 4096
    });
    
    // Set up data handler
    this.recorder.ondataavailable = (arrayBuffer: ArrayBuffer) => {
      console.log('[OpusRecorderServiceV2] Data available:', arrayBuffer.byteLength, 'bytes');
      
      if (this.isEncoding) {
        this.encodedChunks.push(new Uint8Array(arrayBuffer));
      }
    };
    
    // Initialize decoder
    await this.initializeDecoder(actualDecoderPath, config);
    
    console.log('[OpusRecorderServiceV2] Initialization complete');
  }
  
  private async initializeDecoder(workerPath: string, config: OpusConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      this.decoderWorker = new Worker(workerPath);
      
      const timeout = setTimeout(() => {
        reject(new Error('Decoder initialization timeout'));
      }, 5000);
      
      let decodedBuffers: Float32Array[] = [];
      
      this.decoderWorker.onmessage = (e) => {
        console.log('[OpusRecorderServiceV2] Decoder message:', e.data);
        
        if (e.data.message === 'ready') {
          clearTimeout(timeout);
          resolve();
        } else if (Array.isArray(e.data) && e.data.length > 0 && e.data[0] instanceof Float32Array) {
          // Decoded audio data
          console.log('[OpusRecorderServiceV2] Decoded audio received:', e.data[0].length, 'samples');
          decodedBuffers = decodedBuffers.concat(e.data);
        } else if (e.data === null) {
          // Decoding complete
          console.log('[OpusRecorderServiceV2] Decoding complete, buffers:', decodedBuffers.length);
          if (this.decodeResolve && decodedBuffers.length > 0) {
            // Combine all buffers
            const totalLength = decodedBuffers.reduce((sum, buf) => sum + buf.length, 0);
            const combined = new Float32Array(totalLength);
            let offset = 0;
            for (const buf of decodedBuffers) {
              combined.set(buf, offset);
              offset += buf.length;
            }
            
            const resolve = this.decodeResolve;
            this.decodeResolve = null;
            decodedBuffers = [];
            resolve(combined);
          }
        }
      };
      
      this.decoderWorker.onerror = (error) => {
        console.error('[OpusRecorderServiceV2] Decoder error:', error);
        clearTimeout(timeout);
        reject(error);
      };
      
      // Send init command
      this.decoderWorker.postMessage({
        command: 'init',
        decoderSampleRate: config.sampleRate,
        outputBufferSampleRate: config.sampleRate,
        numberOfChannels: config.channels,
        bufferLength: 4096
      });
    });
  }
  
  async encode(pcmData: Float32Array): Promise<Uint8Array> {
    if (!this.recorder) {
      throw new Error('Recorder not initialized');
    }
    
    return new Promise(async (resolve, reject) => {
      this.encodedChunks = [];
      this.isEncoding = true;
      
      try {
        // Create a new audio context for this encoding session
        const tempContext = new AudioContext({ sampleRate: this.config.sampleRate });
        
        // Create buffer from PCM data
        const buffer = tempContext.createBuffer(1, pcmData.length, this.config.sampleRate);
        buffer.copyToChannel(pcmData, 0);
        
        // Create buffer source
        const source = tempContext.createBufferSource();
        source.buffer = buffer;
        
        // Create script processor to feed data to recorder
        const scriptProcessor = tempContext.createScriptProcessor(4096, 1, 1);
        let processedSamples = 0;
        
        scriptProcessor.onaudioprocess = (event) => {
          if (processedSamples >= pcmData.length) {
            // We've processed all data
            setTimeout(async () => {
              await this.recorder.stop();
              this.isEncoding = false;
              
              // Combine all encoded chunks
              const totalLength = this.encodedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
              const combined = new Uint8Array(totalLength);
              let offset = 0;
              for (const chunk of this.encodedChunks) {
                combined.set(chunk, offset);
                offset += chunk.length;
              }
              
              // Add our header
              const withHeader = new Uint8Array(combined.length + 4);
              withHeader[0] = 0x4F; // 'O'
              withHeader[1] = 0x52; // 'R' for real opus
              withHeader[2] = (combined.length >> 8) & 0xFF;
              withHeader[3] = combined.length & 0xFF;
              withHeader.set(combined, 4);
              
              tempContext.close();
              resolve(withHeader);
            }, 100);
            return;
          }
          
          const inputData = event.inputBuffer.getChannelData(0);
          processedSamples += inputData.length;
        };
        
        // Connect the chain
        source.connect(scriptProcessor);
        scriptProcessor.connect(tempContext.destination);
        
        // Update the recorder's source
        const originalSourceNode = this.recorder.sourceNode;
        this.recorder.sourceNode = tempContext.createMediaStreamSource(tempContext.createMediaStreamDestination().stream);
        
        // Start recording
        await this.recorder.start();
        
        // Start playing the buffer
        source.start();
        
        // Restore original source when done
        setTimeout(() => {
          this.recorder.sourceNode = originalSourceNode;
        }, (pcmData.length / this.config.sampleRate) * 1000 + 200);
        
      } catch (error) {
        this.isEncoding = false;
        reject(error);
      }
    });
  }
  
  async decode(opusData: Uint8Array): Promise<Float32Array> {
    if (!this.decoderWorker) {
      throw new Error('Decoder not initialized');
    }
    
    // Skip our header if present
    let actualOpusData = opusData;
    if (opusData.length >= 4 && opusData[0] === 0x4F && opusData[1] === 0x52) {
      // Skip 'OR' header and length
      actualOpusData = opusData.slice(4);
    }
    
    return new Promise((resolve, reject) => {
      this.decodeResolve = resolve;
      
      const timeout = setTimeout(() => {
        this.decodeResolve = null;
        reject(new Error('Decode timeout'));
      }, 5000);
      
      const originalResolve = resolve;
      resolve = (data: Float32Array) => {
        clearTimeout(timeout);
        originalResolve(data);
      };
      this.decodeResolve = resolve;
      
      // Send decode command
      this.decoderWorker!.postMessage({
        command: 'decode',
        pages: actualOpusData.buffer
      });
      
      // Send done command to flush the decoder
      this.decoderWorker!.postMessage({
        command: 'done'
      });
    });
  }
  
  destroy(): void {
    if (this.recorder) {
      this.recorder.close();
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
  }
}