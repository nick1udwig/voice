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
    participants,
    chatMessages,
    myRole,
    isMuted,
    toggleMute,
    sendChatMessage,
    nodeConnected
  } = useVoiceStore();

  const handleLeaveCall = () => {
    // TODO: Implement proper leave call
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
      isMuted={isMuted}
      onToggleMute={toggleMute}
      onSendMessage={sendChatMessage}
      nodeConnected={nodeConnected}
      joinCall={joinCall}
    />
  );
};