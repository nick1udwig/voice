import { useState, useEffect } from "react";
import { BrowserRouter as Router, Routes, Route, useNavigate, useParams } from "react-router-dom";
import HyperwareClientApi from "@hyperware-ai/client-api";
import "./App.css";
import { SplashScreen } from "./components/SplashScreen";
import { CallScreenWrapper } from "./components/CallScreenWrapper";
import { useVoiceStore } from "./store/voice";

const BASE_URL = import.meta.env.BASE_URL;
if (window.our) window.our.process = BASE_URL?.replace("/", "");

const PROXY_TARGET = `${(import.meta.env.VITE_NODE_URL || "http://localhost:8080")}${BASE_URL}`;

const WEBSOCKET_URL = `${window.location.protocol.replace('http', 'ws')}//${window.location.host}${BASE_URL}/ws`;

function AppContent() {
  const navigate = useNavigate();
  const { setApi, setNodeConnected } = useVoiceStore();

  useEffect(() => {
    // Check if we have an auth token from a node handshake
    const urlParams = new URLSearchParams(window.location.search);
    const authToken = urlParams.get('auth');

    if (authToken) {
      // Store the auth token for authenticated connection
      sessionStorage.setItem('nodeAuthToken', authToken);
    }

    if (window.our?.node && window.our?.process) {
      const api = new HyperwareClientApi({
        uri: WEBSOCKET_URL,
        nodeId: window.our.node,
        processId: window.our.process,
        onOpen: (_event, _api) => {
          setNodeConnected(true);
        },
        onMessage: (json, _api) => {
          try {
            const data = JSON.parse(json);
          } catch (error) {
            console.error("Error parsing WebSocket message", error);
          }
        },
      });

      setApi(api);
    } else {
      // For unauthenticated browser users
      setNodeConnected(false);
    }
  }, [setApi, setNodeConnected]);

  return (
    <Routes>
      <Route path="/" element={<SplashScreen />} />
      <Route path="/:callId" element={<CallScreenWrapper />} />
    </Routes>
  );
}

function App() {
  return (
    <Router basename={BASE_URL}>
      <AppContent />
    </Router>
  );
}

export default App;
