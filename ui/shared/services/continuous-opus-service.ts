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

  // Decoder functionality - create new worker for each decode like the example
  async decode(opusData: Uint8Array): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      // Create a new decoder worker for each decode operation like the example
      const decoderWorker = new Worker('/voice:voice:sys/decoderWorker.min.js');
      
      let decoded = false;
      const output: Float32Array[] = [];
      
      decoderWorker.onmessage = (e) => {
        if (e.data === null) {
          // Decoder finished - combine all output
          if (!decoded && output.length > 0) {
            decoded = true;
            // Concatenate all output buffers
            let totalLength = 0;
            for (const buffer of output) {
              totalLength += buffer.length;
            }
            const combined = new Float32Array(totalLength);
            let offset = 0;
            for (const buffer of output) {
              combined.set(buffer, offset);
              offset += buffer.length;
            }
            // Return just the first frame (960 samples)
            const result = combined.slice(0, 960);
            resolve(result);
          }
          decoderWorker.terminate();
        } else if (Array.isArray(e.data) && e.data.length > 0) {
          // Got decoded data - store it
          output.push(e.data[0]);
        }
      };

      decoderWorker.onerror = (error) => {
        console.error('[ContinuousOpusService] Decoder error:', error);
        reject(error);
        decoderWorker.terminate();
      };

      // Initialize decoder like the example (without bufferLength)
      decoderWorker.postMessage({
        command: 'init',
        decoderSampleRate: 48000,
        outputBufferSampleRate: 48000
      });

      // Decode the data
      const dataToSend = new Uint8Array(opusData);
      decoderWorker.postMessage({
        command: 'decode',
        pages: dataToSend
      }, [dataToSend.buffer]);

      // Signal done
      decoderWorker.postMessage({
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