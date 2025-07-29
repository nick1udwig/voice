import React from 'react';
import { CallScreen } from '../../../shared/components/CallScreen/CallScreen';
import { CallEndedScreen } from '../../../shared/components/CallEndedScreen';
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
  // URL format: /voice:voice:ware.hypr/call/{call-id}
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
    speakingStates,
    callEnded,
    leaveCall,
    mySettings,
    updateSettings,
    updateAvatar,
    handleUserInteraction
  } = useVoiceStore();

  // Debug callEnded state
  console.log('[CallScreenWrapper] Render - callEnded:', callEnded);

  const handleLeaveCall = () => {
    // Use the store's leaveCall function which handles showing the call ended screen
    leaveCall();
  };

  if (!callId) {
    return (
      <div className="call-screen">
        <h2>No call ID provided</h2>
      </div>
    );
  }

  // Show call ended screen if the call has ended
  if (callEnded) {
    return <CallEndedScreen />;
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
        mySettings={mySettings}
        onUpdateSettings={updateSettings}
        onUpdateAvatar={updateAvatar}
        onUserInteraction={handleUserInteraction}
      />
    </>
  );
};
