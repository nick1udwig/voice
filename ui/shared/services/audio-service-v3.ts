import { BaseVoiceStore } from '../store/base-voice';
import { ContinuousOpusService } from './continuous-opus-service';

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

  getBufferSize(): number {
    return this.buffer.size;
  }

  push(packet: AudioPacket): void {
    this.buffer.set(packet.sequenceNumber, packet);

    // Debug: Log buffer state occasionally
    if (this.buffer.size % 10 === 0) {
      console.log('[JitterBuffer] Buffer size:', this.buffer.size, 'latest seq:', packet.sequenceNumber);
    }

    // Clean up old packets
    const now = Date.now();
    for (const [seq, pkt] of this.buffer) {
      if (now - pkt.timestamp > 1000) { // Remove packets older than 1s
        this.buffer.delete(seq);
      }
    }
  }

  pop(): AudioPacket | null {
    const nextSequence = this.lastPlayedSequence + 1;
    const packet = this.buffer.get(nextSequence);

    if (packet) {
      this.buffer.delete(nextSequence);
      this.lastPlayedSequence = nextSequence;
      // Log successful pop occasionally
      if (nextSequence % 50 === 0) {
        console.log('[JitterBuffer] Popped packet seq:', nextSequence, 'buffer size:', this.buffer.size);
      }
      return packet;
    }

    // Check for packet loss - play next available packet
    const sequences = Array.from(this.buffer.keys()).sort((a, b) => a - b);
    if (sequences.length > 0) {
      if (sequences[0] >= nextSequence) {
        if (sequences[0] > nextSequence) {
          const lostPackets = sequences[0] - nextSequence;
          console.warn(`[JitterBuffer] Lost ${lostPackets} audio packets, jumping from ${nextSequence} to ${sequences[0]}`);
        }
        this.lastPlayedSequence = sequences[0] - 1;
        return this.pop();
      }
      // Debug: we have packets but they're all old
      console.log('[JitterBuffer] Have packets but all are old. Expected seq:', nextSequence, 'available:', sequences.slice(0, 5));
    }

    return null;
  }
}

export class AudioServiceV3 {
  private getStore: () => BaseVoiceStore;
  private config: AudioConfig;
  private sequenceNumber: number = 0;
  private opusService: ContinuousOpusService | null = null;
  private sampleRate: number = 48000;
  private hasLoggedAuthWait: boolean = false;
  private hasStartedRecording: boolean = false;

  // Jitter buffers for incoming audio
  private jitterBuffers: Map<string, JitterBuffer> = new Map();

