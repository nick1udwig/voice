import { MicVAD } from '@ricky0123/vad-web';

export interface VadConfig {
  positiveSpeechThreshold?: number;
  negativeSpeechThreshold?: number;
  minSpeechFrames?: number;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
}

export class VadService {
  private vad: MicVAD | null = null;
  private isInitialized: boolean = false;
  private isSpeaking: boolean = false;
  private onSpeechStartCallback?: () => void;
  private onSpeechEndCallback?: () => void;
  private lastSpeechTime: number = 0;
  private speechDebounceMs: number = 300; // Debounce rapid on/off

  constructor(private config?: VadConfig) {}

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log('[VadService] Already initialized');
      return;
    }

    console.log('[VadService] Initializing VAD');

    try {
      this.vad = await MicVAD.new({
        // Thresholds for speech detection
        positiveSpeechThreshold: this.config?.positiveSpeechThreshold || 0.5,
        negativeSpeechThreshold: this.config?.negativeSpeechThreshold || 0.35,
        minSpeechFrames: this.config?.minSpeechFrames || 3,
        
        // Callbacks
        onSpeechStart: () => {
          const now = Date.now();
          // Debounce rapid on/off transitions
          if (!this.isSpeaking && (now - this.lastSpeechTime) > this.speechDebounceMs) {
            console.log('[VadService] Speech started');
            this.isSpeaking = true;
            this.lastSpeechTime = now;
            this.onSpeechStartCallback?.();
            this.config?.onSpeechStart?.();
          }
        },
        
        onSpeechEnd: (audio) => {
          const now = Date.now();
          if (this.isSpeaking) {
            console.log('[VadService] Speech ended, audio length:', audio.length);
            this.isSpeaking = false;
            this.lastSpeechTime = now;
            this.onSpeechEndCallback?.();
            this.config?.onSpeechEnd?.();
          }
        },
        
        onVADMisfire: () => {
          console.log('[VadService] VAD misfire - speech too short');
        },
        
        // Use newer v5 model for better accuracy
        model: 'v5',
      });

      this.isInitialized = true;
      console.log('[VadService] VAD initialized successfully');
    } catch (error) {
      console.error('[VadService] Failed to initialize VAD:', error);
      throw error;
    }
  }

  async start(): Promise<void> {
    if (!this.vad) {
      throw new Error('VAD not initialized');
    }

    console.log('[VadService] Starting VAD');
    await this.vad.start();
  }

  pause(): void {
    if (!this.vad) {
      return;
    }

    console.log('[VadService] Pausing VAD');
    this.vad.pause();
  }

  resume(): void {
    if (!this.vad) {
      return;
    }

    console.log('[VadService] Resuming VAD');
    this.vad.start();
  }

  isSpeakingNow(): boolean {
    return this.isSpeaking;
  }

  setOnSpeechStart(callback: () => void): void {
    this.onSpeechStartCallback = callback;
  }

  setOnSpeechEnd(callback: () => void): void {
    this.onSpeechEndCallback = callback;
  }

  async cleanup(): Promise<void> {
    console.log('[VadService] Cleaning up');
    
    if (this.vad) {
      this.vad.pause();
      // Note: vad-web doesn't have a destroy method, so we just null the reference
      this.vad = null;
    }
    
    this.isInitialized = false;
    this.isSpeaking = false;
  }
}