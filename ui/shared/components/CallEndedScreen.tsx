import React from 'react';
import '../styles/call-ended-screen.css';

export const CallEndedScreen: React.FC = () => {
  return (
    <div className="call-ended-screen">
      <div className="call-ended-content">
        <h1>Call Ended</h1>
        <p>The call has ended. Thank you for participating!</p>
      </div>
    </div>
  );
};