import React from 'react'
import ReactDOM from 'react-dom/client'
import { CallScreen } from './components/CallScreen'
import './index.css'

// Get the call ID from the window object (set by the backend)
declare global {
  interface Window {
    VOICE_CALL_ID?: string;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CallScreen />
  </React.StrictMode>,
)