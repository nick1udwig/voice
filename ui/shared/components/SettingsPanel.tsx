import React from 'react';
import { UserSettings } from '../../../target/ui/caller-utils';

interface SettingsPanelProps {
  settings: UserSettings;
  onSettingsChange: (settings: UserSettings) => void;
  isInCall?: boolean;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ 
  settings, 
  onSettingsChange,
  isInCall = false 
}) => {
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
      
      {!isInCall && (
        <div className="settings-note">
          These settings will be applied when you join a call
        </div>
      )}
    </div>
  );
};