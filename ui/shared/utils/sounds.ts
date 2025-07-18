// Sound notification utilities

// Create simple notification sounds using Web Audio API
export class NotificationSounds {
  private audioContext: AudioContext | null = null;
  
  constructor() {
    // Initialize audio context lazily
  }
  
  private getAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return this.audioContext;
  }
  
  // Play a simple beep sound for user join
  playUserJoinSound() {
    try {
      const ctx = this.getAudioContext();
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      // Pleasant ascending tone
      oscillator.frequency.setValueAtTime(440, ctx.currentTime); // A4
      oscillator.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.1); // E5
      
      gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
      
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.2);
    } catch (e) {
      console.error('Failed to play user join sound:', e);
    }
  }
  
  // Play a simple click sound for chat message
  playChatMessageSound() {
    try {
      const ctx = this.getAudioContext();
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      // Short click sound
      oscillator.frequency.setValueAtTime(800, ctx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.05);
      
      gainNode.gain.setValueAtTime(0.05, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.05);
      
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.05);
    } catch (e) {
      console.error('Failed to play chat message sound:', e);
    }
  }
  
  // Play a descending tone for user leave
  playUserLeaveSound() {
    try {
      const ctx = this.getAudioContext();
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      // Pleasant descending tone (opposite of join)
      oscillator.frequency.setValueAtTime(660, ctx.currentTime); // E5
      oscillator.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.1); // A4
      
      gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
      
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.2);
    } catch (e) {
      console.error('Failed to play user leave sound:', e);
    }
  }
  
  cleanup() {
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}

// Singleton instance
export const notificationSounds = new NotificationSounds();