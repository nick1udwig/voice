import { BaseVoiceStore } from '../store/base-voice';
import { getOpusCodec, destroyOpusCodec } from './opus-codec';

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

export class AudioServiceV2 {
  private getStore: () => BaseVoiceStore;
  private config: AudioConfig;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private audioWorkletNode: AudioWorkletNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private isHost: boolean = false;
  private sequenceNumber: number = 0;
  private opusCodec = getOpusCodec();

  // Audio mixing (for host)
  private mixerContext: AudioContext | null = null;
  private mixerDestination: MediaStreamAudioDestinationNode | null = null;
  private mixerNode: GainNode | null = null; // Master mixer node
  private participantGains: Map<string, GainNode> = new Map();
  private participantSources: Map<string, MediaStreamAudioSourceNode> = new Map();

  // Jitter buffers for incoming audio
  private jitterBuffers: Map<string, JitterBuffer> = new Map();

  // Audio playback
  private playbackContext: AudioContext | null = null;
  private playbackSources: Map<string, AudioBufferSourceNode> = new Map();
  private nextPlayTime: Map<string, number> = new Map(); // Track when to play next audio

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

    // Always set up playback for non-hosts (to hear mixed audio from host)
    // Hosts need mixer instead
    if (isHost) {
      console.log('[AudioService] Setting up audio mixer (host)');
      await this.setupAudioMixer();
    } else {
      console.log('[AudioService] Setting up audio playback (participant)');
      await this.setupAudioPlayback();
    }

    console.log('[AudioService] Audio initialization complete');
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
      this.audioWorkletNode.port.onmessage = async (event) => {
        // Get fresh state
        const currentStore = this.getStore();
        const currentMuted = currentStore.isMuted;
        console.log('[AudioService] Received audio frame from worklet, isMuted:', currentMuted, 'type:', typeof currentMuted);
        if (event.data.type === 'audio-frame' && !currentMuted) {
          await this.sendAudioFrame(event.data.buffer);
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

    // Create master mixer node that all participants connect to
    this.mixerNode = this.mixerContext.createGain();
    this.mixerNode.gain.value = 1.0;

    // Create destination for capturing mixed audio
    this.mixerDestination = this.mixerContext.createMediaStreamDestination();

    // Connect mixer to destination (for capture, not playback)
    this.mixerNode.connect(this.mixerDestination);

    // Set up capture of mixed audio
    this.setupMixedAudioCapture();

    console.log('[AudioService] Audio mixer setup complete');
  }

  private setupMixedAudioCapture(): void {
    if (!this.mixerContext || !this.mixerDestination) return;

    const mixedStream = this.mixerDestination.stream;
    const source = this.mixerContext.createMediaStreamSource(mixedStream);

    // Use ScriptProcessor to capture mixed audio
    const bufferSize = 512; // Reduced from 2048 for lower latency
    const processor = this.mixerContext.createScriptProcessor(bufferSize, 1, 1);

    let frameBuffer = new Float32Array(Math.floor(this.config.sampleRate * this.config.frameDuration / 1000));
    let frameBufferIndex = 0;
    let frameCount = 0;

    processor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0);

      for (let i = 0; i < inputData.length; i++) {
        frameBuffer[frameBufferIndex++] = inputData[i];

        if (frameBufferIndex >= frameBuffer.length) {
          // Check if we have audio
          const hasAudio = frameBuffer.some(sample => Math.abs(sample) > 0.001);
          if (frameCount % 50 === 0) { // Log every 50 frames
            const maxLevel = Math.max(...frameBuffer.map(Math.abs));
            console.log('[AudioService] Host sending mixed audio - hasAudio:', hasAudio, 'maxLevel:', maxLevel);
          }
          frameCount++;

          // Send complete frame
          this.sendAudioFrame(frameBuffer.buffer.slice(0)).catch(err =>
            console.error('[AudioService] Failed to send mixed audio:', err)
          );
          frameBufferIndex = 0;
        }
      }
    };

    source.connect(processor);
    // DO NOT connect processor to destination - this creates feedback!
    // processor.connect(this.mixerContext.destination);

