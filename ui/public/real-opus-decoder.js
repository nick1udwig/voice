// Real Opus decoder worker that directly uses the decoderWorker.min.js module
importScripts('./decoderWorker.min.js');

let decoder = null;
let isReady = false;
let currentId = 0;
let pendingCallback = null;

// The decoder module uses a different initialization pattern
// It expects to receive messages in a specific format

// Override the self.onmessage after the module loads
const originalOnMessage = self.onmessage;

// First, let the module set up its message handler
setTimeout(() => {
  // Now wrap the message handler
  const moduleOnMessage = self.onmessage;
  
  self.onmessage = function(e) {
    console.log('[RealOpusDecoder] Received message:', e.data.type || e.data.command);
    
    // Handle our init message
    if (e.data.type === 'init') {
      try {
        // Initialize the decoder using the module's expected format
        moduleOnMessage({
          data: {
            command: 'init',
            decoderSampleRate: e.data.data.sampleRate || 48000,
            outputBufferSampleRate: e.data.data.sampleRate || 48000,
            numberOfChannels: e.data.data.channels || 1,
            resampleQuality: 3,
            bufferLength: 4096
          }
        });
        
        isReady = true;
        self.postMessage({ type: 'ready' });
      } catch (error) {
        console.error('[RealOpusDecoder] Init error:', error);
        self.postMessage({ 
          type: 'error', 
          error: error.toString() 
        });
      }
      return;
    }
    
    // Handle our decode message
    if (e.data.type === 'decode') {
      if (!isReady) {
        self.postMessage({
          type: 'error',
          error: 'Decoder not initialized',
          id: e.data.id
        });
        return;
      }
      
      try {
        currentId = e.data.id;
        pendingCallback = true;
        
        // Convert our data to the format expected by the decoder
        const uint8Data = new Uint8Array(e.data.data);
        const buffer = uint8Data.buffer.slice(uint8Data.byteOffset, uint8Data.byteOffset + uint8Data.byteLength);
        
        // Send decode command
        moduleOnMessage({
          data: {
            command: 'decode',
            pages: buffer
          }
        });
        
        // Send done command to flush
        moduleOnMessage({
          data: {
            command: 'done'
          }
        });
        
      } catch (error) {
        console.error('[RealOpusDecoder] Decode error:', error);
        self.postMessage({
          type: 'error',
          error: error.toString(),
          id: currentId
        });
      }
      return;
    }
    
    // Handle destroy
    if (e.data.type === 'destroy') {
      isReady = false;
      decoder = null;
      return;
    }
    
    // For module messages, check if it's decoded data
    if (e.data && Array.isArray(e.data) && e.data.length > 0 && e.data[0] instanceof Float32Array) {
      // This is decoded audio data
      console.log('[RealOpusDecoder] Decoded audio received:', e.data[0].length, 'samples');
      
      if (pendingCallback) {
        pendingCallback = false;
        self.postMessage({
          type: 'decoded',
          data: e.data[0],
          id: currentId
        }, [e.data[0].buffer]);
      }
      return;
    }
    
    // Otherwise, pass to the module's handler
    if (moduleOnMessage !== self.onmessage) {
      moduleOnMessage(e);
    }
  };
}, 100);