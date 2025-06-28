import { BaseVoiceStore } from '../store/base-voice';

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
  data: ArrayBuffer;
}

class JitterBuffer {
  private buffer: Map<number, AudioPacket> = new Map();
  private targetDelay: number = 40; // 40ms target delay
  private currentDelay: number = 0;
  private lastPlayedSequence: number = -1;
  
  push(packet: AudioPacket): void {
    this.buffer.set(packet.sequenceNumber, packet);
    
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
      return packet;
    }
    
    // Check for packet loss - play next available packet
    const sequences = Array.from(this.buffer.keys()).sort((a, b) => a - b);
    if (sequences.length > 0 && sequences[0] > nextSequence) {
      const lostPackets = sequences[0] - nextSequence;
      console.warn(`Lost ${lostPackets} audio packets`);
      this.lastPlayedSequence = sequences[0] - 1;
      return this.pop();
    }
    
    return null;
  }
}

export class AudioServiceV2 {
  private getStore: () => BaseVoiceStore;
  private config: AudioConfig;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private audioWorkletNode: AudioWorkletNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private isHost: boolean = false;
  private sequenceNumber: number = 0;
  
  // Audio mixing (for host)
  private mixerContext: AudioContext | null = null;
  private mixerDestination: MediaStreamAudioDestinationNode | null = null;
  private participantGains: Map<string, GainNode> = new Map();
  private participantSources: Map<string, MediaStreamAudioSourceNode> = new Map();
  
  // Jitter buffers for incoming audio
  private jitterBuffers: Map<string, JitterBuffer> = new Map();
  
  // Audio playback
  private playbackContext: AudioContext | null = null;
  private playbackSources: Map<string, AudioBufferSourceNode> = new Map();
  
  constructor(getStore: () => BaseVoiceStore) {
    this.getStore = getStore;
    console.log('[AudioService] Constructor called, testing getStore:', getStore && getStore());
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
    console.log('[AudioService] Initializing audio:', { role, participantId, isHost });
    this.isHost = isHost;
    const canSpeak = ['Speaker', 'Admin'].includes(role);
    
    if (canSpeak) {
      console.log('[AudioService] User can speak, setting up audio capture');
      await this.setupAudioCapture();
    } else {
      console.log('[AudioService] User cannot speak (role:', role, ')');
    }
    
    if (isHost) {
      console.log('[AudioService] Setting up audio mixer (host)');
      await this.setupAudioMixer();
    } else {
      console.log('[AudioService] Setting up audio playback (participant)');
      await this.setupAudioPlayback();
    }
  }
  
