class AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    
    this.frameDuration = options.processorOptions.frameDuration || 20; // ms
    this.sampleRate = options.processorOptions.sampleRate || 48000;
    this.frameSize = Math.floor(this.sampleRate * this.frameDuration / 1000);
    this.buffer = new Float32Array(this.frameSize);
    this.bufferIndex = 0;
    this.frameCount = 0;
    console.log('[AudioProcessor] Initialized with frameSize:', this.frameSize, 'sampleRate:', this.sampleRate);
  }
  
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    
    if (input.length > 0) {
      const inputChannel = input[0];
      
      for (let i = 0; i < inputChannel.length; i++) {
        this.buffer[this.bufferIndex++] = inputChannel[i];
        
        if (this.bufferIndex >= this.frameSize) {
          // Send complete frame
          this.frameCount++;
          if (this.frameCount % 50 === 0) { // Log every 50 frames (1 second)
            console.log('[AudioProcessor] Sending frame', this.frameCount, 'with', this.frameSize, 'samples');
          }
          this.port.postMessage({
            type: 'audio-frame',
            buffer: this.buffer.buffer.slice(0)
          });
          
          this.bufferIndex = 0;
        }
      }
    }
    
    return true; // Keep processor alive
  }
}

registerProcessor('audio-processor', AudioProcessor);