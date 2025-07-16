declare module 'opus-recorder' {
  interface RecorderConfig {
    bufferLength?: number;
    encoderApplication?: number;
    encoderBitRate?: number;
    encoderComplexity?: number;
    encoderFrameSize?: number;
    encoderPath?: string;
    encoderSampleRate?: number;
    maxFramesPerPage?: number;
    mediaTrackConstraints?: boolean | MediaTrackConstraints;
    monitorGain?: number;
    numberOfChannels?: number;
    originalSampleRateOverride?: number;
    recordingGain?: number;
    resampleQuality?: number;
    streamPages?: boolean;
    wavBitDepth?: number;
    sourceNode?: any;
  }

  class Recorder {
    static isRecordingSupported(): boolean;
    static version: string;
    
    state: 'inactive' | 'recording' | 'paused';
    encodedSamplePosition: number;
    encoder?: Worker;
    
    constructor(config?: RecorderConfig);
    
    close(): Promise<void>;
    pause(flush?: boolean): Promise<void>;
    resume(): void;
    setMonitorGain(gain: number): void;
    setRecordingGain(gain: number): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    
    ondataavailable: (arrayBuffer: ArrayBuffer) => void;
    onpause: () => void;
    onresume: () => void;
    onstart: () => void;
    onstop: () => void;
  }
  
  export = Recorder;
}

declare module 'opus-recorder/dist/encoderWorker.min.js' {
  const encoderPath: string;
  export default encoderPath;
}

declare module 'opus-recorder/dist/decoderWorker.min.js' {
  const decoderPath: string;
  export default decoderPath;
}