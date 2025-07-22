import React, { useEffect, useState, useRef } from 'react';
import { ParticipantInfo, ChatMessage as ChatMessageType, Role, UserSettings } from '../../../../target/ui/caller-utils';
import { getRoleEmoji, ROLE_OPTIONS } from '../../utils/roleUtils';
import { ChatMessage } from '../ChatMessage';
import { SettingsModal } from '../SettingsModal';
import '../../styles/settings.css';

const BASE_URL = import.meta.env.BASE_URL;

interface CallScreenProps {
  callId: string;
  onLeaveCall?: () => void;
  participants: ParticipantInfo[];
  chatMessages: ChatMessageType[];
  myRole: Role | null;
  isMuted: boolean;
  onToggleMute: () => void;
  onSendMessage: (message: string) => void;
  onUpdateRole: (targetId: string, newRole: Role) => void;
  onUpdateSettings?: (settings: UserSettings) => void;
  onUpdateAvatar?: (avatarUrl: string | null) => void;
  nodeConnected?: boolean;
  joinCall: (callId: string, authToken?: string | null, settings?: UserSettings) => void;
  authToken?: string | null;
  myParticipantId?: string;
  speakingParticipants?: Set<string>;
  mySettings: UserSettings;
  onUserInteraction?: () => void;
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
  speakingParticipants = new Set(),
  mySettings,
  onUpdateSettings,
  onUpdateAvatar,
  onUserInteraction
}) => {
  const [message, setMessage] = useState('');
  const [audioResumed, setAudioResumed] = useState(false);
  const [roleMenuOpen, setRoleMenuOpen] = useState<string | null>(null);
  const [showCopySuccess, setShowCopySuccess] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (callId) {
      // Check if we have stored settings (for host)
      const storedSettings = sessionStorage.getItem('hostSettings');
      const settings = storedSettings ? JSON.parse(storedSettings) : undefined;

      // Clear the stored settings after using them
      if (storedSettings) {
        sessionStorage.removeItem('hostSettings');
      }

      // Join the call - works for both authenticated and unauthenticated users
      joinCall(callId, authToken, settings);
    }
  }, [callId, joinCall, authToken]);

  // Auto-scroll chat to bottom when new messages arrive
  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
    }
  }, [chatMessages]);

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
      // This will trigger audio context resume in the audio service
      setAudioResumed(true);
      // Call the audio service handler if provided
      if (onUserInteraction) {
        onUserInteraction();
      }
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
                <li key={participant.id} className={`participant ${participant.role?.toLowerCase() || 'listener'} ${isSpeaking ? 'speaking' : ''} ${isMe ? 'is-me' : ''}`}>
                  <div className="participant-info">
                    {myRole === 'Admin' && !isMe ? (
                      <button
                        className="participant-role clickable"
                        title="Click to change role"
                        onClick={() => setRoleMenuOpen(roleMenuOpen === participant.id ? null : participant.id)}
                      >
                        {getRoleEmoji(participant.role)}
                      </button>
                    ) : (
                      <span className="participant-role" title={participant.role || 'Listener'}>
                        {getRoleEmoji(participant.role)}
                      </span>
                    )}
                    {mySettings.showAvatars && participant.avatarUrl && (
                      <img
                        src={participant.avatarUrl}
                        alt={`${participant.displayName}'s avatar`}
                        className="participant-avatar"
                      />
                    )}
                    <span className="participant-name">{participant.displayName}{isMe && ' (You)'}</span>
                    <span className="muted-indicator">{participant.isMuted ? '🔇' : ''}</span>
                  </div>

                  {myRole === 'Admin' && !isMe && roleMenuOpen === participant.id && (
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
                </li>
              );
            })}
          </ul>
        </div>

        <div className="chat-section">
          <h2>Chat {myRole === 'Listener' && <span className="role-note">(Listeners cannot chat)</span>}</h2>
          <div className="chat-messages" ref={chatMessagesRef}>
            {chatMessages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} settings={mySettings} />
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
        <button
          onClick={() => {
            const shareLink = `${window.location.origin}${BASE_URL}/call/${callId}`;
            navigator.clipboard.writeText(shareLink);
            setShowCopySuccess(true);
            setTimeout(() => setShowCopySuccess(false), 3000);
          }}
          className="share-button"
        >
          {showCopySuccess ? '✓ Copied!' : '📋 Copy Share Link'}
        </button>
        <button
          onClick={() => setShowSettings(true)}
          className="settings-button"
        >
          ⚙️ Settings
        </button>
      </div>

      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={mySettings}
        onSettingsChange={onUpdateSettings || (() => {})}
        onUpdateAvatar={onUpdateAvatar}
      />
    </div>
  );
};
