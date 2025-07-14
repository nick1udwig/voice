// Simple Opus-like encoder using compression
// In production, you would use a real Opus encoder library

let isInitialized = false;

// Configuration
const OPUS_FRAME_SIZE = 960; // 20ms at 48kHz
const COMPRESSION_RATIO = 10; // Simulate Opus compression

class SimpleOpusEncoder {
  constructor(config) {
    this.sampleRate = config.sampleRate || 48000;
    this.channels = config.channels || 1;
    this.frameSize = OPUS_FRAME_SIZE;
  }

  encode(pcmData) {
    // Simple compression: Convert Float32 to Int16 and apply basic compression
    const float32 = new Float32Array(pcmData);
    
    // Ensure we have exactly one frame of data
    if (float32.length !== this.frameSize) {
      console.warn(`[Encoder] Expected ${this.frameSize} samples, got ${float32.length}`);
    }

    // Convert to 16-bit PCM
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = Math.floor(sample * 0x7FFF);
    }

    // Simulate Opus compression by creating a smaller buffer
    // In real implementation, this would be actual Opus encoding
    const compressedSize = Math.ceil(int16.length / COMPRESSION_RATIO) * 2; // Keep it even for 16-bit alignment
    const compressed = new Uint8Array(compressedSize);
    
    // Simple compression: Store every Nth sample with metadata
    compressed[0] = 0x4F; // 'O' - Opus-like marker
    compressed[1] = 0x50; // 'P'
    compressed[2] = (int16.length >> 8) & 0xFF; // Original size high byte
    compressed[3] = int16.length & 0xFF; // Original size low byte
    
    // Store downsampled data
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
      encoder = new SimpleOpusEncoder({
        sampleRate: data.sampleRate || 48000,
        channels: data.channels || 1
      });
      isInitialized = true;
      self.postMessage({ type: 'ready' });
      break;
      
    case 'encode':
      if (encoder && isInitialized) {
        try {
          const encoded = encoder.encode(data.buffer);
          self.postMessage({
            type: 'encoded',
            data: encoded,
            id: data.id
          }, [encoded.buffer]);
        } catch (error) {
          console.error('[Encoder] Encoding error:', error);
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
      isInitialized = false;
      break;
  }
};