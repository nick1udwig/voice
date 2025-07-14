// Simple Opus-like decoder
// In production, you would use a real Opus decoder library

const COMPRESSION_RATIO = 10;

class SimpleOpusDecoder {
  constructor(config) {
    this.sampleRate = config.sampleRate || 48000;
    this.channels = config.channels || 1;
  }

  decode(compressedData) {
    const compressed = new Uint8Array(compressedData);
    
    // Check header
    if (compressed.length < 4 || compressed[0] !== 0x4F || compressed[1] !== 0x50) {
      throw new Error('Invalid Opus-like data format');
    }

    // Read original size
    const originalSize = (compressed[2] << 8) | compressed[3];
    const float32 = new Float32Array(originalSize);

    // Decode compressed samples
    let readIndex = 4;
    let writeIndex = 0;
    
    while (readIndex < compressed.length - 1 && writeIndex < originalSize) {
      // Read 16-bit sample
      const sample = (compressed[readIndex] << 8) | compressed[readIndex + 1];
      const signedSample = sample > 0x7FFF ? sample - 0x10000 : sample;
      const floatSample = signedSample / 0x7FFF;
      
      // Interpolate to fill the gap (simple linear interpolation)
      const nextReadIndex = readIndex + 2;
      let nextSample = floatSample;
      
      if (nextReadIndex < compressed.length - 1) {
        const next = (compressed[nextReadIndex] << 8) | compressed[nextReadIndex + 1];
        const signedNext = next > 0x7FFF ? next - 0x10000 : next;
        nextSample = signedNext / 0x7FFF;
      }
      
      // Fill with interpolated values
      for (let i = 0; i < COMPRESSION_RATIO && writeIndex < originalSize; i++) {
        const t = i / COMPRESSION_RATIO;
        float32[writeIndex++] = floatSample * (1 - t) + nextSample * t;
      }
      
      readIndex += 2;
    }

    return float32;
  }
}

let decoder = null;

self.onmessage = function(e) {
  const { type, data } = e.data;
  
  switch (type) {
    case 'init':
      decoder = new SimpleOpusDecoder({
        sampleRate: data.sampleRate || 48000,
        channels: data.channels || 1
      });
      self.postMessage({ type: 'ready' });
      break;
      
    case 'decode':
      if (decoder) {
        try {
          const decoded = decoder.decode(data.buffer);
          self.postMessage({
            type: 'decoded',
            data: decoded,
            id: data.id
          }, [decoded.buffer]);
        } catch (error) {
          console.error('[Decoder] Decoding error:', error);
          self.postMessage({
            type: 'error',
            error: error.message,
            id: data.id
          });
        }
      }
      break;
      
    case 'destroy':
      decoder = null;
      break;
  }
};