  private async setupAudioCapture(): Promise<void> {
    try {
      console.log('[AudioService] Requesting microphone permission...');
      // Request microphone permission
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: this.config.echoCancellation,
          noiseSuppression: this.config.noiseSuppression,
          autoGainControl: this.config.autoGainControl,
          sampleRate: this.config.sampleRate,
          channelCount: this.config.channels,
        },
        video: false
      });
      
      console.log('[AudioService] Microphone permission granted, tracks:', this.mediaStream.getTracks());
      // Note: We can't directly update the store from here anymore
      // The component using this service should handle the stream
      
      // Start with muted state
      this.mediaStream.getAudioTracks().forEach(track => {
        track.enabled = false;
        console.log('[AudioService] Audio track initially muted:', track.label);
      });
      
      // Setup audio processing
      this.audioContext = new AudioContext({ 
        sampleRate: this.config.sampleRate,
        latencyHint: 'interactive'
      });
      console.log('[AudioService] Audio context created, state:', this.audioContext.state);
      
      // Load audio worklet for processing
      try {
        // Get base URL from environment
        const BASE_URL = import.meta.env.BASE_URL || '';
        const workletPath = `${BASE_URL}/audio-processor.js`;
        console.log('[AudioService] Loading audio worklet from:', workletPath);
        await this.audioContext.audioWorklet.addModule(workletPath);
        console.log('[AudioService] Audio worklet loaded successfully');
      } catch (workletError) {
        console.error('[AudioService] Failed to load audio worklet:', workletError);
        // Fallback to ScriptProcessorNode
        return this.setupFallbackAudioCapture();
      }
      
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'audio-processor', {
        processorOptions: {
          frameDuration: this.config.frameDuration,
          sampleRate: this.config.sampleRate
        }
      });
      
      // Create analyser for visualizations
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.8;
      
      // Connect audio graph
      source.connect(this.analyserNode);
      this.analyserNode.connect(this.audioWorkletNode);
      
      // Handle processed audio frames
      this.audioWorkletNode.port.onmessage = (event) => {
        // Get fresh state
        const currentStore = this.getStore();
        const currentMuted = currentStore.isMuted;
        console.log('[AudioService] Received audio frame from worklet, isMuted:', currentMuted, 'type:', typeof currentMuted);
        if (event.data.type === 'audio-frame' && !currentMuted) {
          this.sendAudioFrame(event.data.buffer);
        }
      };
      
      console.log('[AudioService] Audio capture setup complete');
      
    } catch (error) {
      console.error('[AudioService] Failed to setup audio capture:', error);
      throw error;
    }
  }
  
  private async setupAudioMixer(): Promise<void> {
    this.mixerContext = new AudioContext({ 
      sampleRate: this.config.sampleRate,
      latencyHint: 'interactive'
    });
    
    this.mixerDestination = this.mixerContext.createMediaStreamDestination();
    
    // Setup a worklet for mixing if needed
    try {
      const BASE_URL = import.meta.env.BASE_URL || '';
      const mixerPath = `${BASE_URL}/audio-mixer.js`;
      await this.mixerContext.audioWorklet.addModule(mixerPath);
    } catch (error) {
      console.error('[AudioService] Failed to load mixer worklet:', error);
      // Continue without worklet mixer
    }
  }
  
  private async setupAudioPlayback(): Promise<void> {
    this.playbackContext = new AudioContext({ 
      sampleRate: this.config.sampleRate,
      latencyHint: 'interactive'
    });
  }
  
  private sendAudioFrame(audioBuffer: ArrayBuffer): void {
    const store = this.getStore();
    const ws = store?.wsConnection;
    console.log('[AudioService] Sending audio frame, ws state:', ws?.readyState, 'buffer size:', audioBuffer.byteLength);
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Create audio packet with sequence number
      const packet = {
        seq: this.sequenceNumber++,
        ts: Date.now(),
        data: this.encodeAudio(audioBuffer)
      };
      
      const message = {
        AudioData: {
          data: this.arrayBufferToBase64(packet.data),
          sampleRate: this.config.sampleRate,
          channels: this.config.channels,
          sequence: packet.seq,
          timestamp: packet.ts
        }
      };
      
      console.log('[AudioService] Sending WebSocket message:', { seq: packet.seq, dataLength: message.AudioData.data.length });
      ws.send(JSON.stringify(message));
    } else {
      console.warn('[AudioService] Cannot send audio: WebSocket not ready');
    }
  }
  
  private encodeAudio(buffer: ArrayBuffer): ArrayBuffer {
    // In a real implementation, you would use Opus encoding here
    // For now, we'll just compress to 16-bit PCM
    const float32 = new Float32Array(buffer);
    const int16 = new Int16Array(float32.length);
    
    for (let i = 0; i < float32.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = sample * 0x7FFF;
    }
    
    return int16.buffer;
  }
  
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
  
  handleIncomingAudio(participantId: string, audioData: any): void {
    const buffer = this.base64ToArrayBuffer(audioData.data);
    const packet: AudioPacket = {
      sequenceNumber: audioData.sequence || 0,
      timestamp: audioData.timestamp || Date.now(),
      data: buffer
    };
    
    if (this.isHost) {
      // Host mixes audio
      this.mixParticipantAudio(participantId, packet);
    } else {
      // Regular participant plays audio through jitter buffer
      let jitterBuffer = this.jitterBuffers.get(participantId);
      if (!jitterBuffer) {
        jitterBuffer = new JitterBuffer();
        this.jitterBuffers.set(participantId, jitterBuffer);
      }
      
      jitterBuffer.push(packet);
      this.playBufferedAudio(participantId);
    }
  }
  
  private mixParticipantAudio(participantId: string, packet: AudioPacket): void {
    if (!this.mixerContext) return;
    
    // Decode audio data
    const int16 = new Int16Array(packet.data);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 0x7FFF;
    }
    
    // Create audio buffer
    const audioBuffer = this.mixerContext.createBuffer(
      1, 
      float32.length, 
      this.config.sampleRate
    );
    audioBuffer.copyToChannel(float32, 0);
    
    // Play through gain node for mixing
    const source = this.mixerContext.createBufferSource();
    source.buffer = audioBuffer;
    
    let gainNode = this.participantGains.get(participantId);
    if (!gainNode) {
      gainNode = this.mixerContext.createGain();
      gainNode.connect(this.mixerDestination!);
      this.participantGains.set(participantId, gainNode);
    }
    
    source.connect(gainNode);
    source.start();
    
    // Send mixed audio to all participants
    if (this.mixerDestination) {
      const mixedStream = this.mixerDestination.stream;
      // Process and send mixed audio
      this.processMixedAudio(mixedStream);
    }
  }
  
  private processMixedAudio(stream: MediaStream): void {
    // This would capture the mixed audio and send it to all participants
    // Implementation depends on how you want to capture from the destination
  }
  
  private playBufferedAudio(participantId: string): void {
    if (!this.playbackContext) return;
    
    const jitterBuffer = this.jitterBuffers.get(participantId);
    if (!jitterBuffer) return;
    
    const packet = jitterBuffer.pop();
    if (!packet) return;
    
    // Decode and play audio
    const int16 = new Int16Array(packet.data);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 0x7FFF;
    }
    
    const audioBuffer = this.playbackContext.createBuffer(
      1, 
      float32.length, 
      this.config.sampleRate
    );
    audioBuffer.copyToChannel(float32, 0);
    
    const source = this.playbackContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.playbackContext.destination);
    source.start();
    
    // Schedule next packet
    setTimeout(() => this.playBufferedAudio(participantId), this.config.frameDuration);
  }
  
  toggleMute(muted: boolean): void {
    console.log('[AudioService] Toggling mute to:', muted);
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach(track => {
        track.enabled = !muted;
        console.log('[AudioService] Track', track.label, 'enabled:', track.enabled);
      });
    } else {
      console.warn('[AudioService] No media stream to toggle mute');
    }
  }
  
  getAudioLevel(): number {
    if (!this.analyserNode) return 0;
    
    const bufferLength = this.analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyserNode.getByteFrequencyData(dataArray);
    
    const average = dataArray.reduce((acc, val) => acc + val, 0) / bufferLength;
    return average / 255;
  }
  
  getMediaStream(): MediaStream | null {
    return this.mediaStream;
  }
  
  private async setupFallbackAudioCapture(): Promise<void> {
    console.log('[AudioService] Using fallback ScriptProcessorNode for audio capture');
    
    if (!this.audioContext || !this.mediaStream) {
      console.error('[AudioService] Audio context or media stream not available');
      return;
    }
    
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    const bufferSize = 2048; // Must be power of 2
    const scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    
    // Create analyser if not already created
    if (!this.analyserNode) {
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.8;
    }
    
    let frameBuffer = new Float32Array(Math.floor(this.config.sampleRate * this.config.frameDuration / 1000));
    let frameBufferIndex = 0;
    
    scriptProcessor.onaudioprocess = (event) => {
      const store = this.getStore();
      const currentMuted = store?.isMuted;
      console.log('[AudioService] ScriptProcessor audio process, muted:', currentMuted);
      if (!currentMuted) {
        const inputData = event.inputBuffer.getChannelData(0);
        
        for (let i = 0; i < inputData.length; i++) {
          frameBuffer[frameBufferIndex++] = inputData[i];
          
          if (frameBufferIndex >= frameBuffer.length) {
            // Send complete frame
            console.log('[AudioService] Sending audio frame via ScriptProcessor');
            this.sendAudioFrame(frameBuffer.buffer.slice(0));
            frameBufferIndex = 0;
          }
        }
      }
    };
    
    // Connect audio graph
    source.connect(this.analyserNode);
    this.analyserNode.connect(scriptProcessor);
    scriptProcessor.connect(this.audioContext.destination);
    
    console.log('[AudioService] Fallback audio capture setup complete');
  }
  
  cleanup(): void {
    // Stop media stream
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
    }
    
    // Close audio contexts
    if (this.audioContext) {
      this.audioContext.close();
    }
    if (this.mixerContext) {
      this.mixerContext.close();
    }
    if (this.playbackContext) {
      this.playbackContext.close();
    }
    
    // Clear buffers
    this.jitterBuffers.clear();
    this.participantGains.clear();
    this.participantSources.clear();
  }
}