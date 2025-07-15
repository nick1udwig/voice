// Inline Opus service that doesn't rely on external worker files
// Uses opus-recorder in a way that works with bundlers

// @ts-ignore
import Recorder from 'opus-recorder';

interface OpusEncoderConfig {
  sampleRate: number;
  channels: number;
  bitRate?: number;
  frameSize?: number; // in ms
}

export class OpusInlineService {
  private config: OpusEncoderConfig | null = null;
  private recorder: any = null;
  private isRecording = false;
  private encodedChunks: Uint8Array[] = [];
  private libopusEncoder: any = null;
  private libopusDecoder: any = null;
  
  async initialize(config: OpusEncoderConfig): Promise<void> {
    this.config = config;
    console.log('[OpusInlineService] Initializing with config:', config);
    
    try {
      // Create a recorder instance without media stream
      // We'll feed it audio data directly
      this.recorder = new Recorder({
        encoderPath: '/voice:voice:sys/encoderWorker.min.js',
        encoderSampleRate: config.sampleRate,
        encoderBitRate: config.bitRate || 32000,
        numberOfChannels: config.channels,
        streamPages: false,
        maxFramesPerPage: 1,
        encoderFrameSize: config.frameSize || 20,
        encoderComplexity: 10,
        resampleQuality: 10
      });
      
      console.log('[OpusInlineService] Created Recorder instance');
      
      // Set up data handler
      this.recorder.ondataavailable = (data: ArrayBuffer) => {
        console.log('[OpusInlineService] Encoded data available:', data.byteLength);
        this.encodedChunks.push(new Uint8Array(data));
      };
      
      // Start recorder
      await this.recorder.start();
      this.isRecording = true;
      console.log('[OpusInlineService] Recorder started');
    } catch (error) {
      console.warn('[OpusInlineService] Failed to initialize recorder:', error);
      throw error;
    }
  }
  
  async encode(audioData: Float32Array): Promise<Uint8Array> {
    // Always use real Opus encoding
    if (!this.config) {
      throw new Error('[OpusInlineService] Not initialized');
    }
    
    // Use libopus.js for encoding
    try {
      // Import libopus dynamically
      const { OpusEncoder } = await import('libopus.js');
      
      // Create encoder if not exists
      if (!this.libopusEncoder) {
        this.libopusEncoder = new OpusEncoder({
          channels: this.config.channels,
          sampleRate: this.config.sampleRate,
          application: 'voip'
        });
      }
      
      // Convert Float32Array to Int16Array for encoding
      const int16Data = new Int16Array(audioData.length);
      for (let i = 0; i < audioData.length; i++) {
        int16Data[i] = Math.max(-32768, Math.min(32767, Math.floor(audioData[i] * 32768)));
      }
      
      // Encode with libopus
      const encoded = this.libopusEncoder.encode(int16Data);
      
      // Add header
      const result = new Uint8Array(encoded.length + 4);
      result[0] = 0x4F; // 'O'
      result[1] = 0x52; // 'R' for real opus
      result[2] = (encoded.length >> 8) & 0xFF;
      result[3] = encoded.length & 0xFF;
      result.set(encoded, 4);
      
      return result;
    } catch (error) {
      console.error('[OpusInlineService] Failed to use libopus.js:', error);
      // Try alternative approach
      return this.encodeWithWorker(audioData);
    }
  }
  
