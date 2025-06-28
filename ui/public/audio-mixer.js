class AudioMixer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    
    this.sampleRate = options.processorOptions.sampleRate || 48000;
    this.channels = new Map(); // channel id -> audio data
    this.mixBuffer = new Float32Array(128); // Process in 128 sample chunks
  }
  
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    
    if (output.length > 0) {
      const outputChannel = output[0];
      
      // Clear mix buffer
      this.mixBuffer.fill(0);
      
      // Mix all input channels
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        if (input.length > 0) {
          const inputChannel = input[0];
          
          // Add to mix with automatic gain control
          const gain = 1.0 / Math.sqrt(Math.max(1, inputs.length));
          for (let j = 0; j < inputChannel.length; j++) {
            this.mixBuffer[j] += inputChannel[j] * gain;
          }
        }
      }
      
      // Apply limiter to prevent clipping
      for (let i = 0; i < outputChannel.length; i++) {
        outputChannel[i] = Math.tanh(this.mixBuffer[i]);
      }
      
      // Send mixed audio data
      this.port.postMessage({
        type: 'mixed-audio',
        buffer: outputChannel.slice()
      });
    }
    
    return true;
  }
}

registerProcessor('audio-mixer', AudioMixer);