import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVoiceStore } from '../store/voice';
import { Role } from '../../../target/ui/caller-utils';

export const SplashScreen: React.FC = () => {
  const navigate = useNavigate();
  const [joinLink, setJoinLink] = useState('');
  const [defaultRole, setDefaultRole] = useState<Role>('Chatter');
  const { createCall, nodeConnected } = useVoiceStore();

  const handleCreateCall = async () => {
    await createCall(defaultRole);
  };

  const handleJoin = async () => {
    // Check if it's a full URL with our process path
    if (joinLink.includes('/voice:voice:sys/call/')) {
      // This is a full URL that needs node handshake
      const response = await fetch(`${import.meta.env.BASE_URL}/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ StartNodeHandshake: joinLink })
      });
      
      if (response.ok) {
        const result = await response.json();
        if (result.Ok) {
          // Redirect to the URL returned by the backend
          window.location.href = result.Ok;
        } else {
          alert(`Failed to join: ${result.Err}`);
        }
      } else {
        alert('Failed to initiate node handshake');
      }
    } else {
      // Treat as regular call ID
      const callId = joinLink.includes('/') 
        ? joinLink.split('/').pop() || joinLink
        : joinLink;
      
      if (callId) {
        navigate(`/${callId}`);
      }
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