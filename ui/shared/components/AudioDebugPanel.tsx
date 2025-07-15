import React from 'react';
import { useVoiceStore } from '../../ui-call/src/store/voice';

export const AudioDebugPanel: React.FC = () => {
  const { audioService, wsConnection, isMuted } = useVoiceStore();

  const sendTestAudio = () => {
    console.log('[AudioDebugPanel] Test audio sending disabled - use real microphone input');
  };

  const testAudioCapture = async () => {
    console.log('[AudioDebugPanel] Testing audio capture...');
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('[AudioDebugPanel] Got media stream:', stream);
      console.log('[AudioDebugPanel] Audio tracks:', stream.getAudioTracks());
      
      // Create audio context to analyze
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      source.connect(analyser);
      
      // Check audio levels
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      setTimeout(() => {
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        console.log('[AudioDebugPanel] Audio level average:', average);
        
        // Clean up
        stream.getTracks().forEach(track => track.stop());
        audioContext.close();
      }, 1000);
    } catch (error) {
      console.error('[AudioDebugPanel] Failed to get user media:', error);
    }
  };

  return (
    <div style={{ 
      position: 'fixed', 
      bottom: 20, 
      right: 20, 
      background: 'rgba(0,0,0,0.8)', 
      color: 'white', 
      padding: '10px',
      borderRadius: '5px',
      fontSize: '12px'
    }}>
      <h4>Audio Debug Panel</h4>
      <div>WS Ready: {wsConnection?.readyState === WebSocket.OPEN ? 'Yes' : 'No'}</div>
      <div>Audio Service: {audioService ? 'Yes' : 'No'}</div>
      <div>Muted: {isMuted ? 'Yes' : 'No'}</div>
      <button onClick={sendTestAudio} style={{ margin: '5px' }}>
        Send Test Audio
      </button>
      <button onClick={testAudioCapture} style={{ margin: '5px' }}>
        Test Audio Capture
      </button>
    </div>
  );
};