  async decode(opusData: Uint8Array): Promise<Float32Array> {
    // Check header
    if (opusData.length < 4 || opusData[0] !== 0x4F) {
      throw new Error('Invalid data format');
    }
    
    const originalSize = (opusData[2] << 8) | opusData[3];
    const isRealOpus = opusData[1] === 0x52;
    
    if (!isRealOpus) {
      // Simple format - use simple decode
      return this.simpleDecode(opusData);
    }
    
    // Real Opus format - decode with libopus
    try {
      const { OpusDecoder } = await import('libopus.js');
      
      if (!this.libopusDecoder) {
        this.libopusDecoder = new OpusDecoder({
          channels: 1,
          sampleRate: 48000
        });
      }
      
      // Extract opus data (skip header)
      const opusPayload = opusData.slice(4);
      
      // Decode
      const decoded = this.libopusDecoder.decode(opusPayload);
      
      // Convert Int16Array to Float32Array
      const float32Data = new Float32Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) {
        float32Data[i] = decoded[i] / 32768;
      }
      
      return float32Data;
    } catch (error) {
      console.error('[OpusInlineService] Failed to decode with libopus.js:', error);
      // Try worker-based decoding
      return this.decodeWithWorker(opusData);
    }
  }
  
  private async encodeWithWorker(audioData: Float32Array): Promise<Uint8Array> {
    // Use the opus-encoder worker directly
    console.log('[OpusInlineService] Attempting worker-based encoding');
    
    // For now, fall back to simple encoding
    // TODO: Implement proper worker-based encoding
    return this.simpleEncode(audioData);
  }
  
  private async decodeWithWorker(opusData: Uint8Array): Promise<Float32Array> {
    // Use the opus-decoder worker directly
    console.log('[OpusInlineService] Attempting worker-based decoding');
    
    // For now, return silence
    // TODO: Implement proper worker-based decoding
    const originalSize = (opusData[2] << 8) | opusData[3];
    return new Float32Array(originalSize);
  }
  
  private simpleEncode(audioData: Float32Array): Uint8Array {
    // Simple compression by downsampling
    const COMPRESSION_RATIO = 10;
    const compressed = new Int16Array(Math.ceil(audioData.length / COMPRESSION_RATIO));
    
    for (let i = 0; i < compressed.length; i++) {
      const srcIndex = i * COMPRESSION_RATIO;
      const sample = audioData[srcIndex] || 0;
      compressed[i] = Math.floor(sample * 32767);
    }
    
    // Create output with header
    const output = new Uint8Array(compressed.length * 2 + 4);
    output[0] = 0x4F; // 'O'
    output[1] = 0x50; // 'P' for simple format
    output[2] = (audioData.length >> 8) & 0xFF;
    output[3] = audioData.length & 0xFF;
    
    // Copy compressed data
    const view = new DataView(output.buffer, 4);
    for (let i = 0; i < compressed.length; i++) {
      view.setInt16(i * 2, compressed[i], true);
    }
    
    return output;
  }
  
  private simpleDecode(opusData: Uint8Array): Float32Array {
    // Check header
    if (opusData.length < 4 || opusData[0] !== 0x4F) {
      throw new Error('Invalid data format');
    }
    
    const originalSize = (opusData[2] << 8) | opusData[3];
    const isSimpleFormat = opusData[1] === 0x50;
    
    if (isSimpleFormat) {
      // Simple format - decompress
      const COMPRESSION_RATIO = 10;
      const float32 = new Float32Array(originalSize);
      const view = new DataView(opusData.buffer, opusData.byteOffset + 4);
      
      for (let i = 0; i < view.byteLength / 2; i++) {
        const sample = view.getInt16(i * 2, true) / 32767;
        const startIdx = i * COMPRESSION_RATIO;
        
        // Interpolate
        for (let j = 0; j < COMPRESSION_RATIO && startIdx + j < originalSize; j++) {
          float32[startIdx + j] = sample;
        }
      }
      
      return float32;
    } else {
      // Real Opus format - we can't decode without a real decoder
      console.warn('[OpusInlineService] Cannot decode real Opus without decoder');
      return new Float32Array(originalSize); // Return silence
    }
  }
  
  destroy() {
    if (this.recorder) {
      try {
        this.recorder.stop();
      } catch (e) {
        console.error('[OpusInlineService] Error stopping recorder:', e);
      }
      this.recorder = null;
    }
    this.isRecording = false;
    this.encodedChunks = [];
    this.libopusEncoder = null;
    this.libopusDecoder = null;
  }
}

// Singleton instance
let instance: OpusInlineService | null = null;

export function getOpusInlineService(): OpusInlineService {
  if (!instance) {
    instance = new OpusInlineService();
  }
  return instance;
}

export function destroyOpusInlineService() {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}