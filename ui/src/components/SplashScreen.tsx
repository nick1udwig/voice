import React, { useState } from 'react';
import { useVoiceStore } from '../store/voice';
import { startNodeHandshake, Role } from '../../../target/ui/caller-utils';

export const SplashScreen: React.FC = () => {
  const [joinLink, setJoinLink] = useState('');
  const [defaultRole, setDefaultRole] = useState<Role>('Chatter');
  const { createCall, nodeConnected } = useVoiceStore();

  const handleCreateCall = async () => {
    await createCall(defaultRole);
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
        <select
          value={defaultRole}
          onChange={(e) => setDefaultRole(e.target.value as Role)}
          className="role-select"
        >
          <option value="Listener">Listener (default)</option>
          <option value="Chatter">Chatter (default)</option>
          <option value="Speaker">Speaker (default)</option>
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
    </div>
  );
};
