import { BaseVoiceStore } from '../store/base-voice';
import { RawOpusService } from './raw-opus-service';
import { VadService } from './vad-service';

interface AudioConfig {
  sampleRate: number;
  channels: number;
  frameDuration: number; // in ms
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

interface AudioPacket {
  sequenceNumber: number;
  timestamp: number;
  data: Float32Array;
}

class JitterBuffer {
  private buffer: Map<number, AudioPacket> = new Map();
  private targetDelay: number = 40; // 40ms target delay
  private currentDelay: number = 0;
  private lastPlayedSequence: number = -1;
  private firstSeenSequence: number | null = null; // Track the first sequence we see
  private audioContext: AudioContext | null = null;
  private scheduledSources: Map<AudioBufferSourceNode, { startTime: number; duration: number }> = new Map();
  private nextScheduledTime: number = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastSuccessfulPlayback: number = 0;
  private isScheduling: boolean = false;
  private stalledPacketCount: number = 0;
  private maxSequenceGap: number = 50; // Consider gaps larger than this as intentional jumps
  private hasPendingSchedule: boolean = false; // Track if we need to schedule when context resumes

  constructor(audioContext?: AudioContext) {
    this.audioContext = audioContext || null;
    if (audioContext) {
      this.nextScheduledTime = audioContext.currentTime;
    }
  }

  setAudioContext(audioContext: AudioContext): void {
    this.audioContext = audioContext;
    // Initialize next scheduled time to current audio context time
    this.nextScheduledTime = audioContext.currentTime;
  }

  getBufferSize(): number {
    return this.buffer.size;
  }
  
  // Method to trigger scheduling after context resume
  triggerScheduling(): void {
    if (this.hasPendingSchedule && this.buffer.size > 0 && !this.isScheduling) {
      this.hasPendingSchedule = false;
      this.schedulePlayback();
    }
  }
  
