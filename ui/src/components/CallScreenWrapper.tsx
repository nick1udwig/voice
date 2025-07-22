import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { CallScreen } from '../../shared/components/CallScreen/CallScreen';
import { useVoiceStore } from '../store/voice';
import '../../shared/styles/call-screen.css';

export const CallScreenWrapper: React.FC = () => {
  const { callId } = useParams<{ callId: string }>();
  const navigate = useNavigate();
  const { 
    joinCall,
    leaveCall, 
    participants,
    chatMessages,
    myRole,
    myParticipantId,
    isMuted,
    toggleMute,
    sendChatMessage,
    updateRole,
    nodeConnected,
    speakingStates,
    mySettings,
    updateSettings,
    updateAvatar,
    handleUserInteraction
  } = useVoiceStore();

  const handleLeaveCall = async () => {
    // Call the proper leave API and disconnect WebSocket
    await leaveCall();
    navigate('/');
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
      myParticipantId={myParticipantId || ''}
      isMuted={isMuted}
      onToggleMute={toggleMute}
      onSendMessage={sendChatMessage}
      onUpdateRole={updateRole}
      nodeConnected={nodeConnected}
      joinCall={joinCall}
      speakingParticipants={new Set(Array.from(speakingStates.entries()).filter(([_, isSpeaking]) => isSpeaking).map(([id]) => id))}
      mySettings={mySettings}
      onUpdateSettings={updateSettings}
      onUpdateAvatar={updateAvatar}
      onUserInteraction={handleUserInteraction}
    />
  );
};