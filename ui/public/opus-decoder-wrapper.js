// Wrapper for decoderWorker.min.js to handle our message protocol
let decoder = null;
let isReady = false;

// Import the actual opus decoder
try {
  importScripts('./decoderWorker.min.js');
} catch (e) {
  console.error('[OpusDecoderWrapper] Failed to import decoderWorker.min.js:', e);
  try {
    importScripts('/decoderWorker.min.js');
  } catch (e2) {
    console.error('[OpusDecoderWrapper] Failed to import with absolute path:', e2);
    throw e2;
  }
}

console.log('[OpusDecoderWrapper] Worker loaded, Module available:', typeof Module !== 'undefined');

// Wait for Module to be ready
if (typeof Module !== 'undefined' && Module.onRuntimeInitialized) {
  Module.onRuntimeInitialized = function() {
    console.log('[OpusDecoderWrapper] WASM runtime initialized');
  };
}

// Handle messages
self.onmessage = function(e) {
  console.log('[OpusDecoderWrapper] Received message:', e.data.command || e.data.type);
  
  // Handle both 'command' and 'type' for compatibility
  const command = e.data.command || e.data.type;
  const data = e.data;
  
  switch (command) {
    case 'init':
      try {
        // Check if OggOpusDecoder is available
        if (typeof Module === 'undefined' || typeof Module.OggOpusDecoder === 'undefined') {
          console.error('[OpusDecoderWrapper] OggOpusDecoder not found');
          console.log('[OpusDecoderWrapper] Module:', Module);
          throw new Error('OggOpusDecoder not available');
        }
        
        // Initialize decoder
        decoder = new Module.OggOpusDecoder({
          bufferLength: 4096,
          decoderSampleRate: data.decoderSampleRate || data.sampleRate || 48000,
          outputBufferSampleRate: data.outputBufferSampleRate || data.sampleRate || 48000,
          resampleQuality: 3
        });
        
        isReady = true;
        console.log('[OpusDecoderWrapper] Decoder initialized successfully');
        self.postMessage({ type: 'ready' });
      } catch (error) {
        console.error('[OpusDecoderWrapper] Init error:', error);
        self.postMessage({ type: 'error', error: error.message });
      }
      break;
      
    case 'decode':
      if (!decoder || !isReady) {
        console.error('[OpusDecoderWrapper] Decoder not ready');
        self.postMessage({
          type: 'error',
          error: 'Decoder not initialized',
          id: data.id
        });
        return;
      }
      
      try {
        console.log('[OpusDecoderWrapper] Decoding data of size:', data.pages.byteLength);
        
        // The decoder expects pages in a specific format
        decoder.decode(data.pages);
        
        // Note: The decoder will post messages directly when data is ready
        // via the original worker's postMessage
      } catch (error) {
        console.error('[OpusDecoderWrapper] Decode error:', error);
        self.postMessage({
          type: 'error',
          error: error.message,
          id: data.id
        });
      }
      break;
      
    case 'done':
      if (decoder) {
        decoder.sendLastBuffer();
      }
      break;
      
    case 'destroy':
      if (decoder) {
        decoder = null;
        isReady = false;
      }
      break;
  }
};

console.log('[OpusDecoderWrapper] Worker ready for messages');