  private startHeartbeat(): void {
    // Check every 100ms to ensure continuous playback
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastPlayback = now - this.lastSuccessfulPlayback;
      
      if (this.buffer.size > 0 && timeSinceLastPlayback > 200 && !this.isScheduling) {
        this.stalledPacketCount++;
        
        if (this.stalledPacketCount > 10) {
          this.resetBufferState();
        } else {
          this.schedulePlayback();
        }
      }
    }, 100);
  }
  
  private resetBufferState(): void {
    this.stalledPacketCount = 0;
    this.isScheduling = false;
    
    // Clear any stuck sources
    for (const [source, info] of this.scheduledSources) {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // Already stopped
      }
    }
    this.scheduledSources.clear();
    
    // Reset scheduling time
    if (this.audioContext) {
      this.nextScheduledTime = this.audioContext.currentTime + (this.targetDelay / 1000);
    }
    
    // Reset sequence tracking
    this.firstSeenSequence = null;
    this.lastPlayedSequence = -1;
    
    // Force a scheduling attempt after reset
    if (this.buffer.size > 0) {
      setTimeout(() => this.schedulePlayback(), 10);
    }
  }

  push(packet: AudioPacket): void {
    // Track the first sequence we see
    if (this.firstSeenSequence === null) {
      this.firstSeenSequence = packet.sequenceNumber;
      this.lastPlayedSequence = packet.sequenceNumber - 1; // Set up for first packet
    }
    
    this.buffer.set(packet.sequenceNumber, packet);
    
    // Update last successful playback time to prevent false stalls
    this.lastSuccessfulPlayback = Date.now();
    


    // Clean up old packets (older than 1 second)
    const now = Date.now();
    const packetsToDelete: number[] = [];
    for (const [seq, pkt] of this.buffer) {
      if (now - pkt.timestamp > 1000) { // Remove packets older than 1s
        packetsToDelete.push(seq);
      }
    }
    
    if (packetsToDelete.length > 0) {
      for (const seq of packetsToDelete) {
        this.buffer.delete(seq);
      }
    }
    
    // Enforce maximum buffer size with FIFO eviction
    const maxBufferSize = 100; // Max 100 packets (2 seconds at 50 packets/sec)
    if (this.buffer.size > maxBufferSize) {
      const sortedSeqs = Array.from(this.buffer.keys()).sort((a, b) => a - b);
      const toRemove = sortedSeqs.slice(0, this.buffer.size - maxBufferSize);
      for (const seq of toRemove) {
        this.buffer.delete(seq);
      }
    }

    // Log actual buffer size after cleanup
    const actualBufferSize = this.buffer.size;
    
    // Ensure scheduling is running if we have packets
    if (this.audioContext && actualBufferSize >= 2) { // Wait for at least 2 packets
      
      // Try to schedule even if suspended - the audio will queue up
      if (this.audioContext.state === 'suspended') {
        this.hasPendingSchedule = true;
      }
      
      // Ensure scheduling is active
      if (!this.isScheduling) {
        this.schedulePlayback();
      } else {
      }
      // Ensure heartbeat is running
      if (!this.heartbeatInterval) {
        this.startHeartbeat();
      }
    } else {
    }
  }

  private schedulePlayback(): void {
    
    if (!this.audioContext) {
      return;
    }
    
    
    // Prevent concurrent scheduling
    if (this.isScheduling) {
      return;
    }
    
    this.isScheduling = true;

    try {
      const currentTime = this.audioContext.currentTime;
      
      // If we're behind current time, catch up
      // For suspended context, currentTime is 0, so add a small delay
      if (this.nextScheduledTime < currentTime || (currentTime === 0 && this.nextScheduledTime === 0)) {
        this.nextScheduledTime = currentTime + (this.targetDelay / 1000);
      }

      // Schedule packets while we have them and haven't scheduled too far ahead
      let packetsScheduled = 0;
      
      while (this.buffer.size > 0 && this.nextScheduledTime < currentTime + 0.5) { // Don't schedule more than 500ms ahead
        const packet = this.popNext();
        if (!packet) {
          break;
        }

        this.schedulePacket(packet);
        packetsScheduled++;
      }


      // Always schedule next check if we have packets or are expecting more
      if (this.buffer.size > 0 || packetsScheduled > 0) {
        // Schedule next check when our scheduled audio will be close to running out
        const timeUntilNextCheck = Math.max(10, (this.nextScheduledTime - currentTime - 0.1) * 1000);
        setTimeout(() => {
          this.isScheduling = false;
          this.schedulePlayback();
        }, timeUntilNextCheck);
      } else {
        this.isScheduling = false;
      }
    } catch (error) {
      this.isScheduling = false;
      
      // Retry scheduling after error
      if (this.buffer.size > 0) {
        setTimeout(() => this.schedulePlayback(), 50);
      }
    }
  }

  private schedulePacket(packet: AudioPacket): void {
    
    if (!this.audioContext) {
      return;
    }

    try {
      // Create audio buffer from packet data
      const audioBuffer = this.audioContext.createBuffer(
        1, // mono
        packet.data.length,
        this.audioContext.sampleRate
      );
      audioBuffer.copyToChannel(packet.data, 0);

      // Create and schedule source node
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);
      
      // Schedule to play at the next time slot
      source.start(this.nextScheduledTime);
      
      // Calculate when this source will end
      const duration = audioBuffer.duration;
      const endTime = this.nextScheduledTime + duration;
      
      // Track scheduled sources with timing info
      this.scheduledSources.set(source, {
        startTime: this.nextScheduledTime,
        duration: duration
      });
      
      // Clean up when ended
      source.onended = () => {
        this.scheduledSources.delete(source);
        // Disconnect to free resources
        try {
          source.disconnect();
        } catch (e) {
          // Already disconnected
        }
      };

      
      // Update successful playback time and reset stall counter
      this.lastSuccessfulPlayback = Date.now();
      this.stalledPacketCount = 0;

      // Update next scheduled time
      this.nextScheduledTime += duration;
      
      // Periodically clean up old sources that should have finished
      if (packet.sequenceNumber % 50 === 0) {
        this.cleanupOldSources();
      }

    } catch (error) {
    }
  }

  private cleanupOldSources(): void {
    if (!this.audioContext) return;
    
    const currentTime = this.audioContext.currentTime;
    const sourcesToClean: AudioBufferSourceNode[] = [];
    
    // Find sources that should have finished playing
    for (const [source, info] of this.scheduledSources) {
      const endTime = info.startTime + info.duration;
      // Add 100ms buffer to ensure playback has completed
      if (endTime + 0.1 < currentTime) {
        sourcesToClean.push(source);
      }
    }
    
    // Clean up old sources
    for (const source of sourcesToClean) {
      this.scheduledSources.delete(source);
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // Already stopped or disconnected
      }
    }
    
    if (sourcesToClean.length > 0) {
    }
  }

  private popNext(): AudioPacket | null {
    const nextSequence = this.lastPlayedSequence + 1;
    const packet = this.buffer.get(nextSequence);

    if (packet) {
      this.buffer.delete(nextSequence);
      this.lastPlayedSequence = nextSequence;
      return packet;
    }

    // Check for packet loss - play next available packet
    const sequences = Array.from(this.buffer.keys()).sort((a, b) => a - b);
    if (sequences.length > 0) {
      const nextAvailable = sequences[0];
      if (nextAvailable >= nextSequence) {
        const gap = nextAvailable - nextSequence;
        
        // If gap is large, assume it's an intentional sequence reset/jump
        if (gap > this.maxSequenceGap) {
          this.lastPlayedSequence = nextAvailable - 1;
          return this.popNext();
        } else if (gap > 0) {
          // Small gap - likely packet loss
          this.lastPlayedSequence = nextAvailable - 1;
          return this.popNext();
        }
      } else if (nextAvailable < nextSequence) {
        // Handle wraparound case (e.g., going from 4294967295 to 0)
        const MAX_U32 = 4294967295;
        const wrapGap = (MAX_U32 - nextSequence) + nextAvailable + 1;
        
        if (wrapGap <= this.maxSequenceGap) {
          // Normal wraparound
          this.lastPlayedSequence = nextAvailable - 1;
          return this.popNext();
        }
      }
    }

    return null;
  }

  // Legacy pop method - kept for compatibility but not used with audio scheduling
  pop(): AudioPacket | null {
    return this.popNext();
  }

  cleanup(): void {
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // Cancel all scheduled audio
    for (const [source, info] of this.scheduledSources) {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // Source may have already ended
      }
    }
    this.scheduledSources.clear();
    this.buffer.clear();
    this.isScheduling = false;
    this.stalledPacketCount = 0;
  }
}

