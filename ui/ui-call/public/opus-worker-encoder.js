// Opus encoder worker with proper isolation
(function() {
  'use strict';
  
  let encoderInstance = null;
  let isReady = false;
  let config = null;
  let currentId = 0;

  // Import the opus encoder in an isolated scope
  try {
    importScripts('./encoderWorker.min.js');
  } catch (e) {
    console.error('[OpusWorkerEncoder] Failed to import encoderWorker.min.js:', e);
    self.postMessage({ 
      type: 'error', 
      error: 'Failed to load encoder module: ' + e.message 
    });
    return;
  }

  console.log('[OpusWorkerEncoder] Module loaded successfully');

  // Handle our messages
  self.addEventListener('message', function(e) {
    const { type, data, id } = e.data;
    console.log('[OpusWorkerEncoder] Received message:', type);
    
    switch (type) {
      case 'init':
        try {
          // Check if OggOpusEncoder is available
          if (typeof OggOpusEncoder === 'undefined') {
            throw new Error('OggOpusEncoder not available');
          }
          
          config = {
            numberOfChannels: data.channels || 1,
            encoderSampleRate: data.sampleRate || 48000,
            encoderFrameSize: data.frameSize || 960,
            encoderComplexity: 8,
            encoderBitRate: data.bitRate || 32000,
            encoderApplication: 2048,
            streamPages: false,
            bufferLength: 4096
          };
          
          console.log('[OpusWorkerEncoder] Creating encoder with config:', config);
          
          encoderInstance = new OggOpusEncoder(config);
          
          // Set up data callback
          encoderInstance.ondata = function(arrayBuffer) {
            console.log('[OpusWorkerEncoder] Encoded data:', arrayBuffer.byteLength, 'bytes');
            const uint8Data = new Uint8Array(arrayBuffer);
            self.postMessage({
              type: 'encoded',
              data: uint8Data,
              id: currentId
            }, [uint8Data.buffer]);
          };
          
          isReady = true;
          console.log('[OpusWorkerEncoder] Encoder ready');
          self.postMessage({ type: 'ready' });
          
        } catch (error) {
          console.error('[OpusWorkerEncoder] Init error:', error);
          self.postMessage({ 
            type: 'error', 
            error: error.message 
          });
        }
        break;
        
      case 'encode':
        if (!encoderInstance || !isReady) {
          self.postMessage({
            type: 'error',
            error: 'Encoder not initialized',
            id: id
          });
          return;
        }
        
        try {
          currentId = id;
          const float32Data = new Float32Array(data.buffer);
          
          console.log('[OpusWorkerEncoder] Encoding', float32Data.length, 'samples');
          
          // Create a copy of the buffer to avoid transfer issues
          const bufferCopy = float32Data.buffer.slice(0);
          
          // Encode the audio
          encoderInstance.encode([bufferCopy]);
          
          // Force flush
          if (encoderInstance.flush) {
            encoderInstance.flush();
          }
          
        } catch (error) {
          console.error('[OpusWorkerEncoder] Encode error:', error);
          self.postMessage({
            type: 'error',
            error: error.message,
            id: id
          });
        }
        break;
        
      case 'destroy':
        if (encoderInstance) {
          try {
            if (encoderInstance.close) {
              encoderInstance.close();
            }
          } catch (e) {
            console.error('[OpusWorkerEncoder] Error closing encoder:', e);
          }
          encoderInstance = null;
          isReady = false;
        }
        break;
    }
  });
  
  console.log('[OpusWorkerEncoder] Worker initialized and ready for messages');
})();