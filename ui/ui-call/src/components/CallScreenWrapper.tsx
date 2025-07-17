import React from 'react';
import { CallScreen } from '../../../shared/components/CallScreen/CallScreen';
import { useVoiceStore } from '../store/voice';
import '../../../shared/styles/call-screen.css';
import { AudioDebugPanel } from '../../../shared/components/AudioDebugPanel';

// Extend window interface for TypeScript
declare global {
  interface Window {
    VOICE_CALL_ID?: string;
  }
}

export const CallScreenWrapper: React.FC = () => {
  // Extract call ID from the URL path
  // URL format: /voice:voice:sys/call/{call-id}
  const pathParts = window.location.pathname.split('/');
  const callId = pathParts[pathParts.length - 1] || window.VOICE_CALL_ID || '';

  // Extract auth token from query parameters
  const urlParams = new URLSearchParams(window.location.search);
  const authToken = urlParams.get('auth');

  const {
    joinCall,
    participants,
    chatMessages,
    myRole,
    myParticipantId,
    isMuted,
    toggleMute,
    sendChatMessage,
    updateRole,
    isNodeConnection,
    speakingStates
  } = useVoiceStore();

  const handleLeaveCall = () => {
    // Redirect back to main app or close window
    window.location.href = '/';
  };

  if (!callId) {
    return (
      <div className="call-screen">
        <h2>No call ID provided</h2>
      </div>
    );
  }

  return (
    <>
      <CallScreen
        callId={callId}
        onLeaveCall={handleLeaveCall}
        participants={Array.from(participants.values())}
        chatMessages={chatMessages}
        myRole={myRole}
        myParticipantId={myParticipantId || ''}
        isMuted={isMuted}
        onToggleMute={toggleMute}
        onSendMessage={sendChatMessage}
        onUpdateRole={updateRole}
        nodeConnected={isNodeConnection}
        joinCall={joinCall}
        authToken={authToken}
        speakingParticipants={new Set(Array.from(speakingStates.entries()).filter(([_, isSpeaking]) => isSpeaking).map(([id]) => id))}
      />
      <AudioDebugPanel />
    </>
  );
};
