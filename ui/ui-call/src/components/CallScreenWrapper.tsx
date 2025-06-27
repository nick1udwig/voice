import React from 'react';
import { CallScreen } from '../../../shared/components/CallScreen/CallScreen';
import { useVoiceStore } from '../store/voice';
import '../../../shared/styles/call-screen.css';

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
  
  const { 
    joinCall,
    participants,
    chatMessages,
    myRole,
    isMuted,
    toggleMute,
    sendChatMessage
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
    <CallScreen
      callId={callId}
      onLeaveCall={handleLeaveCall}
      participants={Array.from(participants.values())}
      chatMessages={chatMessages}
      myRole={myRole}
      isMuted={isMuted}
      onToggleMute={toggleMute}
      onSendMessage={sendChatMessage}
      joinCall={joinCall}
    />
  );
};