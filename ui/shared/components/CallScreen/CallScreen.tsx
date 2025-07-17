import React, { useEffect, useState } from 'react';
import { ParticipantInfo, ChatMessage, Role } from '../../../../target/ui/caller-utils';
import { getRoleEmoji, ROLE_OPTIONS } from '../../utils/roleUtils';

interface CallScreenProps {
  callId: string;
  onLeaveCall?: () => void;
  participants: ParticipantInfo[];
  chatMessages: ChatMessage[];
  myRole: Role | null;
  isMuted: boolean;
  onToggleMute: () => void;
  onSendMessage: (message: string) => void;
  onUpdateRole: (targetId: string, newRole: Role) => void;
  nodeConnected?: boolean;
  joinCall: (callId: string, authToken?: string | null) => void;
  authToken?: string | null;
  myParticipantId?: string;
  speakingParticipants?: Set<string>;
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
  onUpdateRole,
  nodeConnected = false,
  joinCall,
  authToken,
  myParticipantId = '',
  speakingParticipants = new Set()
}) => {
  const [message, setMessage] = useState('');
  const [audioResumed, setAudioResumed] = useState(false);
  const [roleMenuOpen, setRoleMenuOpen] = useState<string | null>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (callId) {
      // Join the call - works for both authenticated and unauthenticated users
      joinCall(callId, authToken);
    }
  }, [callId, joinCall, authToken]);

  // Position menu to stay on screen
  useEffect(() => {
    if (roleMenuOpen && menuRef.current) {
      const menu = menuRef.current.querySelector('.role-menu') as HTMLElement;
      if (menu) {
        const rect = menu.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        
        // Reset positioning
        menu.style.top = '';
        menu.style.bottom = '';
        menu.style.left = '';
        menu.style.right = '';
        
        // Check if menu goes off bottom of screen
        if (rect.bottom > viewportHeight) {
          menu.style.top = 'auto';
          menu.style.bottom = '100%';
          menu.style.marginBottom = '0.25rem';
          menu.style.marginTop = '0';
        }
        
        // Check if menu goes off right edge of screen
        if (rect.right > viewportWidth) {
          menu.style.left = 'auto';
          menu.style.right = '0';
        }
        
        // On mobile, center the menu if it's too wide
        if (viewportWidth < 768) {
          const menuWidth = rect.width;
          if (menuWidth > viewportWidth * 0.9) {
            menu.style.position = 'fixed';
            menu.style.left = '5%';
            menu.style.right = '5%';
            menu.style.width = '90%';
          }
        }
      }
    }
  }, [roleMenuOpen]);

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

  const handleChangeRole = (targetId: string, newRole: Role) => {
    onUpdateRole(targetId, newRole);
    setRoleMenuOpen(null);
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
            {participants.filter(p => p.displayName).map((participant) => {
              // Show speaking effect only when actively speaking (not just unmuted)
              const canSpeak = participant.role === 'Speaker' || participant.role === 'Admin';
              const isSpeaking = canSpeak && !participant.isMuted && speakingParticipants.has(participant.id);
              const isMe = participant.id === myParticipantId;
              
              return (
                <li key={participant.id} className={`participant ${participant.role?.toLowerCase() || 'listener'} ${isSpeaking ? 'speaking' : ''}`}>
                  <div className="participant-info">
                    <span className="participant-name">{participant.displayName}</span>
                    <span className="participant-role" title={participant.role || 'Listener'}>
                      {getRoleEmoji(participant.role)}
                    </span>
                    {participant.isMuted && <span className="muted-indicator">🔇</span>}
                  </div>
                  
                  {myRole === 'Admin' && !isMe && (
                    <div className="admin-controls">
                      <button
                        className="role-menu-button"
                        onClick={() => setRoleMenuOpen(roleMenuOpen === participant.id ? null : participant.id)}
                        title="Manage participant"
                      >
                        ⚙️
                      </button>
                      
                      {roleMenuOpen === participant.id && (
                        <div ref={menuRef}>
                          <div className="role-menu" data-participant-id={participant.id}>
                            <div className="role-menu-header">Change Role</div>
                            {ROLE_OPTIONS.map(role => (
                              <button
                                key={role}
                                className={`role-option ${participant.role === role ? 'current' : ''}`}
                                onClick={() => handleChangeRole(participant.id, role)}
                              >
                                {getRoleEmoji(role)} {role}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
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
        {myRole && <span className="my-role">Your Role: {getRoleEmoji(myRole)} {myRole}</span>}
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