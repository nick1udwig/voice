import React, { useState } from 'react';
import { useVoiceStore } from '../store/voice';
import { startNodeHandshake, Role, UserSettings } from '../../../target/ui/caller-utils';
import { getRoleEmoji } from '../../shared/utils/roleUtils';
import { SettingsPanel } from '../../shared/components/SettingsPanel';
import { DEFAULT_SETTINGS } from '../../shared/types/settings';
import '../../shared/styles/settings.css';

export const SplashScreen: React.FC = () => {
  const [joinLink, setJoinLink] = useState('');
  const [defaultRole, setDefaultRole] = useState<Role>('Chatter');
  const [settings, setSettings] = useState<UserSettings>({ ...DEFAULT_SETTINGS });
  const [showSettings, setShowSettings] = useState(false);
  const { createCall, nodeConnected } = useVoiceStore();

  const handleCreateCall = async () => {
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
      <h1>Voice Call System</h1>

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
      
      <div className="action-section">
        <button 
          onClick={() => setShowSettings(!showSettings)}
          className="settings-button"
        >
          {showSettings ? 'Hide Settings' : 'Show Settings'}
        </button>
        
        {showSettings && (
          <SettingsPanel 
            settings={settings}
            onSettingsChange={setSettings}
            isInCall={false}
          />
        )}
      </div>
    </div>
  );
};
