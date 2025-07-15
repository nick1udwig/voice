// Real Opus encoder worker that directly uses the encoderWorker.min.js module
importScripts('./encoderWorker.min.js');

let encoder = null;
let isReady = false;
let config = null;
let currentId = 0;

// Wait for the module to be ready
if (typeof Module !== 'undefined') {
  Module.onRuntimeInitialized = function() {
    console.log('[RealOpusEncoder] WASM runtime initialized');
  };
}

// Handle our custom messages
self.onmessage = function(e) {
  const { type, data, id } = e.data;
  console.log('[RealOpusEncoder] Received message:', type);
  
  switch (type) {
    case 'init':
      try {
        // Store config
        config = {
          numberOfChannels: data.channels || 1,
          encoderSampleRate: data.sampleRate || 48000,
          encoderFrameSize: data.frameSize || 960, // 20ms at 48kHz
          encoderComplexity: 8,
          encoderBitRate: data.bitRate || 32000,
          encoderApplication: 2048, // OPUS_APPLICATION_VOIP
          streamPages: false,
          bufferLength: 4096,
          encoderPath: '', // Not needed in worker
        };
        
        console.log('[RealOpusEncoder] Initializing with config:', config);
        
        // Initialize the encoder module
        // The encoderWorker.min.js should have made an OggOpusEncoder available
        if (typeof OggOpusEncoder !== 'undefined') {
          encoder = new OggOpusEncoder(config);
          
          // Set up data handler
          encoder.ondata = function(arrayBuffer) {
            console.log('[RealOpusEncoder] Encoded data ready:', arrayBuffer.byteLength);
            const data = new Uint8Array(arrayBuffer);
            self.postMessage({
              type: 'encoded',
              data: data,
              id: currentId
            }, [data.buffer]);
          };
          
          isReady = true;
          self.postMessage({ type: 'ready' });
        } else {
          throw new Error('OggOpusEncoder not available - module not loaded properly');
        }
      } catch (error) {
        console.error('[RealOpusEncoder] Init error:', error);
        self.postMessage({ 
          type: 'error', 
          error: error.toString() 
        });
      }
      break;
      
    case 'encode':
      if (!encoder || !isReady) {
        self.postMessage({
          type: 'error',
          error: 'Encoder not initialized',
          id: id
        });
        return;
      }
      
      try {
        currentId = id;
        
        // Convert Float32Array to format expected by encoder
        const float32 = new Float32Array(data.buffer);
        
        // The encoder expects interleaved samples
        // For mono, we can send directly
        const buffer = float32.buffer.slice(float32.byteOffset, float32.byteOffset + float32.byteLength);
        
        // Send to encoder
        encoder.encode([buffer]);
        
        // Flush immediately to get data
        if (encoder.flush) {
          encoder.flush();
        }
        
      } catch (error) {
        console.error('[RealOpusEncoder] Encode error:', error);
        self.postMessage({
          type: 'error',
          error: error.toString(),
          id: id
        });
      }
      break;
      
    case 'destroy':
      if (encoder) {
        if (encoder.close) {
          encoder.close();
        }
        encoder = null;
        isReady = false;
      }
      break;
  }
};