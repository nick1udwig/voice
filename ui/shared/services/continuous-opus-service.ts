import Recorder from 'opus-recorder';

export class ContinuousOpusService {
  private recorder: Recorder | null = null;
  private onDataCallback?: (data: Uint8Array) => void;
  private isMuted: boolean = true;
  private decoderWorker: Worker | null = null;
  private pendingDecodes: Array<{resolve: (data: Float32Array) => void, reject: (err: any) => void}> = [];

  constructor() {}

  async initialize(): Promise<void> {
    console.log('[ContinuousOpusService] Initializing');

    // Simple initialization like the example
    this.recorder = new Recorder({
      encoderPath: '/voice:voice:sys/encoderWorker.min.js',
      encoderSampleRate: 48000,
      numberOfChannels: 1,
      encoderBitRate: 32000,
      streamPages: true,
      maxFramesPerPage: 1,
      encoderFrameSize: 20,
      monitorGain: 0,
      recordingGain: 1
    });

    // Set up event handlers like the example
    this.recorder.ondataavailable = (typedArray: ArrayBuffer) => {
      const data = new Uint8Array(typedArray);
      console.log('[ContinuousOpusService] Data received:', data.length, 'bytes - muted:', this.isMuted, 'recorder state:', this.recorder?.state);
      
      // Always forward data - let AudioService decide whether to send
      this.onDataCallback?.(data);
    };

    this.recorder.onstart = () => {
      console.log('[ContinuousOpusService] Recorder is started');
    };

    this.recorder.onstop = () => {
      console.log('[ContinuousOpusService] Recorder is stopped');
    };

    this.recorder.onpause = () => {
      console.log('[ContinuousOpusService] Recorder is paused');
    };

    this.recorder.onresume = () => {
      console.log('[ContinuousOpusService] Recorder is resuming');
    };

    console.log('[ContinuousOpusService] Initialization complete');
  }

  setOnDataCallback(callback: (data: Uint8Array) => void): void {
    this.onDataCallback = callback;
  }

  async startRecording(): Promise<void> {
    if (!this.recorder) {
      throw new Error('Recorder not initialized');
    }

    console.log('[ContinuousOpusService] Starting recording');
    
    // Start recording like the example
    await this.recorder.start().catch((e: Error) => {
      console.error('[ContinuousOpusService] Error encountered:', e.message);
      throw e;
    });
  }

  async stopRecording(): Promise<void> {
    if (!this.recorder) return;
    
    console.log('[ContinuousOpusService] Stopping recording');
    await this.recorder.stop();
  }

  pauseRecording(): void {
    if (!this.recorder) return;
    console.log('[ContinuousOpusService] Pausing recording');
    this.recorder.pause();
  }

  resumeRecording(): void {
    if (!this.recorder) return;
    console.log('[ContinuousOpusService] Resuming recording');
    this.recorder.resume();
  }

  setMuted(muted: boolean): void {
    console.log('[ContinuousOpusService] Setting muted:', muted);
    this.isMuted = muted;
    
    // Still try to pause/resume to save resources
    if (muted) {
      this.pauseRecording();
    } else {
      this.resumeRecording();
    }
  }

  // Initialize persistent decoder
  private initDecoder(): void {
    if (this.decoderWorker) return;
    
    console.log('[ContinuousOpusService] Creating persistent decoder worker');
    this.decoderWorker = new Worker('/voice:voice:sys/decoderWorker.min.js');
    
    this.decoderWorker.onmessage = (e) => {
      if (e.data === null) {
        // Done signal - ignore for persistent decoder
        return;
      } else if (Array.isArray(e.data) && e.data.length > 0) {
        // Got decoded data
        const pending = this.pendingDecodes.shift();
        if (pending) {
          // Take first channel, limit to 960 samples
          const data = e.data[0].slice(0, 960);
          pending.resolve(data);
        }
      }
    };

    this.decoderWorker.onerror = (error) => {
      console.error('[ContinuousOpusService] Decoder error:', error);
      const pending = this.pendingDecodes.shift();
      if (pending) {
        pending.reject(error);
      }
    };

    // Initialize once
    this.decoderWorker.postMessage({
      command: 'init',
      decoderSampleRate: 48000,
      outputBufferSampleRate: 48000,
      resampleQuality: 3
    });
  }

  // Decoder functionality
  async decode(opusData: Uint8Array): Promise<Float32Array> {
    // Initialize decoder on first use
    if (!this.decoderWorker) {
      this.initDecoder();
    }
    
    return new Promise((resolve, reject) => {
      // Queue the callback
      this.pendingDecodes.push({ resolve, reject });
      
      // The server sends complete Ogg files, so pass directly to decoder
      const dataToSend = new Uint8Array(opusData);
      this.decoderWorker!.postMessage({
        command: 'decode',
        pages: dataToSend
      }, [dataToSend.buffer]);
    });
  }
  
  private wrapOpusInOgg(opusFrame: Uint8Array): Uint8Array {
    // Create a minimal Ogg wrapper for a single Opus frame
    // This is a simplified version - just enough for the decoder
    const output: number[] = [];
    
    // OggS header
    output.push(0x4F, 0x67, 0x67, 0x53); // "OggS"
    output.push(0x00); // Version
    output.push(0x02); // Header type (first page)
    output.push(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00); // Granule position
    output.push(0xDE, 0xAD, 0xBE, 0xEF); // Serial number
    output.push(0x00, 0x00, 0x00, 0x00); // Page sequence
    output.push(0x00, 0x00, 0x00, 0x00); // CRC (will be wrong but decoder might not check)
    output.push(0x01); // Number of segments
    output.push(opusFrame.length); // Segment length
    
    // Add the opus frame
    for (let i = 0; i < opusFrame.length; i++) {
      output.push(opusFrame[i]);
    }
    
    return new Uint8Array(output);
  }

  async cleanup(): Promise<void> {
    console.log('[ContinuousOpusService] Cleaning up');
    
    if (this.recorder) {
      await this.recorder.stop().catch(() => {});
      this.recorder.close();
      this.recorder = null;
    }
    
    if (this.decoderWorker) {
      this.decoderWorker.terminate();
      this.decoderWorker = null;
    }
  }
}