  // Audio playback
  private playbackContext: AudioContext | null = null;
  private playbackSources: Map<string, AudioBufferSourceNode> = new Map();
  private nextPlayTime: Map<string, number> = new Map(); // Track when to play next audio

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
  }


  async initializeAudio(role: string, participantId: string, isHost: boolean): Promise<void> {
    console.log('[AudioService] Initializing audio:', { role, participantId, hasOpusService: !!this.opusService });
    
    // Initialize opus service only if it doesn't exist (needed for decoding)
    if (!this.opusService) {
      console.log('[AudioService] Creating new opus service');
      this.opusService = new ContinuousOpusService();
      await this.opusService.initialize();
    } else {
      console.log('[AudioService] Opus service already exists');
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
    }
    
    // Set up playback only if not already set up
    if (!this.playbackContext) {
      console.log('[AudioService] Setting up audio playback');
      await this.setupAudioPlayback();
    } else {
      console.log('[AudioService] Playback already set up');
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
        // Always get fresh WebSocket from store
        const currentWs = this.getStore().wsConnection;
        
        // Debug log every 10th callback
        if (this.sequenceNumber % 10 === 0) {
          console.log('[AudioService] Data callback - ws:', !!currentWs, 'wsState:', currentWs?.readyState, 
            'muted:', this.getStore().isMuted, 'auth:', this.getStore().isAuthenticated);
        }
        
        // Send encoded opus data to server
        if (currentWs && currentWs.readyState === WebSocket.OPEN && !this.getStore().isMuted && this.getStore().isAuthenticated) {
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
          
          if (this.sequenceNumber % 10 === 0) {
            console.log('[AudioService] Sent opus data, size:', data.length, 'seq:', this.sequenceNumber);
          }
        } else {
          // Log why we're not sending audio
          if (this.sequenceNumber % 10 === 0) {
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
    this.playbackContext = new AudioContext({
      sampleRate: this.config.sampleRate,
      latencyHint: 'interactive'
    });

    // Audio contexts often start suspended, try to resume
    if (this.playbackContext.state === 'suspended') {
      console.log('[AudioService] Audio context is suspended, will resume on user interaction');
    }

    console.log('[AudioService] Playback context state:', this.playbackContext.state);
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
    // Server now sends personalized mix-minus audio, so just play it
    console.log('[AudioService] Receiving mix-minus audio from participant:', participantId);
    const encodedBuffer = this.base64ToArrayBuffer(audioData.data);

    // Decode the Opus data
    const opusData = new Uint8Array(encodedBuffer);
    let float32Data: Float32Array;
    
    if (!this.opusService) {
      console.error('[AudioService] Opus service not available');
      return;
    }
    
    try {
      // Use the stream ID from the server (which identifies this specific mix)
      float32Data = await this.opusService.decode(opusData, participantId);
      console.log('[AudioService] Decoded audio for stream', participantId, ':', opusData.length, 'bytes to', float32Data.length, 'samples');
      
      // Check if we have actual audio
      const hasAudio = float32Data.some(sample => Math.abs(sample) > 0.001);
      if (!hasAudio) {
        console.warn('[AudioService] Decoded audio appears to be silent from', participantId);
      }
    } catch (error) {
      console.error('[AudioService] Failed to decode audio from', participantId, ':', error);
      return;
    }

    const packet: AudioPacket = {
      sequenceNumber: audioData.sequence || 0,
      timestamp: audioData.timestamp || Date.now(),
      data: float32Data
    };
    
    if (!this.playbackContext) {
      console.error('[AudioService] Playback context not initialized!');
      return;
    }

    // Use a single jitter buffer for all incoming audio (regardless of stream ID)
    // This handles role changes where stream ID changes from "mix-for-X" to "server-mix"
    const bufferKey = 'unified-mix';
    let jitterBuffer = this.jitterBuffers.get(bufferKey);
    if (!jitterBuffer) {
      console.log('[AudioService] Creating unified jitter buffer for all incoming audio');
      jitterBuffer = new JitterBuffer();
      this.jitterBuffers.set(bufferKey, jitterBuffer);
      this.startPlaybackLoop(bufferKey);
    }

    jitterBuffer.push(packet);
    console.log('[AudioService] Pushed packet to jitter buffer from stream:', participantId, 'buffer size:', jitterBuffer.getBufferSize());
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  private startPlaybackLoop(participantId: string): void {
    console.log('[AudioService] Starting playback loop for:', participantId);

    let loopCount = 0;
    let lastPlayTime = Date.now();
    const playNext = () => {
      const now = Date.now();
      const actualInterval = now - lastPlayTime;
      if (loopCount % 50 === 0) { // Log every 50 frames (1 second at 20ms frames)
        const jitterBuffer = this.jitterBuffers.get(participantId);
        const bufferSize = jitterBuffer ? jitterBuffer.getBufferSize() : 0;
        console.log('[AudioService] Playback loop:', participantId,
          'iteration:', loopCount,
          'interval:', actualInterval, 'ms',
          'buffer size:', bufferSize);
      }
      loopCount++;
      lastPlayTime = now;
      this.playBufferedAudio(participantId);
      setTimeout(playNext, this.config.frameDuration);
    };
    playNext();
  }

  private playBufferedAudio(participantId: string): void {
    if (!this.playbackContext) {
      console.error('[AudioService] No playback context available');
      return;
    }

    const jitterBuffer = this.jitterBuffers.get(participantId);
    if (!jitterBuffer) {
      console.error('[AudioService] No jitter buffer for:', participantId);
      return;
    }

    const packet = jitterBuffer.pop();
    if (!packet) {
      // No packet available - log occasionally to see if we're starved
      if (Math.random() < 0.02) { // 2% chance to log
        console.log('[AudioService] No packet in jitter buffer for:', participantId);
      }
      return;
    }

    try {
      // Use float32 data directly
      const float32Data = packet.data;

      // Check if we have any non-zero samples
      const hasAudio = float32Data.some(sample => Math.abs(sample) > 0.001);
      const maxAmplitude = Math.max(...float32Data.map(Math.abs));
      const expectedSamples = Math.floor(this.config.sampleRate * this.config.frameDuration / 1000);
      if (packet.sequenceNumber % 10 === 0) {
        console.log('[AudioService] Playing packet seq:', packet.sequenceNumber,
          'samples:', float32Data.length,
          'expected:', expectedSamples,
          'hasAudio:', hasAudio,
          'maxAmplitude:', maxAmplitude);
      }

      const audioBuffer = this.playbackContext.createBuffer(
        1,
        float32Data.length,
        this.config.sampleRate
      );
      audioBuffer.copyToChannel(float32Data, 0);

      // Get current audio context time
      const currentTime = this.playbackContext.currentTime;

      // Get or initialize next play time for this participant
      let nextTime = this.nextPlayTime.get(participantId) || currentTime;
      if (nextTime < currentTime) {
        nextTime = currentTime;
      }

      // Schedule the audio to play at the exact next time
      const source = this.playbackContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.playbackContext.destination);
      source.start(nextTime);

      // Update next play time (duration in seconds)
      const duration = audioBuffer.duration;
      this.nextPlayTime.set(participantId, nextTime + duration);

      if (packet.sequenceNumber % 10 === 0) {
        console.log('[AudioService] Scheduled playback at:', nextTime, 'duration:', duration);
      }
    } catch (error) {
      console.error('[AudioService] Error playing audio:', error);
    }
  }

  async toggleMute(muted: boolean): Promise<void> {
    console.log('[AudioService] Toggling mute to:', muted, 'store.isMuted:', this.getStore().isMuted, 'store.isAuthenticated:', this.getStore().isAuthenticated);
    
    // Check if this is the first unmute for a speaker (user gesture)
    const canSpeak = ['Speaker', 'Admin'].includes(this.getStore().myRole || '');
    
    if (!muted && canSpeak && this.opusService && !this.hasStartedRecording) {
      // Start recording on first unmute (user gesture required for AudioContext)
      console.log('[AudioService] First unmute detected, starting recording with user gesture');
      try {
        await this.opusService.startRecording();
        this.hasStartedRecording = true;
        console.log('[AudioService] Recording started successfully');
      } catch (error) {
        console.error('[AudioService] Failed to start recording:', error);
      }
    }
    
    // Update opus service muting
    if (this.opusService) {
      this.opusService.setMuted(muted);
    }

    // Resume audio contexts on user interaction
    await this.resumeAudioContexts();
  }

  private async resumeAudioContexts(): Promise<void> {
    console.log('[AudioService] Resuming audio contexts on user interaction');

    if (this.playbackContext && this.playbackContext.state === 'suspended') {
      try {
        await this.playbackContext.resume();
        console.log('[AudioService] Resumed playback context, state:', this.playbackContext.state);
      } catch (error) {
        console.error('[AudioService] Failed to resume playback context:', error);
      }
    }
  }

  getAudioLevel(): number {
    // Since we're not using analyser anymore, return 0
    return 0;
  }

  getMediaStream(): MediaStream | null {
    // opus-recorder handles the media stream internally
    return null;
  }

  async cleanup(): Promise<void> {
    console.log('[AudioService] Cleaning up');
    
    // Stop opus service
    if (this.opusService) {
      await this.opusService.cleanup();
      this.opusService = null;
    }

    // Close audio contexts
    if (this.playbackContext) {
      await this.playbackContext.close();
    }

    // Clear buffers
    this.jitterBuffers.clear();
    
    // Reset recording flag
    this.hasStartedRecording = false;
  }
}