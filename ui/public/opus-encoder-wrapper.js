// Wrapper for encoderWorker.min.js to handle our message protocol
let encoder = null;
let isReady = false;
let currentId = 0;

// Import the actual opus encoder
try {
  // Try relative import first
  importScripts('./encoderWorker.min.js');
} catch (e) {
  console.error('[OpusEncoderWrapper] Failed to import encoderWorker.min.js:', e);
  // Try absolute path as fallback
  try {
    importScripts('/encoderWorker.min.js');
  } catch (e2) {
    console.error('[OpusEncoderWrapper] Failed to import with absolute path:', e2);
    throw e2;
  }
}

console.log('[OpusEncoderWrapper] Worker loaded, Module available:', typeof Module !== 'undefined');

// Handle messages
self.onmessage = function(e) {
  console.log('[OpusEncoderWrapper] Received message:', e.data.type);
  const { type, data, id } = e.data;
  
  switch (type) {
    case 'init':
      try {
        // Check if OggOpusEncoder is available
        if (typeof OggOpusEncoder === 'undefined') {
          console.error('[OpusEncoderWrapper] OggOpusEncoder not found');
          // Check what's available
          console.log('[OpusEncoderWrapper] Available globals:', Object.keys(self));
          console.log('[OpusEncoderWrapper] Module exports:', Module);
          throw new Error('OggOpusEncoder not available');
        }
        
        // Initialize encoder
        encoder = new OggOpusEncoder({
          numberOfChannels: data.channels || 1,
          encoderSampleRate: data.sampleRate || 48000,
          encoderFrameSize: data.frameSize || 960, // 20ms at 48kHz
          encoderComplexity: 8,
          encoderBitRate: data.bitRate || 32000,
          encoderApplication: 2048, // OPUS_APPLICATION_VOIP
          streamPages: false // Don't wrap in Ogg container
        });
        
        encoder.ondata = (encodedData) => {
          console.log('[OpusEncoderWrapper] Encoded data ready, size:', encodedData.length);
          self.postMessage({
            type: 'encoded',
            data: encodedData,
            id: currentId
          }, [encodedData.buffer]);
        };
        
        isReady = true;
        console.log('[OpusEncoderWrapper] Encoder initialized successfully');
        self.postMessage({ type: 'ready' });
      } catch (error) {
        console.error('[OpusEncoderWrapper] Init error:', error);
        self.postMessage({ type: 'error', error: error.message });
      }
      break;
      
    case 'encode':
      if (!encoder || !isReady) {
        console.error('[OpusEncoderWrapper] Encoder not ready');
        self.postMessage({
          type: 'error',
          error: 'Encoder not initialized',
          id: id
        });
        return;
      }
      
      try {
        currentId = id;
        const float32 = new Float32Array(data.buffer);
        console.log('[OpusEncoderWrapper] Encoding', float32.length, 'samples');
        encoder.encode([float32]);
      } catch (error) {
        console.error('[OpusEncoderWrapper] Encode error:', error);
        self.postMessage({
          type: 'error',
          error: error.message,
          id: id
        });
      }
      break;
      
    case 'destroy':
      if (encoder) {
        encoder.close();
        encoder = null;
        isReady = false;
      }
      break;
  }
};

console.log('[OpusEncoderWrapper] Worker ready for messages');