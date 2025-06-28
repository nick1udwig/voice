import React, { useEffect, useState } from 'react';
import { ParticipantInfo, ChatMessage, Role } from '../../../../target/ui/caller-utils';
import { SpeakingIndicator } from '../SpeakingIndicator/SpeakingIndicator';

interface CallScreenProps {
  callId: string;
  onLeaveCall?: () => void;
  participants: ParticipantInfo[];
  chatMessages: ChatMessage[];
  myRole: Role | null;
  isMuted: boolean;
  onToggleMute: () => void;
  onSendMessage: (message: string) => void;
  nodeConnected?: boolean;
  joinCall: (callId: string, authToken?: string | null) => void;
  authToken?: string | null;
}

export const CallScreen: React.FC<CallScreenProps> = ({
  callId,
  onLeaveCall,
  participants,
  chatMessages,
  myRole,
  isMuted,
  onToggleMute,
  onSendMessage,
  nodeConnected = false,
  joinCall,
  authToken
}) => {
  const [message, setMessage] = useState('');
  const [audioResumed, setAudioResumed] = useState(false);

  useEffect(() => {
    if (callId) {
      // Join the call - works for both authenticated and unauthenticated users
      joinCall(callId, authToken);
    }
  }, [callId, joinCall, authToken]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim() && (myRole === 'Chatter' || myRole === 'Speaker' || myRole === 'Admin')) {
      onSendMessage(message);
      setMessage('');
    }
  };

  const handleLeaveCall = () => {
    if (onLeaveCall) {
      onLeaveCall();
    } else {
      // Default behavior: go to root
      window.location.href = '/';
    }
  };

  if (!callId) {
    return (
      <div className="call-screen">
        <h2>No call ID provided</h2>
      </div>
    );
  }

  const handleUserInteraction = () => {
    if (!audioResumed) {
      console.log('[CallScreen] First user interaction - resuming audio contexts');
      // This will trigger audio context resume in the audio service
      setAudioResumed(true);
    }
  };

  return (
    <div className="call-screen" onClick={handleUserInteraction}>
      <div className="call-header">
        <h1>Call ID: {callId}</h1>
        <div className="connection-status">
          Status: {nodeConnected !== undefined ? (nodeConnected ? 'Connected (Node)' : 'Connected (Browser)') : 'Connected'}
        </div>
        <button onClick={handleLeaveCall} className="leave-button">Leave Call</button>
      </div>
      
      <div className="call-content">
        <div className="participants-section">
          <h2>Participants ({participants.filter(p => p.displayName).length})</h2>
          <ul className="participants-list">
            {participants.filter(p => p.displayName).map((participant) => (
              <li key={participant.id} className={`participant ${participant.role?.toLowerCase() || 'listener'}`}>
                <span className="participant-name">{participant.displayName}</span>
                <span className="participant-role">{participant.role || 'Listener'}</span>
                {(participant.role === 'Speaker' || participant.role === 'Admin') && (
                  <SpeakingIndicator participantId={participant.id} isSpeaking={!participant.isMuted} />
                )}
                {participant.isMuted && <span className="muted-indicator">🔇</span>}
              </li>
            ))}
          </ul>
        </div>
        
        <div className="chat-section">
          <h2>Chat {myRole === 'Listener' && <span className="role-note">(Listeners cannot chat)</span>}</h2>
          <div className="chat-messages">
            {chatMessages.map((msg) => (
              <div key={msg.id} className="chat-message">
                <span className="sender">{msg.senderName}:</span>
                <span className="content">{msg.content}</span>
              </div>
            ))}
          </div>
          
          {myRole !== 'Listener' && (
            <form onSubmit={handleSendMessage} className="chat-form">
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Type a message..."
                className="chat-input"
              />
              <button type="submit" className="send-button">Send</button>
            </form>
          )}
        </div>
      </div>
      
      <div className="call-controls">
        {(myRole === 'Speaker' || myRole === 'Admin') && (
          <button onClick={onToggleMute} className={`mute-button ${isMuted ? 'muted' : ''}`}>
            {isMuted ? '🔇 Unmute' : '🎤 Mute'}
          </button>
        )}
        {myRole && <span className="my-role">Your Role: {myRole}</span>}
        {nodeConnected && (
          <button 
            onClick={() => {
              const shareLink = `${window.location.origin}/voice:voice:sys/call/${callId}`;
              navigator.clipboard.writeText(shareLink);
              alert('Share link copied to clipboard!');
            }}
            className="share-button"
          >
            📋 Copy Share Link
          </button>
        )}
      </div>
    </div>
  );
};