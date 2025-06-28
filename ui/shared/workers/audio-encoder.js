// Audio encoder worker for Opus encoding
importScripts('https://cdn.jsdelivr.net/npm/opus-media-recorder@latest/encoderWorker.umd.js');

let encoder = null;
let sampleRate = 48000;

self.onmessage = function(e) {
  const { type, data } = e.data;
  
  switch (type) {
    case 'init':
      sampleRate = data.sampleRate || 48000;
      encoder = new OpusMediaRecorder.encoder({
        sampleRate: sampleRate,
        channels: 1,
        application: 2048, // OPUS_APPLICATION_VOIP
        frameDuration: 20, // 20ms frames
      });
      break;
      
    case 'encode':
      if (encoder) {
        const encoded = encoder.encode(data.buffer);
        if (encoded.length > 0) {
          self.postMessage({
            type: 'encoded',
            data: encoded,
            timestamp: data.timestamp
          });
        }
      }
      break;
      
    case 'destroy':
      if (encoder) {
        encoder.destroy();
        encoder = null;
      }
      break;
  }
};