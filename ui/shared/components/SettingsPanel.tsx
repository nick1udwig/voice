import React, { useState } from 'react';
import { UserSettings } from '../../../target/ui/caller-utils';
import { VadSensitivityWire, toWireFormat } from '../types/settings';

interface SettingsPanelProps {
  settings: UserSettings;
  onSettingsChange: (settings: UserSettings) => void;
  isInCall?: boolean;
  onUpdateAvatar?: (avatarUrl: string | null) => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ 
  settings, 
  onSettingsChange,
  isInCall = false,
  onUpdateAvatar
}) => {
  const [avatarUrl, setAvatarUrl] = useState('');
  const [localAvatarUrl, setLocalAvatarUrl] = useState('');
  
  // Load saved avatar URL when component mounts
  React.useEffect(() => {
    const savedUrl = localStorage.getItem('avatarUrl');
    if (savedUrl) {
      setLocalAvatarUrl(savedUrl);
      setAvatarUrl(savedUrl);
    }
  }, []);
  const handleToggle = (key: keyof UserSettings) => {
    onSettingsChange({
      ...settings,
      [key]: !settings[key]
    });
  };

  return (
    <div className="settings-panel">
      <h3>{isInCall ? 'Call Settings' : 'Default Settings'}</h3>
      
      <div className="settings-section">
        <h4>Sound Notifications</h4>
        
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.soundOnUserJoin}
            onChange={() => handleToggle('soundOnUserJoin')}
          />
          <span>Play sound when user joins</span>
        </label>
        
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.soundOnUserLeave}
            onChange={() => handleToggle('soundOnUserLeave')}
          />
          <span>Play sound when user leaves</span>
        </label>
        
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.soundOnChatMessage}
            onChange={() => handleToggle('soundOnChatMessage')}
          />
          <span>Play sound for chat messages</span>
        </label>
      </div>
      
      <div className="settings-section">
        <h4>Chat Features</h4>
        
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.showImagesInChat}
            onChange={() => handleToggle('showImagesInChat')}
          />
          <span>Show images in chat</span>
        </label>
      </div>
      
      <div className="settings-section">
        <h4>Display Settings</h4>
        
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.showAvatars}
            onChange={() => handleToggle('showAvatars')}
          />
          <span>Show participant avatars</span>
        </label>
        
        {onUpdateAvatar && (
          <div className="avatar-setting">
            <label>Avatar Image URL:</label>
            <div className="avatar-input-group">
              <input
                type="text"
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                placeholder="Enter image URL"
                className="avatar-url-input"
              />
              <button 
                onClick={() => {
                  if (avatarUrl.trim()) {
                    onUpdateAvatar(avatarUrl.trim());
                    if (!isInCall) {
                      localStorage.setItem('avatarUrl', avatarUrl.trim());
                    }
                  } else {
                    onUpdateAvatar(null);
                    if (!isInCall) {
                      localStorage.removeItem('avatarUrl');
                    }
                  }
                  if (!isInCall) {
                    // Keep the value in the input when not in call
                    setLocalAvatarUrl(avatarUrl.trim());
                  } else {
                    // Clear the input when in call
                    setAvatarUrl('');
                  }
                }}
                className="avatar-update-button"
              >
                {isInCall ? 'Update Avatar' : 'Set Avatar'}
              </button>
            </div>
            {!isInCall && localAvatarUrl && (
              <div className="avatar-preview">
                <img src={localAvatarUrl} alt="Avatar preview" />
              </div>
            )}
          </div>
        )}
      </div>
      
      <div className="settings-section">
        <h4>Voice Detection</h4>
        
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.vadAdaptive}
            onChange={() => handleToggle('vadAdaptive')}
          />
          <span>Automatic sensitivity adjustment</span>
        </label>
        
        {!settings.vadAdaptive && (
          <div className="sensitivity-control">
            <label>Voice sensitivity:</label>
            <div className="sensitivity-buttons">
              <button
                className={`sensitivity-btn ${settings.vadSensitivity === 'Low' || toWireFormat(settings.vadSensitivity) === 'low' ? 'active' : ''}`}
                onClick={() => onSettingsChange({
                  ...settings,
                  vadSensitivity: 'Low'
                })}
              >
                Low
              </button>
              <button
                className={`sensitivity-btn ${settings.vadSensitivity === 'Medium' || toWireFormat(settings.vadSensitivity) === 'medium' ? 'active' : ''}`}
                onClick={() => onSettingsChange({
                  ...settings,
                  vadSensitivity: 'Medium'
                })}
              >
                Medium
              </button>
              <button
                className={`sensitivity-btn ${settings.vadSensitivity === 'High' || toWireFormat(settings.vadSensitivity) === 'high' ? 'active' : ''}`}
                onClick={() => onSettingsChange({
                  ...settings,
                  vadSensitivity: 'High'
                })}
              >
                High
              </button>
            </div>
            <div className="sensitivity-note">
              Low = More sensitive (detects quieter speech)
            </div>
          </div>
        )}
      </div>
      
      {!isInCall && (
        <div className="settings-note">
          These settings will be applied when you join a call
        </div>
      )}
    </div>
  );
};