import { MicVAD } from '@ricky0123/vad-web';

export interface VadConfig {
  positiveSpeechThreshold?: number;
  negativeSpeechThreshold?: number;
  minSpeechFrames?: number;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  enableAdaptive?: boolean;
}

export class VadService {
  private vad: MicVAD | null = null;
  private isInitialized: boolean = false;
  private isSpeaking: boolean = false;
  private onSpeechStartCallback?: () => void;
  private onSpeechEndCallback?: () => void;
  private lastSpeechTime: number = 0;
  private speechDebounceMs: number = 300; // Debounce rapid on/off
  
  // Noise floor estimation
  private noiseFloor: number = 0.1;
  private readonly NOISE_FLOOR_RISE: number = 0.0001;
  private readonly NOISE_FLOOR_FALL: number = 0.01;
  private audioLevelSamples: number[] = [];
  private readonly LEVEL_SAMPLE_SIZE: number = 50;
  
  // Adaptive thresholds
  private basePositiveThreshold: number = 0.5;
  private baseNegativeThreshold: number = 0.35;
  private adaptiveEnabled: boolean = true;
  
  // Signal quality monitoring
  private speechStartCount: number = 0;
  private lastSpeechStartTime: number = 0;
  private continuousSpeechStartTime: number = 0;
  private silenceStartTime: number = Date.now();

  constructor(private config?: VadConfig) {
    this.basePositiveThreshold = config?.positiveSpeechThreshold || 0.5;
    this.baseNegativeThreshold = config?.negativeSpeechThreshold || 0.35;
    this.adaptiveEnabled = config?.enableAdaptive !== false; // Default to true
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }


    try {
      // Get initial thresholds (adaptive or base)
      const thresholds = this.getAdaptiveThresholds();
      
      this.vad = await MicVAD.new({
        // Thresholds for speech detection
        positiveSpeechThreshold: thresholds.positive,
        negativeSpeechThreshold: thresholds.negative,
        minSpeechFrames: this.config?.minSpeechFrames || 3,
        
        // Callbacks
        onSpeechStart: () => {
          const now = Date.now();
          // Debounce rapid on/off transitions
          if (!this.isSpeaking && (now - this.lastSpeechTime) > this.speechDebounceMs) {
            this.isSpeaking = true;
            this.lastSpeechTime = now;
            this.continuousSpeechStartTime = now;
            this.speechStartCount++;
            
            // Monitor for quality issues
            if (this.lastSpeechStartTime > 0) {
              const timeSinceLastSpeech = now - this.lastSpeechStartTime;
              if (timeSinceLastSpeech < 1000) {
                // Rapid on/off might indicate threshold issues
                console.log('[VAD] Rapid speech detection, adjusting debounce');
                this.speechDebounceMs = Math.min(500, this.speechDebounceMs + 50);
              }
            }
            this.lastSpeechStartTime = now;
            
            this.onSpeechStartCallback?.();
            this.config?.onSpeechStart?.();
          }
        },
        
        onSpeechEnd: (audio) => {
          const now = Date.now();
          if (this.isSpeaking) {
            this.isSpeaking = false;
            this.lastSpeechTime = now;
            this.silenceStartTime = now;
            
            // Check for continuous speech (possible stuck detection)
            const speechDuration = now - this.continuousSpeechStartTime;
            if (speechDuration > 30000) { // 30 seconds continuous
              console.warn('[VAD] Long continuous speech detected, may need threshold adjustment');
              // Slightly increase thresholds if adaptive is enabled
              if (this.adaptiveEnabled) {
                this.basePositiveThreshold = Math.min(0.7, this.basePositiveThreshold + 0.05);
                this.baseNegativeThreshold = Math.min(0.5, this.baseNegativeThreshold + 0.05);
              }
            }
            
            this.onSpeechEndCallback?.();
            this.config?.onSpeechEnd?.();
          }
        },
        
        onVADMisfire: () => {
        },
        
        // Use newer v5 model for better accuracy
        model: 'v5',
      });

      this.isInitialized = true;
    } catch (error) {
      console.error('[VadService] Failed to initialize VAD:', error);
      throw error;
    }
  }

  async start(): Promise<void> {
    if (!this.vad) {
      throw new Error('VAD not initialized');
    }

    await this.vad.start();
  }

  pause(): void {
    if (!this.vad) {
      return;
    }

    this.vad.pause();
  }

  resume(): void {
    if (!this.vad) {
      return;
    }

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
    
    if (this.vad) {
      this.vad.pause();
      // Note: vad-web doesn't have a destroy method, so we just null the reference
      this.vad = null;
    }
    
    this.isInitialized = false;
    this.isSpeaking = false;
  }
  
  // Noise floor estimation methods
  private updateNoiseFloor(currentLevel: number): void {
    if (!this.adaptiveEnabled) return;
    
    // Track audio level samples
    this.audioLevelSamples.push(currentLevel);
    if (this.audioLevelSamples.length > this.LEVEL_SAMPLE_SIZE) {
      this.audioLevelSamples.shift();
    }
    
    // Update noise floor with dual time constants
    if (currentLevel < this.noiseFloor) {
      // Fast decay when signal is below noise floor
      this.noiseFloor *= (1 - this.NOISE_FLOOR_FALL);
    } else if (!this.isSpeaking && this.audioLevelSamples.length >= 10) {
      // Slow rise when not speaking and we have enough samples
      const medianLevel = this.getMedianLevel();
      if (medianLevel > this.noiseFloor) {
        this.noiseFloor += this.NOISE_FLOOR_RISE;
      }
    }
    
    // Clamp noise floor to reasonable bounds
    this.noiseFloor = Math.max(0.001, Math.min(0.5, this.noiseFloor));
  }
  
  private getMedianLevel(): number {
    const sorted = [...this.audioLevelSamples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  
  private getAdaptiveThresholds(): { positive: number; negative: number } {
    if (!this.adaptiveEnabled) {
      return {
        positive: this.basePositiveThreshold,
        negative: this.baseNegativeThreshold
      };
    }
    
    // Calculate SNR-based multiplier
    const snr = this.noiseFloor > 0 ? 1 / this.noiseFloor : 10;
    const snrDb = 20 * Math.log10(snr);
    
    // Adjust thresholds based on SNR (6dB minimum for reliable detection)
    let multiplier = 1.0;
    if (snrDb < 6) {
      multiplier = 1.5; // Increase thresholds in noisy environment
    } else if (snrDb > 20) {
      multiplier = 0.8; // Decrease thresholds in quiet environment
    } else {
      // Linear interpolation between 6dB and 20dB
      multiplier = 1.5 - (0.7 * (snrDb - 6) / 14);
    }
    
    // Apply multiplier with bounds
    const adaptivePositive = Math.max(0.3, Math.min(0.8, this.basePositiveThreshold * multiplier));
    const adaptiveNegative = Math.max(0.2, Math.min(0.6, this.baseNegativeThreshold * multiplier));
    
    return {
      positive: adaptivePositive,
      negative: adaptiveNegative
    };
  }
  
  // Public methods for monitoring
  getNoiseFloor(): number {
    return this.noiseFloor;
  }
  
  getAdaptiveEnabled(): boolean {
    return this.adaptiveEnabled;
  }
  
  setAdaptiveEnabled(enabled: boolean): void {
    this.adaptiveEnabled = enabled;
  }
  
  getCurrentThresholds(): { positive: number; negative: number } {
    return this.getAdaptiveThresholds();
  }
  
  // Called from audio service to update audio levels
  updateAudioLevel(level: number): void {
    if (!this.adaptiveEnabled) return;
    
    this.updateNoiseFloor(level);
    
    // Check for long silence (increase sensitivity)
    const now = Date.now();
    const silenceDuration = now - this.silenceStartTime;
    if (!this.isSpeaking && silenceDuration > 300000) { // 5 minutes
      // Gradually increase sensitivity
      this.basePositiveThreshold = Math.max(0.3, this.basePositiveThreshold - 0.01);
      this.baseNegativeThreshold = Math.max(0.2, this.baseNegativeThreshold - 0.01);
      this.silenceStartTime = now; // Reset timer
    }
    
    // Periodically update VAD thresholds if they've changed significantly
    if (this.vad && Math.random() < 0.01) { // Check 1% of the time
      const currentThresholds = this.getAdaptiveThresholds();
      // Note: @ricky0123/vad-web doesn't support dynamic threshold updates
      // We'll need to track this for future VAD library updates
    }
  }
  
  // Reset adaptive parameters (useful after role changes or errors)
  resetAdaptive(): void {
    this.noiseFloor = 0.1;
    this.audioLevelSamples = [];
    this.basePositiveThreshold = this.config?.positiveSpeechThreshold || 0.5;
    this.baseNegativeThreshold = this.config?.negativeSpeechThreshold || 0.35;
    this.speechDebounceMs = 300;
    this.silenceStartTime = Date.now();
  }
}