    console.log('[AudioService] Mixed audio capture setup complete');
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
      // We can't resume here without user interaction, it will happen in toggleMute
    }

    console.log('[AudioService] Playback context state:', this.playbackContext.state);
  }

  private async sendAudioFrame(audioBuffer: ArrayBuffer): Promise<void> {
    const store = this.getStore();
    const ws = store?.wsConnection;
    // Log every 10th frame to reduce console spam
    if (this.sequenceNumber % 10 === 0) {
      console.log('[AudioService] Sending audio frame, ws state:', ws?.readyState, 'seq:', this.sequenceNumber);
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        // Create audio packet with sequence number
        const encodedData = await this.encodeAudio(audioBuffer);
        const packet = {
          seq: this.sequenceNumber++,
          ts: Date.now(),
          data: encodedData
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

        // Already logged above if needed
        ws.send(JSON.stringify(message));
      } catch (error) {
        console.error('[AudioService] Failed to encode/send audio:', error);
      }
    } else {
      console.warn('[AudioService] Cannot send audio: WebSocket not ready');
    }
  }

  private async encodeAudio(buffer: ArrayBuffer): Promise<ArrayBuffer> {
    // Use Opus encoding
    const float32 = new Float32Array(buffer);
    try {
      const encoded = await this.opusCodec.encode(float32);
      console.log('[AudioService] Encoded audio:', float32.length, 'samples to', encoded.length, 'bytes');
      return encoded.buffer;
    } catch (error) {
      console.error('[AudioService] Opus encoding failed:', error);
      // Fallback to 16-bit PCM
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const sample = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = sample * 0x7FFF;
      }
      return int16.buffer;
    }
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

  async handleIncomingAudio(participantId: string, audioData: any): Promise<void> {
    console.log('[AudioService] handleIncomingAudio from:', participantId, 'isHost:', this.isHost);
    const encodedBuffer = this.base64ToArrayBuffer(audioData.data);

    // Decode the Opus data
    let decodedData: ArrayBuffer;
    try {
      const opusData = new Uint8Array(encodedBuffer);
      const float32Data = await this.opusCodec.decode(opusData);
      console.log('[AudioService] Decoded audio:', opusData.length, 'bytes to', float32Data.length, 'samples');

      // Convert Float32Array back to ArrayBuffer for compatibility
      const int16 = new Int16Array(float32Data.length);
      for (let i = 0; i < float32Data.length; i++) {
        const sample = Math.max(-1, Math.min(1, float32Data[i]));
        int16[i] = sample * 0x7FFF;
      }
      decodedData = int16.buffer;
    } catch (error) {
      console.error('[AudioService] Opus decoding failed:', error);
      // Fallback - assume it's already PCM
      decodedData = encodedBuffer;
    }

    const packet: AudioPacket = {
      sequenceNumber: audioData.sequence || 0,
      timestamp: audioData.timestamp || Date.now(),
      data: decodedData
    };
    console.log('[AudioService] Audio packet size:', decodedData.byteLength, 'seq:', packet.sequenceNumber);

    if (this.isHost) {
      // Host mixes audio
      console.log('[AudioService] Host mixing audio from participant:', participantId);
      this.mixParticipantAudio(participantId, packet);
    } else {
      // Regular participant plays audio through jitter buffer
      console.log('[AudioService] Participant receiving audio for playback');

      if (!this.playbackContext) {
        console.error('[AudioService] Playback context not initialized!');
        return;
      }

      let jitterBuffer = this.jitterBuffers.get(participantId);
      if (!jitterBuffer) {
        console.log('[AudioService] Creating new jitter buffer for:', participantId);
        jitterBuffer = new JitterBuffer();
        this.jitterBuffers.set(participantId, jitterBuffer);
        // Start playback loop for this participant
        this.startPlaybackLoop(participantId);
      }

      jitterBuffer.push(packet);
      console.log('[AudioService] Pushed packet to jitter buffer, jitterBuffers count:', this.jitterBuffers.size, 'packets in buffer:', jitterBuffer.getBufferSize());
    }
  }

  private testImmediatePlayback(packet: AudioPacket): void {
    console.log('[AudioService] TEST: Immediate playback of packet');
    if (!this.playbackContext) return;

    try {
      // Decode audio
      const int16 = new Int16Array(packet.data);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 0x7FFF;
      }

      // Check audio content
      const hasAudio = float32.some(sample => Math.abs(sample) > 0.001);
      const maxLevel = Math.max(...float32.map(Math.abs));
      console.log('[AudioService] TEST: Audio analysis - hasAudio:', hasAudio, 'maxLevel:', maxLevel, 'samples:', float32.length);

      // Create and play buffer
      const audioBuffer = this.playbackContext.createBuffer(1, float32.length, this.config.sampleRate);
      audioBuffer.copyToChannel(float32, 0);

      const source = this.playbackContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.playbackContext.destination);
      source.start();

      console.log('[AudioService] TEST: Started immediate playback, context state:', this.playbackContext.state);
    } catch (error) {
      console.error('[AudioService] TEST: Immediate playback error:', error);
    }
  }

  private mixParticipantAudio(participantId: string, packet: AudioPacket): void {
    console.log('[AudioService] Host mixing audio from:', participantId, 'seq:', packet.sequenceNumber);

    if (!this.mixerContext || !this.mixerNode) {
      console.error('[AudioService] No mixer context or mixer node!');
      return;
    }

    // Decode audio data
    const int16 = new Int16Array(packet.data);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 0x7FFF;
    }

    // Check if we have audio
    const hasAudio = float32.some(sample => Math.abs(sample) > 0.001);
    console.log('[AudioService] Mixing audio has content:', hasAudio, 'samples:', float32.length);

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
      gainNode.connect(this.mixerNode); // Connect to mixer node, not destination
      this.participantGains.set(participantId, gainNode);
      console.log('[AudioService] Created gain node for:', participantId);
    }

    source.connect(gainNode);
    source.start();
  }

  private processMixedAudio(stream: MediaStream): void {
    // Mixed audio is now captured automatically by setupMixedAudioCapture
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
      // Decode and play audio
      const int16 = new Int16Array(packet.data);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 0x7FFF;
      }

      // Check if we have any non-zero samples
      const hasAudio = float32.some(sample => sample !== 0);
      const expectedSamples = Math.floor(this.config.sampleRate * this.config.frameDuration / 1000);
      if (packet.sequenceNumber % 10 === 0) {
        console.log('[AudioService] Playing packet seq:', packet.sequenceNumber,
          'samples:', float32.length,
          'expected:', expectedSamples,
          'hasAudio:', hasAudio);
      }

      const audioBuffer = this.playbackContext.createBuffer(
        1,
        float32.length,
        this.config.sampleRate
      );
      audioBuffer.copyToChannel(float32, 0);

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

    // Resume audio contexts on user interaction
    this.resumeAudioContexts();
  }

  private async resumeAudioContexts(): Promise<void> {
    console.log('[AudioService] Resuming audio contexts on user interaction');

    if (this.audioContext && this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
        console.log('[AudioService] Resumed audio context, state:', this.audioContext.state);
      } catch (error) {
        console.error('[AudioService] Failed to resume audio context:', error);
      }
    }

    if (this.playbackContext && this.playbackContext.state === 'suspended') {
      try {
        await this.playbackContext.resume();
        console.log('[AudioService] Resumed playback context, state:', this.playbackContext.state);
      } catch (error) {
        console.error('[AudioService] Failed to resume playback context:', error);
      }
    }

    if (this.mixerContext && this.mixerContext.state === 'suspended') {
      try {
        await this.mixerContext.resume();
        console.log('[AudioService] Resumed mixer context, state:', this.mixerContext.state);
      } catch (error) {
        console.error('[AudioService] Failed to resume mixer context:', error);
      }
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
    const bufferSize = 512; // Reduced for lower latency, must be power of 2
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
            this.sendAudioFrame(frameBuffer.buffer.slice(0)).catch(err =>
              console.error('[AudioService] Failed to send audio frame:', err)
            );
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

    // Cleanup Opus codec
    destroyOpusCodec();
  }
}
