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
    console.log('[JitterBuffer] Constructor - audioContext:', audioContext, 
      'state:', audioContext?.state);
    if (audioContext) {
      this.nextScheduledTime = audioContext.currentTime;
    }
  }

  setAudioContext(audioContext: AudioContext): void {
    console.log('[JitterBuffer] setAudioContext called, context:', audioContext,
      'state:', audioContext?.state);
    this.audioContext = audioContext;
    // Initialize next scheduled time to current audio context time
    this.nextScheduledTime = audioContext.currentTime;
    console.log('[JitterBuffer] Set nextScheduledTime to:', this.nextScheduledTime);
  }

  getBufferSize(): number {
    return this.buffer.size;
  }
  
  // Method to trigger scheduling after context resume
  triggerScheduling(): void {
    console.log('[JitterBuffer] triggerScheduling called, hasPendingSchedule:', this.hasPendingSchedule,
      'buffer size:', this.buffer.size, 'isScheduling:', this.isScheduling);
    if (this.hasPendingSchedule && this.buffer.size > 0 && !this.isScheduling) {
      this.hasPendingSchedule = false;
      console.log('[JitterBuffer] Triggering deferred scheduling after context resume');
      this.schedulePlayback();
    }
  }
  
  private startHeartbeat(): void {
    console.log('[JitterBuffer] Starting heartbeat timer');
    // Check every 100ms to ensure continuous playback
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastPlayback = now - this.lastSuccessfulPlayback;
      
      if (this.buffer.size > 0 && timeSinceLastPlayback > 200 && !this.isScheduling) {
        console.log('[JitterBuffer] Heartbeat detected stalled playback, forcing schedule');
        console.log('[JitterBuffer] Heartbeat - buffer size:', this.buffer.size, 
          'timeSinceLastPlayback:', timeSinceLastPlayback,
          'isScheduling:', this.isScheduling,
          'audioContext state:', this.audioContext?.state);
        this.stalledPacketCount++;
        
        if (this.stalledPacketCount > 10) {
          console.warn('[JitterBuffer] Too many stalls, resetting buffer state');
          this.resetBufferState();
        } else {
          this.schedulePlayback();
        }
      }
    }, 100);
  }
  
  private resetBufferState(): void {
    console.log('[JitterBuffer] Resetting buffer state');
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
      console.log('[JitterBuffer] Have packets after reset, forcing schedule');
      setTimeout(() => this.schedulePlayback(), 10);
    }
  }

  push(packet: AudioPacket): void {
    // Track the first sequence we see
    if (this.firstSeenSequence === null) {
      this.firstSeenSequence = packet.sequenceNumber;
      this.lastPlayedSequence = packet.sequenceNumber - 1; // Set up for first packet
      console.log('[JitterBuffer] First packet received, sequence:', packet.sequenceNumber);
    }
    
    this.buffer.set(packet.sequenceNumber, packet);
    
    // Update last successful playback time to prevent false stalls
    this.lastSuccessfulPlayback = Date.now();
    
    // Enhanced debugging
    console.log('[JitterBuffer] push - audioContext:', this.audioContext, 
      'state:', this.audioContext?.state, 
      'buffer size:', this.buffer.size,
      'isScheduling:', this.isScheduling,
      'nextScheduledTime:', this.nextScheduledTime,
      'currentTime:', this.audioContext?.currentTime);

    // Debug: Log buffer state for first few packets
    if (packet.sequenceNumber < 5 || this.buffer.size % 50 === 0) {
      console.log('[JitterBuffer] Buffer size after push:', this.buffer.size, 'latest seq:', packet.sequenceNumber);
    }

    // Clean up old packets (older than 1 second)
    const now = Date.now();
    const packetsToDelete: number[] = [];
    for (const [seq, pkt] of this.buffer) {
      if (now - pkt.timestamp > 1000) { // Remove packets older than 1s
        packetsToDelete.push(seq);
      }
    }
    
    if (packetsToDelete.length > 0) {
      console.log('[JitterBuffer] Cleaning up old packets:', packetsToDelete);
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
        console.log('[JitterBuffer] FIFO eviction: removed old packet seq:', seq);
      }
    }

    // Log actual buffer size after cleanup
    const actualBufferSize = this.buffer.size;
    console.log('[JitterBuffer] After cleanup - buffer size:', actualBufferSize, 'seq:', packet.sequenceNumber);
    
    // Ensure scheduling is running if we have packets
    if (this.audioContext && actualBufferSize >= 2) { // Wait for at least 2 packets
      console.log('[JitterBuffer] Have enough packets, checking scheduling...');
      
      // Try to schedule even if suspended - the audio will queue up
      if (this.audioContext.state === 'suspended') {
        console.log('[JitterBuffer] Audio context is suspended, marking pending schedule');
        this.hasPendingSchedule = true;
      }
      
      console.log('[JitterBuffer] Audio context state:', this.audioContext.state);
      // Ensure scheduling is active
      if (!this.isScheduling) {
        console.log('[JitterBuffer] Starting playback scheduling (not currently scheduling)');
        this.schedulePlayback();
      } else {
        console.log('[JitterBuffer] Already scheduling, skipping');
      }
      // Ensure heartbeat is running
      if (!this.heartbeatInterval) {
        console.log('[JitterBuffer] Starting heartbeat');
        this.startHeartbeat();
      }
    } else {
      console.log('[JitterBuffer] Not ready to schedule - audioContext:', !!this.audioContext, 
        'buffer size:', actualBufferSize);
    }
  }

  private schedulePlayback(): void {
    console.log('[JitterBuffer] schedulePlayback - entering');
    
    if (!this.audioContext) {
      console.error('[JitterBuffer] No audio context available!');
      return;
    }
    
    console.log('[JitterBuffer] schedulePlayback - audioContext state:', this.audioContext.state);
    
    // Prevent concurrent scheduling
    if (this.isScheduling) {
      console.log('[JitterBuffer] Already scheduling, skipping concurrent call');
      return;
    }
    
    console.log('[JitterBuffer] Setting isScheduling = true');
    this.isScheduling = true;

    try {
      const currentTime = this.audioContext.currentTime;
      
      // If we're behind current time, catch up
      // For suspended context, currentTime is 0, so add a small delay
      if (this.nextScheduledTime < currentTime || (currentTime === 0 && this.nextScheduledTime === 0)) {
        this.nextScheduledTime = currentTime + (this.targetDelay / 1000);
        console.log('[JitterBuffer] Adjusted nextScheduledTime to:', this.nextScheduledTime);
      }

      // Schedule packets while we have them and haven't scheduled too far ahead
      let packetsScheduled = 0;
      console.log('[JitterBuffer] Starting packet scheduling loop, buffer size:', this.buffer.size);
      
      while (this.buffer.size > 0 && this.nextScheduledTime < currentTime + 0.5) { // Don't schedule more than 500ms ahead
        const packet = this.popNext();
        if (!packet) {
          console.log('[JitterBuffer] popNext returned null, breaking loop');
          break;
        }

        console.log('[JitterBuffer] Scheduling packet seq:', packet.sequenceNumber);
        this.schedulePacket(packet);
        packetsScheduled++;
      }

      console.log('[JitterBuffer] Scheduled', packetsScheduled, 'packets, buffer remaining:', this.buffer.size);

      // Always schedule next check if we have packets or are expecting more
      if (this.buffer.size > 0 || packetsScheduled > 0) {
        // Schedule next check when our scheduled audio will be close to running out
        const timeUntilNextCheck = Math.max(10, (this.nextScheduledTime - currentTime - 0.1) * 1000);
        console.log('[JitterBuffer] Scheduling next check in', timeUntilNextCheck, 'ms');
        setTimeout(() => {
          console.log('[JitterBuffer] Next check timer fired, setting isScheduling = false');
          this.isScheduling = false;
          this.schedulePlayback();
        }, timeUntilNextCheck);
      } else {
        console.log('[JitterBuffer] No packets to schedule, setting isScheduling = false');
        this.isScheduling = false;
      }
    } catch (error) {
      console.error('[JitterBuffer] Error in schedulePlayback:', error);
      this.isScheduling = false;
      
      // Retry scheduling after error
      if (this.buffer.size > 0) {
        console.log('[JitterBuffer] Retrying after scheduling error');
        setTimeout(() => this.schedulePlayback(), 50);
      }
    }
  }

  private schedulePacket(packet: AudioPacket): void {
    console.log('[JitterBuffer] schedulePacket - seq:', packet.sequenceNumber);
    
    if (!this.audioContext) {
      console.error('[JitterBuffer] No audio context in schedulePacket!');
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
      console.log('[JitterBuffer] Created audio buffer, duration:', audioBuffer.duration);

      // Create and schedule source node
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);
      console.log('[JitterBuffer] Created and connected AudioBufferSourceNode');
      
      // Schedule to play at the next time slot
      console.log('[JitterBuffer] Scheduling to start at:', this.nextScheduledTime, 
        'current time:', this.audioContext.currentTime);
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

      // Log scheduling for first few packets
      if (packet.sequenceNumber < 5 || packet.sequenceNumber % 100 === 0) {
        console.log('[JitterBuffer] Successfully scheduled packet seq:', packet.sequenceNumber, 
          'at time:', this.nextScheduledTime, 'duration:', audioBuffer.duration);
      }
      
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
      console.error('[JitterBuffer] Error scheduling packet:', error);
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
      console.log('[JitterBuffer] Cleaned up', sourcesToClean.length, 'old audio sources');
    }
  }

  private popNext(): AudioPacket | null {
    const nextSequence = this.lastPlayedSequence + 1;
    const packet = this.buffer.get(nextSequence);

    if (packet) {
      this.buffer.delete(nextSequence);
      this.lastPlayedSequence = nextSequence;
      console.log('[JitterBuffer] popNext - found packet seq:', nextSequence);
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
          console.log(`[JitterBuffer] Large sequence gap detected (${gap}), resetting to sequence ${nextAvailable}`);
          this.lastPlayedSequence = nextAvailable - 1;
          return this.popNext();
        } else if (gap > 0) {
          // Small gap - likely packet loss
          console.warn(`[JitterBuffer] Lost ${gap} audio packets, jumping from ${nextSequence} to ${nextAvailable}`);
          this.lastPlayedSequence = nextAvailable - 1;
          return this.popNext();
        }
      } else if (nextAvailable < nextSequence) {
        // Handle wraparound case (e.g., going from 4294967295 to 0)
        const MAX_U32 = 4294967295;
        const wrapGap = (MAX_U32 - nextSequence) + nextAvailable + 1;
        
        if (wrapGap <= this.maxSequenceGap) {
          // Normal wraparound
          console.log(`[JitterBuffer] Sequence wraparound detected, jumping from ${nextSequence} to ${nextAvailable}`);
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
    console.log('[AudioService] Constructor called');
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
    console.log('[AudioService] handleUserInteraction called');
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
        console.log('[AudioService] Running periodic cleanup, buffer count:', this.jitterBuffers.size);
        // Keep only the most recently used buffer
        const bufferKey = 'unified-mix';
        const keepBuffer = this.jitterBuffers.get(bufferKey);
        
        for (const [key, buffer] of this.jitterBuffers) {
          if (key !== bufferKey) {
            console.log('[AudioService] Cleaning up old jitter buffer:', key);
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
      console.log('[AudioService] Tab hidden, audio context state:', this.playbackContext.state);
    } else {
      // Coming to foreground
      if (this.wasPlayingBeforeHidden && this.playbackContext.state === 'suspended') {
        console.log('[AudioService] Tab visible again, resuming audio context');
        this.playbackContext.resume().catch(error => {
          console.error('[AudioService] Failed to resume audio context on visibility change:', error);
        });
      }
    }
  };


  async initializeAudio(role: string, participantId: string, isHost: boolean): Promise<void> {
    console.log('[AudioService] Initializing audio:', { role, participantId, hasOpusService: !!this.opusService });
    
    // Initialize opus service only if it doesn't exist (needed for decoding)
    if (!this.opusService) {
      console.log('[AudioService] Creating new opus service');
      this.opusService = new RawOpusService();
      await this.opusService.initialize();
      console.log('[AudioService] Using service:', this.opusService?.constructor.name);
    } else {
      console.log('[AudioService] Opus service already exists, type:', this.opusService?.constructor.name);
    }
    
    // Always set up playback context early for all participants
    if (!this.playbackContext) {
      console.log('[AudioService] Setting up audio playback early');
      await this.setupAudioPlayback();
    }
    
    const canSpeak = ['Speaker', 'Admin'].includes(role);
    
    if (canSpeak) {
      console.log('[AudioService] User can speak, setting up audio capture');
      // Reset recording flag when reinitializing for speakers
      this.hasStartedRecording = false;
      // Ensure any existing recorder is stopped first (important for role changes)
      if (this.opusService) {
        await this.opusService.stopRecording();
      }
      
      // Initialize VAD for speakers
      if (!this.vadService) {
        console.log('[AudioService] Creating VAD service');
        this.vadService = new VadService({
          onSpeechStart: () => this.handleSpeechStart(),
          onSpeechEnd: () => this.handleSpeechEnd(),
          positiveSpeechThreshold: 0.5,
          negativeSpeechThreshold: 0.35,
          minSpeechFrames: 3
        });
        await this.vadService.initialize();
      }
      
      await this.setupAudioCapture();
    } else {
      console.log('[AudioService] User cannot speak (role:', role, ')');
      // Always stop recording for non-speakers to clean up any recorder state
      if (this.opusService) {
        console.log('[AudioService] Ensuring recording is stopped for non-speaker');
        await this.opusService.stopRecording();
      }
      // Reset recording flag for non-speakers
      this.hasStartedRecording = false;
      
      // Clean up VAD for non-speakers
      if (this.vadService) {
        console.log('[AudioService] Cleaning up VAD for non-speaker');
        await this.vadService.cleanup();
        this.vadService = null;
      }
    }
    
    // Verify playback is set up
    if (!this.playbackContext) {
      console.error('[AudioService] Playback context still not initialized after setup!');
    } else {
      console.log('[AudioService] Playback context ready, state:', this.playbackContext.state);
      
      // Try to resume if suspended (this might fail without user gesture)
      if (this.playbackContext.state === 'suspended') {
        console.log('[AudioService] Attempting early resume of suspended context');
        this.playbackContext.resume().then(() => {
          console.log('[AudioService] Early resume successful');
        }).catch(error => {
          console.log('[AudioService] Early resume failed (expected without user gesture):', error.message);
        });
      }
    }
    
    console.log('[AudioService] Audio initialization complete');
  }

  private async setupAudioCapture(): Promise<void> {
    try {
      console.log('[AudioService] Setting up audio capture');

      if (!this.opusService) {
        throw new Error('Opus service not initialized');
      }
      
      // Set up callback for encoded data (safe to call multiple times)
      this.opusService.setOnDataCallback((data: Uint8Array) => {
        // Debug: Check data format
        if (data.length >= 4) {
          const first4 = Array.from(data.slice(0, 4));
          const isOgg = first4[0] === 79 && first4[1] === 103 && first4[2] === 103 && first4[3] === 83;
          if (isOgg) {
            console.error('[AudioService] ERROR: Sending Ogg data to backend!');
          }
        }
        
        // Always get fresh WebSocket from store
        const currentWs = this.getStore().wsConnection;
        
        // Debug log rarely
        if (this.sequenceNumber % 100 === 0) {
          console.log('[AudioService] Data callback - ws:', !!currentWs, 'wsState:', currentWs?.readyState, 
            'muted:', this.getStore().isMuted, 'auth:', this.getStore().isAuthenticated);
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
            console.log('[AudioService] Sent opus data, size:', data.length, 'seq:', this.sequenceNumber, 'VAD active:', this.isVadActive);
          }
        } else {
          // Log why we're not sending audio (rarely)
          if (this.sequenceNumber % 100 === 0) {
            console.log('[AudioService] Not sending audio - ws:', !!currentWs, 
              'wsState:', currentWs?.readyState, 
              'muted:', this.getStore().isMuted, 
              'authenticated:', this.getStore().isAuthenticated);
          }
          
          if (!this.getStore().isAuthenticated && !this.hasLoggedAuthWait) {
            console.log('[AudioService] Waiting for authentication before sending audio...');
            this.hasLoggedAuthWait = true;
          } else if (this.getStore().isAuthenticated && this.hasLoggedAuthWait) {
            console.log('[AudioService] Authentication complete, ready to send audio when unmuted');
            this.hasLoggedAuthWait = false;
          }
        }
        
        this.sequenceNumber++;
      });

      // Don't start recording yet - wait for user gesture (unmute)
      // This avoids AudioContext autoplay policy issues
      console.log('[AudioService] Audio capture setup complete, waiting for user gesture to start recording');
      
      // Apply initial mute state (we start muted)
      this.opusService.setMuted(this.getStore().isMuted);
      
      console.log('[AudioService] Audio capture setup complete, initial mute state:', this.getStore().isMuted);

    } catch (error) {
      console.error('[AudioService] Failed to setup audio capture:', error);
      throw error;
    }
  }


  private async setupAudioPlayback(): Promise<void> {
    console.log('[AudioService] Setting up audio playback context');
    try {
      this.playbackContext = new AudioContext({
        sampleRate: this.config.sampleRate,
        latencyHint: 'interactive'
      });
      console.log('[AudioService] Created AudioContext successfully');
    } catch (error) {
      console.error('[AudioService] Failed to create AudioContext:', error);
      throw error;
    }

    // Audio contexts often start suspended, try to resume
    if (this.playbackContext.state === 'suspended') {
      console.log('[AudioService] Audio context is suspended, will resume on user interaction');
    }

    console.log('[AudioService] Playback context state:', this.playbackContext.state,
      'sampleRate:', this.playbackContext.sampleRate,
      'currentTime:', this.playbackContext.currentTime);
  }

  private checkAudioLevels(samples: Float32Array): boolean {
    const hasAudio = samples.some(sample => Math.abs(sample) > 0.001);
    const maxLevel = Math.max(...samples.map(Math.abs));
    
    if (this.sequenceNumber % 10 === 0) {
      console.log('[AudioService] Audio level check - hasAudio:', hasAudio, 'maxLevel:', maxLevel, 'samples:', samples.length);
    }
    
    return hasAudio;
  }

  async handleIncomingAudio(participantId: string, audioData: any): Promise<void> {
    // Log sequence numbers more frequently for debugging
    if (audioData.sequence !== undefined && (audioData.sequence % 10 === 0 || audioData.sequence < 5)) {
      console.log('[AudioService] Received audio seq:', audioData.sequence,
                  'from:', participantId, 'timestamp:', audioData.timestamp,
                  'playbackContext state:', this.playbackContext?.state);
    }
    
    // Server now sends personalized mix-minus audio, so just play it
    const encodedBuffer = this.base64ToArrayBuffer(audioData.data);

    // Decode the Opus data
    const opusData = new Uint8Array(encodedBuffer);
    let float32Data: Float32Array;
    
    if (!this.opusService) {
      console.error('[AudioService] Opus service not available');
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
          console.warn('[AudioService] Decoded audio appears to be silent from', participantId, 'using decoder:', decoderKey);
        }
      }
    } catch (error) {
      console.error('[AudioService] Failed to decode audio from', participantId, ':', error);
      return;
    }

    const packet: AudioPacket = {
      sequenceNumber: audioData.sequence || 0,
      timestamp: Date.now(), // Use current time for cleanup tracking
      data: float32Data
    };
    
    if (!this.playbackContext) {
      console.error('[AudioService] Playback context not initialized! Creating now...');
      // Try to create it now as a fallback
      try {
        await this.setupAudioPlayback();
      } catch (error) {
        console.error('[AudioService] Failed to create playback context:', error);
        return;
      }
    }

    // Use a single jitter buffer for all incoming audio (regardless of stream ID)
    // This handles role changes where stream ID changes from "mix-for-X" to "server-mix"
    const bufferKey = 'unified-mix';
    let jitterBuffer = this.jitterBuffers.get(bufferKey);
    if (!jitterBuffer) {
      console.log('[AudioService] Creating unified jitter buffer for all incoming audio');
      console.log('[AudioService] Passing AudioContext to JitterBuffer:', this.playbackContext,
        'state:', this.playbackContext?.state);
      jitterBuffer = new JitterBuffer(this.playbackContext || undefined);
      this.jitterBuffers.set(bufferKey, jitterBuffer);
      // Set audio context in case it wasn't available during construction
      if (this.playbackContext) {
        jitterBuffer.setAudioContext(this.playbackContext);
      }
    }

    console.log('[AudioService] Pushing packet to jitter buffer, seq:', packet.sequenceNumber);
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
    console.log('[AudioService] Toggling mute to:', muted, 'store.isMuted:', this.getStore().isMuted, 'store.isAuthenticated:', this.getStore().isAuthenticated);
    
    // ALWAYS resume audio contexts on ANY user interaction (mute/unmute)
    // This is critical for Chrome autoplay policy
    console.log('[AudioService] User interaction detected (mute toggle), resuming audio contexts');
    await this.resumeAudioContexts();
    
    // Check if this is the first unmute for a speaker (user gesture)
    const canSpeak = ['Speaker', 'Admin'].includes(this.getStore().myRole || '');
    
    if (!muted && canSpeak && this.opusService && !this.hasStartedRecording) {
      // Start recording on first unmute (user gesture required for AudioContext)
      console.log('[AudioService] First unmute detected, starting recording with user gesture');
      try {
        await this.opusService.startRecording();
        this.hasStartedRecording = true;
        console.log('[AudioService] Recording started successfully');
        
        // Start VAD after recording starts
        if (this.vadService) {
          await this.vadService.start();
          console.log('[AudioService] VAD started');
        }
      } catch (error) {
        console.error('[AudioService] Failed to start recording:', error);
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
    console.log('[AudioService] Resuming audio contexts on user interaction');

    if (this.playbackContext) {
      console.log('[AudioService] Playback context state before resume:', this.playbackContext.state);
      if (this.playbackContext.state === 'suspended') {
        try {
          await this.playbackContext.resume();
          console.log('[AudioService] Resumed playback context, state:', this.playbackContext.state);
          
          // Force scheduling check after resume
          for (const [key, jitterBuffer] of this.jitterBuffers) {
            console.log('[AudioService] Triggering scheduling for buffer:', key, 'after context resume');
            // This will trigger scheduling now that context is running
            jitterBuffer.triggerScheduling();
          }
        } catch (error) {
          console.error('[AudioService] Failed to resume playback context:', error);
        }
      } else {
        console.log('[AudioService] Playback context already running');
      }
    } else {
      console.error('[AudioService] No playback context to resume!');
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
    console.log('[AudioService] Speech started (VAD)');
    this.isVadActive = true;
    this.updateSpeakingState(true);
  }

  private handleSpeechEnd(): void {
    console.log('[AudioService] Speech ended (VAD)');
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
        console.log('[AudioService] Sent speaking state update:', isSpeaking);
      }
    }
  }

  clearDecoders(): void {
    if (this.opusService) {
      console.log('[AudioService] Clearing all decoders');
      this.opusService.clearAllDecoders();
    }
  }

  async cleanup(): Promise<void> {
    console.log('[AudioService] Cleaning up');
    
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