export class AudioServiceV3 {
  private getStore: () => BaseVoiceStore;
  private config: AudioConfig;
  private sequenceNumber: number = 0;
  private opusService: RawOpusService | null = null;
  private vadService: VadService | null = null;
  private sampleRate: number = 48000;
  private hasLoggedAuthWait: boolean = false;
  private hasStartedRecording: boolean = false;
  private isVadActive: boolean = false;
  private lastSpeakingState: boolean = false;

  // Jitter buffers for incoming audio
  private jitterBuffers: Map<string, JitterBuffer> = new Map();

  // Audio playback
  private playbackContext: AudioContext | null = null;
  private wasPlayingBeforeHidden: boolean = false;
  private hasResumedOnUserGesture: boolean = false;
  
  // Cleanup interval
  private cleanupInterval: number | null = null;

  constructor(getStore: () => BaseVoiceStore) {
    this.getStore = getStore;
    this.config = {
      sampleRate: 48000,
      channels: 1,
      frameDuration: 20, // 20ms frames for low latency
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
    
    // Set up visibility change handler
    this.setupVisibilityHandler();
    
    // Set up periodic cleanup
    this.setupPeriodicCleanup();
  }
  
  // Public method to handle any user interaction
  async handleUserInteraction(): Promise<void> {
    if (!this.hasResumedOnUserGesture) {
      this.hasResumedOnUserGesture = true;
      await this.resumeAudioContexts();
    }
  }

  private setupVisibilityHandler(): void {
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }
  
  private setupPeriodicCleanup(): void {
    // Run cleanup every minute
    this.cleanupInterval = window.setInterval(() => {
      // Clean up any orphaned jitter buffers
      if (this.jitterBuffers.size > 2) {
        // Keep only the most recently used buffer
        const bufferKey = 'unified-mix';
        const keepBuffer = this.jitterBuffers.get(bufferKey);
        
        for (const [key, buffer] of this.jitterBuffers) {
          if (key !== bufferKey) {
            buffer.cleanup();
            this.jitterBuffers.delete(key);
          }
        }
      }
      
      // Force garbage collection hint (browser may ignore)
      if ('gc' in window && typeof (window as any).gc === 'function') {
        (window as any).gc();
      }
    }, 60000);
  }

  private handleVisibilityChange = (): void => {
    if (!this.playbackContext) return;

    if (document.hidden) {
      // Going to background
      this.wasPlayingBeforeHidden = this.playbackContext.state === 'running';
    } else {
      // Coming to foreground
      if (this.wasPlayingBeforeHidden && this.playbackContext.state === 'suspended') {
        this.playbackContext.resume().catch(error => {
        });
      }
    }
  };


  async initializeAudio(role: string, participantId: string, isHost: boolean, settings?: any): Promise<void> {
    
    // Initialize opus service only if it doesn't exist (needed for decoding)
    if (!this.opusService) {
      this.opusService = new RawOpusService();
      await this.opusService.initialize();
    } else {
    }
    
    // Always set up playback context early for all participants
    if (!this.playbackContext) {
      await this.setupAudioPlayback();
    }
    
    const canSpeak = ['Speaker', 'Admin'].includes(role);
    
    if (canSpeak) {
      // Reset recording flag when reinitializing for speakers
      this.hasStartedRecording = false;
      // Ensure any existing recorder is stopped first (important for role changes)
      if (this.opusService) {
        await this.opusService.stopRecording();
      }
      
      // Initialize VAD for speakers
      if (!this.vadService) {
        // Get threshold values based on sensitivity setting
        let posThreshold = 0.5;
        let negThreshold = 0.35;
        let enableAdaptive = true;
        
        if (settings) {
          enableAdaptive = settings.vadAdaptive !== false;
          if (!enableAdaptive) {
            // Use preset thresholds based on sensitivity setting
            switch (settings.vadSensitivity) {
              case 'Low':
              case 'low':
                posThreshold = 0.3;
                negThreshold = 0.2;
                break;
              case 'High':
              case 'high':
                posThreshold = 0.7;
                negThreshold = 0.5;
                break;
              case 'Medium':
              case 'medium':
              default:
                posThreshold = 0.5;
                negThreshold = 0.35;
            }
          }
        }
        
        this.vadService = new VadService({
          onSpeechStart: () => this.handleSpeechStart(),
          onSpeechEnd: () => this.handleSpeechEnd(),
          positiveSpeechThreshold: posThreshold,
          negativeSpeechThreshold: negThreshold,
          minSpeechFrames: 3,
          enableAdaptive: enableAdaptive
        });
        await this.vadService.initialize();
      }
      
      await this.setupAudioCapture();
    } else {
      // Always stop recording for non-speakers to clean up any recorder state
      if (this.opusService) {
        await this.opusService.stopRecording();
      }
      // Reset recording flag for non-speakers
      this.hasStartedRecording = false;
      
      // Clean up VAD for non-speakers
      if (this.vadService) {
        await this.vadService.cleanup();
        this.vadService = null;
      }
    }
    
    // Verify playback is set up
    if (!this.playbackContext) {
    } else {
      
      // Try to resume if suspended (this might fail without user gesture)
      if (this.playbackContext.state === 'suspended') {
        this.playbackContext.resume().then(() => {
        }).catch(error => {
        });
      }
    }
    
  }

  private async setupAudioCapture(): Promise<void> {
    try {

      if (!this.opusService) {
        throw new Error('Opus service not initialized');
      }
      
      // Set up audio level callback for VAD
      this.opusService.setOnAudioLevelCallback((level: number) => {
        if (this.vadService) {
          this.vadService.updateAudioLevel(level);
        }
      });
      
      // Set up callback for encoded data (safe to call multiple times)
      this.opusService.setOnDataCallback((data: Uint8Array) => {
        // Debug: Check data format
        if (data.length >= 4) {
          const first4 = Array.from(data.slice(0, 4));
          const isOgg = first4[0] === 79 && first4[1] === 103 && first4[2] === 103 && first4[3] === 83;
          if (isOgg) {
          }
        }
        
        // Always get fresh WebSocket from store
        const currentWs = this.getStore().wsConnection;
        
        // Debug log rarely
        if (this.sequenceNumber % 100 === 0) {
        }
        
        // Send encoded opus data to server only if VAD is active (speaking) or VAD is not enabled
        const shouldSend = currentWs && currentWs.readyState === WebSocket.OPEN && 
                          !this.getStore().isMuted && this.getStore().isAuthenticated &&
                          (this.isVadActive || !this.vadService);
                          
        if (shouldSend) {
          const message = {
            AudioData: {
              data: btoa(String.fromCharCode(...data)),
              sampleRate: this.sampleRate,
              channels: 1,
              sequence: this.sequenceNumber,
              timestamp: Date.now()
            }
          };
          
          currentWs.send(JSON.stringify(message));
          
          if (this.sequenceNumber % 100 === 0) {
          }
        } else {
          // Log why we're not sending audio (rarely)
          if (this.sequenceNumber % 100 === 0) {
          }
          
          if (!this.getStore().isAuthenticated && !this.hasLoggedAuthWait) {
            this.hasLoggedAuthWait = true;
          } else if (this.getStore().isAuthenticated && this.hasLoggedAuthWait) {
            this.hasLoggedAuthWait = false;
          }
        }
        
        this.sequenceNumber++;
      });

      // Don't start recording yet - wait for user gesture (unmute)
      // This avoids AudioContext autoplay policy issues
      
      // Apply initial mute state (we start muted)
      this.opusService.setMuted(this.getStore().isMuted);
      

    } catch (error) {
      throw error;
    }
  }


  private async setupAudioPlayback(): Promise<void> {
    try {
      this.playbackContext = new AudioContext({
        sampleRate: this.config.sampleRate,
        latencyHint: 'interactive'
      });
    } catch (error) {
      throw error;
    }

    // Audio contexts often start suspended, try to resume
    if (this.playbackContext.state === 'suspended') {
    }

  }

  private checkAudioLevels(samples: Float32Array): boolean {
    const hasAudio = samples.some(sample => Math.abs(sample) > 0.001);
    const maxLevel = Math.max(...samples.map(Math.abs));
    
    if (this.sequenceNumber % 10 === 0) {
    }
    
    return hasAudio;
  }

  async handleIncomingAudio(participantId: string, audioData: any): Promise<void> {
    // Log sequence numbers more frequently for debugging
    if (audioData.sequence !== undefined && (audioData.sequence % 10 === 0 || audioData.sequence < 5)) {
    }
    
    // Server now sends personalized mix-minus audio, so just play it
    const encodedBuffer = this.base64ToArrayBuffer(audioData.data);

    // Decode the Opus data
    const opusData = new Uint8Array(encodedBuffer);
    let float32Data: Float32Array;
    
    if (!this.opusService) {
      return;
    }
    
    try {
      // Use a unified decoder key since backend now sends all audio as "audio-stream"
      // This prevents decoder state issues when the stream ID doesn't change but the audio source does
      const decoderKey = 'unified-decoder';
      float32Data = await this.opusService.decode(opusData, decoderKey);
      
      // Check if we have actual audio
      const hasAudio = float32Data.some(sample => Math.abs(sample) > 0.001);
      if (!hasAudio) {
        // Only warn occasionally about silent audio
        if (Math.random() < 0.01) {
        }
      }
    } catch (error) {
      return;
    }

    const packet: AudioPacket = {
      sequenceNumber: audioData.sequence || 0,
      timestamp: Date.now(), // Use current time for cleanup tracking
      data: float32Data
    };
    
    if (!this.playbackContext) {
      // Try to create it now as a fallback
      try {
        await this.setupAudioPlayback();
      } catch (error) {
        return;
      }
    }

    // Use a single jitter buffer for all incoming audio (regardless of stream ID)
    // This handles role changes where stream ID changes from "mix-for-X" to "server-mix"
    const bufferKey = 'unified-mix';
    let jitterBuffer = this.jitterBuffers.get(bufferKey);
    if (!jitterBuffer) {
      jitterBuffer = new JitterBuffer(this.playbackContext || undefined);
      this.jitterBuffers.set(bufferKey, jitterBuffer);
      // Set audio context in case it wasn't available during construction
      if (this.playbackContext) {
        jitterBuffer.setAudioContext(this.playbackContext);
      }
    }

    jitterBuffer.push(packet);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }


  async toggleMute(muted: boolean): Promise<void> {
    
    // ALWAYS resume audio contexts on ANY user interaction (mute/unmute)
    // This is critical for Chrome autoplay policy
    await this.resumeAudioContexts();
    
    // Check if this is the first unmute for a speaker (user gesture)
    const canSpeak = ['Speaker', 'Admin'].includes(this.getStore().myRole || '');
    
    if (!muted && canSpeak && this.opusService && !this.hasStartedRecording) {
      // Start recording on first unmute (user gesture required for AudioContext)
      try {
        await this.opusService.startRecording();
        this.hasStartedRecording = true;
        
        // Start VAD after recording starts
        if (this.vadService) {
          await this.vadService.start();
        }
      } catch (error) {
      }
    }
    
    // Update opus service muting
    if (this.opusService) {
      this.opusService.setMuted(muted);
    }
    
    // Handle VAD pause/resume based on mute state
    if (this.vadService) {
      if (muted) {
        this.vadService.pause();
        // Reset VAD state when muted
        this.isVadActive = false;
        this.updateSpeakingState(false);
      } else if (this.hasStartedRecording) {
        this.vadService.resume();
      }
    }
  }

  private async resumeAudioContexts(): Promise<void> {

    if (this.playbackContext) {
      if (this.playbackContext.state === 'suspended') {
        try {
          await this.playbackContext.resume();
          
          // Force scheduling check after resume
          for (const [key, jitterBuffer] of this.jitterBuffers) {
            // This will trigger scheduling now that context is running
            jitterBuffer.triggerScheduling();
          }
        } catch (error) {
        }
      } else {
      }
    } else {
    }
  }

  getAudioLevel(): number {
    // Since we're not using analyser anymore, return 0
    return 0;
  }

  getMediaStream(): MediaStream | null {
    // RawOpusService handles the media stream internally
    return null;
  }

  private handleSpeechStart(): void {
    this.isVadActive = true;
    this.updateSpeakingState(true);
  }

  private handleSpeechEnd(): void {
    this.isVadActive = false;
    this.updateSpeakingState(false);
  }

  private updateSpeakingState(isSpeaking: boolean): void {
    // Only send update if state changed
    if (this.lastSpeakingState !== isSpeaking) {
      this.lastSpeakingState = isSpeaking;
      
      const ws = this.getStore().wsConnection;
      if (ws && ws.readyState === WebSocket.OPEN && this.getStore().isAuthenticated) {
        const message = {
          UpdateSpeakingState: {
            isSpeaking: isSpeaking
          }
        };
        
        ws.send(JSON.stringify(message));
      }
    }
  }

  clearDecoders(): void {
    if (this.opusService) {
      this.opusService.clearAllDecoders();
    }
  }

  updateVadSettings(settings: any): void {
    if (!this.vadService || !settings) return;
    
    // Update adaptive mode
    this.vadService.setAdaptiveEnabled(settings.vadAdaptive !== false);
    
    // If not adaptive, update thresholds based on sensitivity
    if (!settings.vadAdaptive) {
      // Reset the VAD to use new thresholds
      // Note: Current VAD library doesn't support dynamic threshold updates
      // so we'll need to reinitialize when thresholds change significantly
      console.log('[AudioService] VAD settings updated', settings);
    }
  }
  
  async cleanup(): Promise<void> {
    
    // Remove visibility handler
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    
    // Clear cleanup interval
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    // Stop opus service
    if (this.opusService) {
      await this.opusService.cleanup();
      this.opusService = null;
    }
    
    // Stop VAD service
    if (this.vadService) {
      await this.vadService.cleanup();
      this.vadService = null;
    }

    // Close audio contexts
    if (this.playbackContext) {
      await this.playbackContext.close();
      this.playbackContext = null;
    }

    // Clear buffers
    for (const [_, jitterBuffer] of this.jitterBuffers) {
      jitterBuffer.cleanup();
    }
    this.jitterBuffers.clear();
    
    // Reset recording flag
    this.hasStartedRecording = false;
    this.isVadActive = false;
  }
}