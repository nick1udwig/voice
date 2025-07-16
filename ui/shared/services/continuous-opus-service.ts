import Recorder from 'opus-recorder';

export class ContinuousOpusService {
  private recorder: Recorder | null = null;
  private onDataCallback?: (data: Uint8Array) => void;
  private isMuted: boolean = true;

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

  // Decoder functionality
  async decode(opusData: Uint8Array): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      const decoder = new Worker('/voice:voice:sys/decoderWorker.min.js');
      
      let resolved = false;
      
      decoder.onmessage = (e) => {
        if (e.data === null) {
          // Decoder finished
          decoder.terminate();
        } else if (Array.isArray(e.data) && e.data.length > 0 && !resolved) {
          // Got decoded data
          resolved = true;
          resolve(e.data[0]); // Return first channel
          decoder.terminate();
        }
      };

      decoder.onerror = (error) => {
        console.error('[ContinuousOpusService] Decoder error:', error);
        reject(error);
        decoder.terminate();
      };

      // Initialize decoder
      decoder.postMessage({
        command: 'init',
        decoderSampleRate: 48000,
        outputBufferSampleRate: 48000
      });

      // Decode the data
      decoder.postMessage({
        command: 'decode',
        pages: opusData
      });

      // Signal end of data
      decoder.postMessage({
        command: 'done'
      });
    });
  }

  async cleanup(): Promise<void> {
    console.log('[ContinuousOpusService] Cleaning up');
    
    if (this.recorder) {
      await this.recorder.stop().catch(() => {});
      this.recorder.close();
      this.recorder = null;
    }
  }
}