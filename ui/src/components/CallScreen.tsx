import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useVoiceStore } from '../store/voice';

export const CallScreen: React.FC = () => {
  const { callId } = useParams<{ callId: string }>();
  const navigate = useNavigate();
  const { 
    joinCall, 
    currentCall,
    participants,
    chatMessages,
    myRole,
    isMuted,
    toggleMute,
    sendChatMessage,
    nodeConnected
  } = useVoiceStore();

  const [message, setMessage] = useState('');

  useEffect(() => {
    if (callId && nodeConnected) {
      joinCall(callId);
    }
  }, [callId, nodeConnected, joinCall]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim() && (myRole === 'Chatter' || myRole === 'Speaker' || myRole === 'Admin')) {
      sendChatMessage(message);
      setMessage('');
    }
  };

  const handleLeaveCall = () => {
    // TODO: Implement leave call
    navigate('/');
  };

  if (!nodeConnected) {
    return (
      <div className="call-screen">
        <h2 style={{ color: 'red' }}>Node not connected</h2>
      </div>
    );
  }

  return (
    <div className="call-screen">
      <div className="main-content">
        <div className="call-header">
          <h2>Call: {callId}</h2>
          <button onClick={handleLeaveCall} className="leave-button">
            Leave Call
          </button>
        </div>

        <div className="participants-grid">
          <h3>Participants ({participants.size})</h3>
          <div className="participant-list">
            {Array.from(participants.values()).map((participant) => {
              const roleIcon = {
                'Listener': '👂',
                'Chatter': '💬',
                'Speaker': '🎤',
                'Admin': '👑'
              }[participant.role] || '';
              
              const canSpeak = participant.role === 'Speaker' || participant.role === 'Admin';
              
              return (
                <div key={participant.id} className="participant-card">
                  <div className="participant-header">
                    <span className="participant-role-icon">{roleIcon}</span>
                    <span className="participant-name">{participant.displayName}</span>
                  </div>
                  {canSpeak && (
                    <div className="participant-status">
                      {participant.isMuted ? '🔇' : '🔊'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {(myRole === 'Speaker' || myRole === 'Admin') && (
          <div className="voice-controls">
            <button onClick={toggleMute} className={`mute-button ${isMuted ? 'muted' : ''}`}>
              {isMuted ? '🔇 Unmute' : '🔊 Mute'}
            </button>
          </div>
        )}
      </div>

      <div className="sidebar">
        <div className="chat-panel">
          <h3>Chat</h3>
          <div className="chat-messages">
            {chatMessages.map((msg) => (
              <div key={msg.id} className="chat-message">
                <span className="chat-sender">{msg.senderName}:</span>
                <span className="chat-content">{msg.content}</span>
              </div>
            ))}
          </div>
          
          {(myRole === 'Chatter' || myRole === 'Speaker' || myRole === 'Admin') ? (
            <form onSubmit={handleSendMessage} className="chat-input-form">
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Type a message..."
                className="chat-input"
              />
              <button type="submit" className="send-button">Send</button>
            </form>
          ) : (
            <div className="chat-disabled">
              Chat is disabled for listeners
            </div>
          )}
        </div>
      </div>
    </div>
  );
};