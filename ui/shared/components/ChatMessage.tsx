import React from 'react';
import { ChatMessage as ChatMessageType, UserSettings } from '../../../target/ui/caller-utils';
import { parseMessageContent } from '../utils/chat';

interface ChatMessageProps {
  message: ChatMessageType;
  settings: UserSettings;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ message, settings }) => {
  const renderContent = () => {
    if (!settings.showImagesInChat) {
      // Just render as plain text if image display is disabled
      return <span className="content">{message.content}</span>;
    }
    
    const parts = parseMessageContent(message.content);
    
    return (
      <span className="content">
        {parts.map((part, index) => {
          if (part.type === 'image') {
            return (
              <div key={index} className="chat-image-container">
                <img 
                  src={part.value} 
                  alt="Shared image" 
                  className="chat-image"
                  onError={(e) => {
                    // If image fails to load, show the URL as text
                    const target = e.target as HTMLImageElement;
                    target.style.display = 'none';
                    const fallback = document.createElement('span');
                    fallback.textContent = part.value;
                    target.parentNode?.appendChild(fallback);
                  }}
                />
              </div>
            );
          } else {
            return <span key={index}>{part.value}{' '}</span>;
          }
        })}
      </span>
    );
  };
  
  const timestamp = new Date(message.timestamp);
  const timeString = timestamp.toLocaleTimeString('en-US', { 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit' 
  });
  
  return (
    <div className="chat-message">
      <span className="timestamp">[{timeString}]</span>
      <span className="sender">{message.senderName}:</span>
      {renderContent()}
    </div>
  );
};