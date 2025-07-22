declare global {
  interface Window {
    LIBOPUS_WASM_URL: string;
    libopus: any;
  }
}

interface OpusEncoder {
  input(samples: Int16Array): void;
  output(): Uint8Array | null;
  destroy(): void;
}

interface OpusDecoder {
  input(packet: Uint8Array): void;
  output(): Int16Array | null;
  destroy(): void;
}

export class RawOpusService {
  private encoder: OpusEncoder | null = null;
  private decoders: Map<string, OpusDecoder> = new Map();
  private audioContext: AudioContext | null = null;
  private audioInput: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private onDataCallback?: (data: Uint8Array) => void;
  private isRecording: boolean = false;
  private libopusReady: Promise<void>;
  private isMuted: boolean = true;
  private mediaStream: MediaStream | null = null;

  constructor() {
    // Set WASM URL before loading
    const baseUrl = import.meta.env.BASE_URL || '';
    window.LIBOPUS_WASM_URL = `${baseUrl}/libopus.wasm`;

    // Load libopus
    this.libopusReady = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${baseUrl}/libopus.wasm.js`;
      script.onload = () => {
        if (window.libopus && window.libopus.loaded) {
          console.log('[RawOpusService] libopus already loaded');
          resolve();
        } else if (window.libopus) {
          console.log('[RawOpusService] Waiting for libopus to load...');
          window.libopus.onload = () => {
            console.log('[RawOpusService] libopus loaded via onload');
            resolve();
          };
        } else {
          reject(new Error('Failed to load libopus'));
        }
      };
      script.onerror = () => reject(new Error('Failed to load libopus script'));
      document.head.appendChild(script);
    });
  }

  async initialize(): Promise<void> {
    await this.libopusReady;
    console.log('[RawOpusService] libopus loaded successfully');
  }

  setOnDataCallback(callback: (data: Uint8Array) => void): void {
    this.onDataCallback = callback;
  }

  async startRecording(): Promise<void> {
    await this.libopusReady;

    if (this.isRecording) {
      console.log('[RawOpusService] Already recording');
      return;
    }

    try {
      // Create encoder: 1 channel, 48kHz, 32kbps, 20ms frames, voice optimization
      this.encoder = new window.libopus.Encoder(1, 48000, 32000, 20, true);
      console.log('[RawOpusService] Created Opus encoder');

      // Get microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 48000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Create audio context
      this.audioContext = new AudioContext({ sampleRate: 48000 });
      this.audioInput = this.audioContext.createMediaStreamSource(this.mediaStream);

      // Create script processor for capturing audio
      // Use 1024 samples (power of 2) but we'll only use 960 for Opus
      this.processor = this.audioContext.createScriptProcessor(1024, 1, 1);
      
      // Buffer to accumulate samples
      let sampleBuffer = new Float32Array(0);

      this.processor.onaudioprocess = (e) => {
        if (!this.encoder || !this.isRecording || this.isMuted) return;

        const inputData = e.inputBuffer.getChannelData(0);
        
        // Append new samples to buffer
        const newBuffer = new Float32Array(sampleBuffer.length + inputData.length);
        newBuffer.set(sampleBuffer);
        newBuffer.set(inputData, sampleBuffer.length);
        sampleBuffer = newBuffer;

        // Process in 960-sample chunks (20ms at 48kHz)
        while (sampleBuffer.length >= 960) {
          const chunk = sampleBuffer.slice(0, 960);
          sampleBuffer = sampleBuffer.slice(960);

          // Convert Float32Array to Int16Array
          const samples = new Int16Array(960);
          for (let i = 0; i < 960; i++) {
            const s = Math.max(-1, Math.min(1, chunk[i]));
            samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }

          // Feed to encoder
          this.encoder.input(samples);

          // Get encoded packets
          let packet = this.encoder.output();
          while (packet) {
            // Debug: Check if this is raw Opus or Ogg-wrapped
            if (packet.length >= 4) {
              const first4 = Array.from(packet.slice(0, 4));
              const isOgg = first4[0] === 79 && first4[1] === 103 && first4[2] === 103 && first4[3] === 83; // "OggS"
              if (isOgg) {
                console.error('[RawOpusService] ERROR: Encoding produced Ogg data, not raw Opus!');
              }
              // Log occasionally
              if (Math.random() < 0.01) {
                console.log('[RawOpusService] Encoded packet size:', packet.length,
                           'first 4 bytes:', first4, 'isOgg:', isOgg);
              }
            }
            this.onDataCallback?.(packet);
            packet = this.encoder.output();
          }
        }
      };

      // Connect audio graph
      this.audioInput.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this.isRecording = true;
      console.log('[RawOpusService] Recording started');
    } catch (error) {
      console.error('[RawOpusService] Failed to start recording:', error);
      throw error;
    }
  }

  async stopRecording(): Promise<void> {
    if (!this.isRecording) return;

    console.log('[RawOpusService] Stopping recording...');
    this.isRecording = false;

    // Disconnect audio graph
    if (this.audioInput && this.processor) {
      try {
        this.audioInput.disconnect();
        this.processor.disconnect();
      } catch (e) {
        // Already disconnected
      }
    }

    // Stop all tracks
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    // Destroy encoder
    if (this.encoder) {
      this.encoder.destroy();
      this.encoder = null;
    }

    // Close audio context
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
      this.audioContext = null;
    }

    console.log('[RawOpusService] Recording stopped');
  }

  setMuted(muted: boolean): void {
    console.log('[RawOpusService] Setting muted:', muted);
    this.isMuted = muted;
  }

  async decode(opusData: Uint8Array, streamId: string = 'default'): Promise<Float32Array> {
    await this.libopusReady;

    // Get or create decoder for this stream
    let decoder = this.decoders.get(streamId);
    if (!decoder) {
      decoder = new window.libopus.Decoder(1, 48000);
      this.decoders.set(streamId, decoder!);
      console.log('[RawOpusService] Created decoder for stream:', streamId);
    }

    // Log packet info occasionally for debugging
    if (Math.random() < 0.01) {
      console.log('[RawOpusService] Decoding packet - stream:', streamId, 'size:', opusData.length, 'decoders:', this.decoders.size);
    }

    // Now decoder is guaranteed to be defined
    // Feed packet to decoder
    decoder!.input(opusData);

    // Get decoded samples
    const samples = decoder!.output();
    if (!samples) {
      // No output yet (shouldn't happen with 20ms frames)
      console.warn('[RawOpusService] No decoder output for stream:', streamId, 'packet size:', opusData.length);
      return new Float32Array(960);
    }

    // Convert Int16Array to Float32Array
    const float32Data = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      float32Data[i] = samples[i] / 32768.0;
    }

    // Check for silent output
    if (Math.random() < 0.01) {
      const maxAmplitude = Math.max(...samples.map(Math.abs));
      const hasAudio = float32Data.some(sample => Math.abs(sample) > 0.001);
      console.log('[RawOpusService] Decoded audio - stream:', streamId, 'samples:', samples.length, 
                  'maxAmplitude:', maxAmplitude, 'hasAudio:', hasAudio);
    }

    return float32Data;
  }

  clearDecoder(streamId: string): void {
    const decoder = this.decoders.get(streamId);
    if (decoder) {
      decoder.destroy();
      this.decoders.delete(streamId);
      console.log('[RawOpusService] Cleared decoder for stream:', streamId);
    }
  }

  clearAllDecoders(): void {
    for (const [streamId, decoder] of this.decoders) {
      decoder.destroy();
      console.log('[RawOpusService] Destroyed decoder for stream:', streamId);
    }
    this.decoders.clear();
  }

  async cleanup(): Promise<void> {
    console.log('[RawOpusService] Cleaning up...');
    
    // Stop recording
    await this.stopRecording();

    // Destroy all decoders
    this.clearAllDecoders();
  }
}