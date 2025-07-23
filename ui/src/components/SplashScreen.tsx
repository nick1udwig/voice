import React, { useState, useEffect } from 'react';
import { useVoiceStore } from '../store/voice';
import { startNodeHandshake, Role, UserSettings } from '../../../target/ui/caller-utils';
import { getHostSettings, updateHostSettings } from '../../shared/api/settings-api';
import { getRoleEmoji } from '../../shared/utils/roleUtils';
import { SettingsModal } from '../../shared/components/SettingsModal';
import { DEFAULT_SETTINGS, settingsFromWire } from '../../shared/types/settings';
import '../../shared/styles/settings.css';

export const SplashScreen: React.FC = () => {
  const [joinLink, setJoinLink] = useState('');
  const [defaultRole, setDefaultRole] = useState<Role>('Chatter');
  const [settings, setSettings] = useState<UserSettings>(
    settingsFromWire(DEFAULT_SETTINGS)
  );
  const [avatarUrl, setAvatarUrl] = useState<string>('');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const { createCall, nodeConnected } = useVoiceStore();
  
  // Load settings from backend when component mounts
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const hostSettings = await getHostSettings();
        setSettings(hostSettings);
        setSettingsLoaded(true);
        
        // Load saved avatar URL from localStorage
        const savedAvatarUrl = localStorage.getItem('avatarUrl');
        if (savedAvatarUrl) {
          setAvatarUrl(savedAvatarUrl);
        }
      } catch (error) {
        console.error('Failed to load host settings:', error);
        // Use defaults if loading fails
        setSettingsLoaded(true);
      }
    };
    loadSettings();
  }, []);
  
  // Save settings to backend when they change
  const handleSettingsChange = async (newSettings: UserSettings) => {
    setSettings(newSettings);
    try {
      await updateHostSettings(newSettings);
    } catch (error) {
      console.error('Failed to save host settings:', error);
      // Could show an error notification here
    }
  };

  const handleCreateCall = async () => {
    // Settings are already stored on backend, just create the call
    await createCall(defaultRole, settings);
  };

  const handleJoin = async () => {
    try {
      const url = await startNodeHandshake(joinLink);
      window.location.href = url;
    } catch (error) {
      alert(`Failed to initiate node handshake: ${error}`);
    }
  };

  if (!nodeConnected) {
    return (
      <div className="splash-container">
        <h2 style={{ color: 'red' }}>Node not connected</h2>
        <p>Please ensure your node is running</p>
      </div>
    );
  }

  return (
    <div className="splash-container">
      <div className="action-section">
        <h2>Host a Call</h2>
        <label>Default role for participants:</label>
        <select
          value={defaultRole}
          onChange={(e) => setDefaultRole(e.target.value as Role)}
          className="role-select"
        >
          <option value="Listener">{getRoleEmoji('Listener')} Listener</option>
          <option value="Chatter">{getRoleEmoji('Chatter')} Chatter</option>
          <option value="Speaker">{getRoleEmoji('Speaker')} Speaker</option>
        </select>
        <button onClick={handleCreateCall} className="primary-button">
          Create New Call
        </button>
      </div>

      <div className="action-section">
        <h2>Join a Call</h2>
        <input
          type="text"
          placeholder="Enter call link or ID"
          value={joinLink}
          onChange={(e) => setJoinLink(e.target.value)}
          className="join-input"
        />
        <button
          onClick={handleJoin}
          disabled={!joinLink}
          className="primary-button"
        >
          Join Call
        </button>
      </div>
      
      <button 
        onClick={() => setShowSettings(true)}
        className="settings-button"
        style={{ marginTop: '2rem' }}
      >
        ⚙️ Settings
      </button>
      
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onSettingsChange={handleSettingsChange}
        onUpdateAvatar={(url) => {
          setAvatarUrl(url || '');
          // Save to localStorage for persistence
          if (url) {
            localStorage.setItem('avatarUrl', url);
          } else {
            localStorage.removeItem('avatarUrl');
          }
        }}
      />
    </div>
  );
};
