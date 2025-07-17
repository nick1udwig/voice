import Recorder from 'opus-recorder';

interface DecoderState {
  worker: Worker;
  initialized: boolean;
  pendingDecodes: Array<{resolve: (data: Float32Array) => void, reject: (err: any) => void}>;
}

export class ContinuousOpusService {
  private recorder: Recorder | null = null;
  private onDataCallback?: (data: Uint8Array) => void;
  private isMuted: boolean = true;
  // Maintain decoder state per stream
  private decoderStates: Map<string, DecoderState> = new Map();

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

    // Check if already recording
    if (this.recorder.state === 'recording') {
      console.log('[ContinuousOpusService] Already recording, skipping start');
      return;
    }

    console.log('[ContinuousOpusService] Starting recording, current state:', this.recorder.state);
    
    // Start recording like the example
    await this.recorder.start().catch((e: Error) => {
      console.error('[ContinuousOpusService] Error encountered:', e.message);
      throw e;
    });
  }

  async stopRecording(): Promise<void> {
    if (!this.recorder) return;
    
    // Check if actually recording
    if (this.recorder.state !== 'recording' && this.recorder.state !== 'paused') {
      console.log('[ContinuousOpusService] Not recording, skipping stop. State:', this.recorder.state);
      return;
    }
    
    console.log('[ContinuousOpusService] Stopping recording, current state:', this.recorder.state);
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

  // Create decoder state for a stream
  private createDecoderState(streamId: string): DecoderState {
    console.log('[ContinuousOpusService] Creating decoder for stream:', streamId);
    
    const worker = new Worker('/voice:voice:sys/decoderWorker.min.js');
    const state: DecoderState = {
      worker,
      initialized: false,
      pendingDecodes: []
    };
    
    worker.onmessage = (e) => {
      if (e.data === null) {
        // Done signal - ignore for streaming decoder
        return;
      } else if (Array.isArray(e.data) && e.data.length > 0) {
        // Got decoded data
        const pending = state.pendingDecodes.shift();
        if (pending) {
          // Take first channel, return exactly 960 samples
          const data = new Float32Array(960);
          const sourceData = e.data[0];
          const copyLength = Math.min(sourceData.length, 960);
          data.set(sourceData.subarray(0, copyLength));
          
          console.log('[ContinuousOpusService] Decoded', copyLength, 'samples for stream:', streamId);
          pending.resolve(data);
        }
      }
    };

    worker.onerror = (error) => {
      console.error('[ContinuousOpusService] Decoder error for stream', streamId, ':', error);
      const pending = state.pendingDecodes.shift();
      if (pending) {
        pending.reject(error);
      }
    };

    // Initialize decoder
    worker.postMessage({
      command: 'init',
      decoderSampleRate: 48000,
      outputBufferSampleRate: 48000,
      resampleQuality: 3,
      bufferLength: 960 // Set buffer length to match frame size
    });
    
    state.initialized = true;
    return state;
  }

  // Decoder functionality with streaming support
  async decode(opusData: Uint8Array, streamId: string = 'default'): Promise<Float32Array> {
    console.log('[ContinuousOpusService] Decoding', opusData.length, 'bytes for stream:', streamId);
    
    // Get or create decoder state for this stream
    let state = this.decoderStates.get(streamId);
    if (!state) {
      state = this.createDecoderState(streamId);
      this.decoderStates.set(streamId, state);
    }
    
    return new Promise((resolve, reject) => {
      // Queue the callback
      state!.pendingDecodes.push({ resolve, reject });
      
      // Send Ogg data directly to decoder - it maintains state
      const dataToSend = new Uint8Array(opusData);
      state!.worker.postMessage({
        command: 'decode',
        pages: dataToSend
      }, [dataToSend.buffer]);
    });
  }
  

  async cleanup(): Promise<void> {
    console.log('[ContinuousOpusService] Cleaning up');
    
    if (this.recorder) {
      await this.recorder.stop().catch(() => {});
      this.recorder.close();
      this.recorder = null;
    }
    
    // Clean up all decoder states
    for (const [streamId, state] of this.decoderStates) {
      console.log('[ContinuousOpusService] Terminating decoder for stream:', streamId);
      state.worker.terminate();
    }
    this.decoderStates.clear();
  }
}