import { create } from 'zustand';
import { CallInfo, ParticipantInfo, ChatMessage, Role } from '../types';
import { joinCall, joinCallUnauthenticated } from '../caller-utils';

interface VoiceStore {
  // Connection state
  nodeConnected: boolean;
  wsConnection: WebSocket | null;
  connectionStatus: 'disconnected' | 'connecting' | 'connected';

  // Call state
  currentCall: CallInfo | null;
  participants: Map<string, ParticipantInfo>;
  chatMessages: ChatMessage[];
  myParticipantId: string | null;
  myRole: Role | null;

  // WebRTC state
  peerConnections: Map<string, RTCPeerConnection>;
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  isMuted: boolean;

  // Actions
  setNodeConnected: (connected: boolean) => void;
  joinCall: (callId: string) => Promise<void>;
  sendChatMessage: (content: string) => void;
  toggleMute: () => void;
  handleWebSocketMessage: (message: any) => void;
}

export const useVoiceStore = create<VoiceStore>((set, get) => ({
  // Initial state
  nodeConnected: true, // Assume connected for in-call UI
  wsConnection: null,
  connectionStatus: 'disconnected',
  currentCall: null,
  participants: new Map(),
  chatMessages: [],
  myParticipantId: null,
  myRole: null,
  peerConnections: new Map(),
  localStream: null,
  remoteStreams: new Map(),
  isMuted: true,

  // Actions
  setNodeConnected: (connected) => set({ nodeConnected: connected }),

  joinCall: async (callId: string) => {
    try {
      // Check if we're authenticated (token exists in localStorage/sessionStorage)
      const nodeAuthToken = sessionStorage.getItem('nodeAuthToken') || localStorage.getItem('nodeAuthToken');
      const isAuthenticated = !!nodeAuthToken;
      
      console.log('joinCall - callId:', callId);
      console.log('joinCall - authenticated:', isAuthenticated);
      
      // Connect to WebSocket first
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const BASE_URL = '/voice:voice:sys';
      const wsUrl = `${wsProtocol}//${window.location.host}${BASE_URL}/ws`;
      console.log('Attempting WebSocket connection to:', wsUrl);
      
      const ws = new WebSocket(wsUrl);
      
      ws.onopen = async () => {
        console.log('WebSocket connected successfully');
        
        if (isAuthenticated && nodeAuthToken) {
          // Case 2: User has a node - use traditional auth flow
          try {
            const result = await joinCall({ callId, nodeAuth: nodeAuthToken });
            console.log('joinCall response:', result);
            
            set({ 
              myParticipantId: result.participantId,
              myRole: result.role,
            });
            
            // Authenticate with the server
            ws.send(JSON.stringify({
              Authenticate: {
                participantId: result.participantId,
                authToken: result.authToken || ""
              }
            }));
          } catch (error) {
            console.error('Failed to join via API:', error);
            ws.close();
            return;
          }
        } else {
          // Case 1: Browser user without node - join directly via WebSocket
          console.log('Joining as unauthenticated browser user');
          ws.send(JSON.stringify({
            JoinCall: {
              callId: callId,
              displayName: null // Let server generate a name
            }
          }));
        }
        
        set({ wsConnection: ws, connectionStatus: 'connected' });
      };
      
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          get().handleWebSocketMessage(message);
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };
      
      ws.onclose = () => {
        set({ wsConnection: null, connectionStatus: 'disconnected' });
      };
      
      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        set({ connectionStatus: 'disconnected' });
      };
    } catch (error) {
      console.error('Failed to join call:', error);
    }
  },

  sendChatMessage: (content: string) => {
    const { wsConnection } = get();
    if (wsConnection?.readyState === WebSocket.OPEN) {
      wsConnection.send(JSON.stringify({ Chat: content }));
    }
  },

  toggleMute: () => {
    const { isMuted, wsConnection } = get();
    const newMuted = !isMuted;
    set({ isMuted: newMuted });
    
    if (wsConnection?.readyState === WebSocket.OPEN) {
      wsConnection.send(JSON.stringify({ Mute: newMuted }));
    }
  },

  handleWebSocketMessage: (message: any) => {
    const { participants, chatMessages } = get();
    console.log('Received WebSocket message:', message);
    
    if ('JoinSuccess' in message) {
      // Handle successful join
      const { participantId, role, participants: initialParticipants, chatHistory } = message.JoinSuccess;
      console.log('Join successful:', { participantId, role });
      
      // Set my participant info
      set({ 
        myParticipantId: participantId,
        myRole: role,
      });
      
      // Set initial participants
      const participantsMap = new Map();
      initialParticipants.forEach((p: any) => {
        participantsMap.set(p.id, p);
      });
      set({ participants: participantsMap });
      
      // Set chat history
      set({ chatMessages: chatHistory || [] });
      
    } else if ('Chat' in message) {
      console.log('Chat message received:', message.Chat);
      set({ chatMessages: [...chatMessages, message.Chat.message] });
    } else if ('ParticipantJoined' in message) {
      const newParticipants = new Map(participants);
      const participant = message.ParticipantJoined.participant;
      newParticipants.set(participant.id, participant);
      set({ participants: newParticipants });
    } else if ('ParticipantLeft' in message) {
      const newParticipants = new Map(participants);
      newParticipants.delete(message.ParticipantLeft);
      set({ participants: newParticipants });
    } else if ('RoleUpdated' in message) {
      const newParticipants = new Map(participants);
      const { participantId, newRole } = message.RoleUpdated;
      const participant = newParticipants.get(participantId);
      if (participant) {
        participant.role = newRole;
        newParticipants.set(participantId, participant);
        set({ participants: newParticipants });
      }
    } else if ('ParticipantMuted' in message) {
      const newParticipants = new Map(participants);
      const { participantId, isMuted } = message.ParticipantMuted;
      const participant = newParticipants.get(participantId);
      if (participant) {
        participant.isMuted = isMuted;
        newParticipants.set(participantId, participant);
        set({ participants: newParticipants });
      }
    } else if ('WebrtcSignal' in message) {
      // TODO: Handle WebRTC signaling
      console.log('WebRTC signal received:', message.WebrtcSignal);
    } else if ('Error' in message) {
      console.error('WebSocket error:', message.Error);
    } else if ('CallEnded' in message) {
      // Reset state and redirect
      set({
        currentCall: null,
        participants: new Map(),
        chatMessages: [],
        myParticipantId: null,
        myRole: null,
        wsConnection: null,
        connectionStatus: 'disconnected'
      });
      window.location.href = '/';
    }
  },
}));