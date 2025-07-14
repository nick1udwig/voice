// Real Opus encoder using opus-recorder library
importScripts('/opus-encoder-worker.js');

// The opus-recorder encoder worker expects specific message formats
// We'll wrap it to match our interface

let encoder = null;
let isReady = false;

// Override the onmessage to intercept opus-recorder messages
const originalOnMessage = self.onmessage;
self.onmessage = function(e) {
  const { type, data } = e.data;
  
  switch (type) {
    case 'init':
      // Initialize opus-recorder encoder with our settings
      encoder = new OggOpusEncoder({
        numberOfChannels: data.channels || 1,
        encoderSampleRate: data.sampleRate || 48000,
        encoderFrameSize: 20, // 20ms frames
        encoderComplexity: 8,
        encoderBitRate: 32000, // 32kbps for voice
        encoderApplication: 2048, // OPUS_APPLICATION_VOIP
        streamPages: false // Don't wrap in Ogg container
      });
      
      encoder.ondata = (encodedData) => {
        // Send encoded data back
        if (encodedData.length > 0) {
          self.postMessage({
            type: 'encoded',
            data: encodedData,
            id: encoder.currentId
          }, [encodedData.buffer]);
        }
      };
      
      isReady = true;
      self.postMessage({ type: 'ready' });
      break;
      
    case 'encode':
      if (encoder && isReady) {
        try {
          // Store the ID for this encoding operation
          encoder.currentId = data.id;
          
          // Convert the buffer to the format opus-recorder expects
          const float32 = new Float32Array(data.buffer);
          
          // opus-recorder expects interleaved samples for multi-channel
          // For mono, we can send directly
          encoder.encode([float32]);
          
        } catch (error) {
          console.error('[OpusEncoder] Encoding error:', error);
          self.postMessage({
            type: 'error',
            error: error.message,
            id: data.id
          });
        }
      }
      break;
      
    case 'destroy':
      if (encoder) {
        encoder.close();
        encoder = null;
        isReady = false;
      }
      break;
      
    default:
      // Pass through to opus-recorder if needed
      if (originalOnMessage) {
        originalOnMessage(e);
      }
  }
};