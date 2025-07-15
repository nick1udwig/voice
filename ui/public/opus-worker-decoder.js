// Opus decoder worker with proper isolation
(function() {
  'use strict';
  
  let decoderInstance = null;
  let isReady = false;
  let currentId = 0;
  let moduleMessageHandler = null;

  // Import the opus decoder in an isolated scope
  try {
    importScripts('./decoderWorker.min.js');
  } catch (e) {
    console.error('[OpusWorkerDecoder] Failed to import decoderWorker.min.js:', e);
    self.postMessage({ 
      type: 'error', 
      error: 'Failed to load decoder module: ' + e.message 
    });
    return;
  }

  console.log('[OpusWorkerDecoder] Module loaded successfully');

  // Wait a bit for the module to set up its handler
  setTimeout(function() {
    // Capture the module's message handler
    moduleMessageHandler = self.onmessage;
    
    // Install our message handler
    self.onmessage = function(e) {
      const msgType = e.data.type || e.data.command;
      console.log('[OpusWorkerDecoder] Received message:', msgType);
      
      if (e.data.type === 'init') {
        try {
          // Initialize using the module's expected format
          if (moduleMessageHandler) {
            moduleMessageHandler({
              data: {
                command: 'init',
                decoderSampleRate: e.data.data.sampleRate || 48000,
                outputBufferSampleRate: e.data.data.sampleRate || 48000,
                numberOfChannels: e.data.data.channels || 1,
                resampleQuality: 3,
                bufferLength: 4096
              }
            });
          }
          
          isReady = true;
          console.log('[OpusWorkerDecoder] Decoder initialized');
          self.postMessage({ type: 'ready' });
          
        } catch (error) {
          console.error('[OpusWorkerDecoder] Init error:', error);
          self.postMessage({ 
            type: 'error', 
            error: error.message 
          });
        }
        return;
      }
      
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
          const opusData = new Uint8Array(e.data.data);
          
          console.log('[OpusWorkerDecoder] Decoding', opusData.length, 'bytes');
          
          // Create ArrayBuffer from the data
          const buffer = opusData.buffer.slice(
            opusData.byteOffset, 
            opusData.byteOffset + opusData.byteLength
          );
          
          // Send to decoder
          if (moduleMessageHandler) {
            moduleMessageHandler({
              data: {
                command: 'decode',
                pages: buffer
              }
            });
            
            // Send done command
            moduleMessageHandler({
              data: {
                command: 'done'
              }
            });
          }
          
        } catch (error) {
          console.error('[OpusWorkerDecoder] Decode error:', error);
          self.postMessage({
            type: 'error',
            error: error.message,
            id: currentId
          });
        }
        return;
      }
      
      if (e.data.type === 'destroy') {
        isReady = false;
        decoderInstance = null;
        return;
      }
      
      // Check if this is decoded audio from the module
      if (e.data && Array.isArray(e.data) && e.data.length > 0) {
        if (e.data[0] instanceof Float32Array) {
          console.log('[OpusWorkerDecoder] Decoded audio:', e.data[0].length, 'samples');
          self.postMessage({
            type: 'decoded',
            data: e.data[0],
            id: currentId
          }, [e.data[0].buffer]);
          return;
        }
      }
      
      // Pass through to module handler if needed
      if (moduleMessageHandler && e.data.command) {
        moduleMessageHandler(e);
      }
    };
    
    console.log('[OpusWorkerDecoder] Message handler installed');
    
  }, 100);
  
  console.log('[OpusWorkerDecoder] Worker initialized');
})();