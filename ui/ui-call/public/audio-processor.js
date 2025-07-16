class AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    
    try {
      this.frameDuration = (options && options.processorOptions && options.processorOptions.frameDuration) || 20; // ms
      this.sampleRate = (options && options.processorOptions && options.processorOptions.sampleRate) || 48000;
      this.frameSize = Math.floor(this.sampleRate * this.frameDuration / 1000);
      this.buffer = new Float32Array(this.frameSize);
      this.bufferIndex = 0;
      this.frameCount = 0;
    } catch (e) {
      // Fallback to defaults if anything fails
      this.frameDuration = 20;
      this.sampleRate = 48000;
      this.frameSize = 960;
      this.buffer = new Float32Array(this.frameSize);
      this.bufferIndex = 0;
      this.frameCount = 0;
    }
  }
  
  process(inputs, outputs, parameters) {
    try {
      const input = inputs[0];
      
      if (input && input.length > 0 && input[0]) {
        const inputChannel = input[0];
        
        for (let i = 0; i < inputChannel.length; i++) {
          this.buffer[this.bufferIndex++] = inputChannel[i];
          
          if (this.bufferIndex >= this.frameSize) {
            // Create a new buffer with just the data we need
            const frameData = new Float32Array(this.frameSize);
            frameData.set(this.buffer.subarray(0, this.frameSize));
            
            // Send complete frame
            this.frameCount++;
            this.port.postMessage({
              type: 'audio-frame',
              buffer: frameData.buffer
            }, [frameData.buffer]); // Transfer ownership
            
            this.bufferIndex = 0;
          }
        }
      }
    } catch (e) {
      // Silently continue on error
    }
    
    return true; // Keep processor alive
  }
}

registerProcessor('audio-processor', AudioProcessor);