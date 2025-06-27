import { create } from 'zustand';
import { CallInfo, ParticipantInfo, ChatMessage, Role } from '../../../target/ui/caller-utils';

interface VoiceStore {
  // Connection state
  api: any | null;
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
  setApi: (api: any) => void;
  setNodeConnected: (connected: boolean) => void;
  createCall: (defaultRole: Role) => Promise<void>;
  joinCall: (callId: string) => Promise<void>;
  sendChatMessage: (content: string) => void;
  toggleMute: () => void;
  promoteParticipant: (participantId: string, newRole: Role) => void;
  handleWebSocketMessage: (message: any) => void;
}

export const useVoiceStore = create<VoiceStore>((set, get) => ({
  // Initial state
  api: null,
  nodeConnected: false,
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
  setApi: (api) => set({ api }),
  setNodeConnected: (connected) => set({ nodeConnected: connected }),

  createCall: async (defaultRole: Role) => {
    try {
      const BASE_URL = import.meta.env.BASE_URL || '';
      const response = await fetch(`${BASE_URL}/api/create-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_role: defaultRole }),
      });
      
      if (response.ok) {
        const result = await response.json();
        console.log('createCall response:', result);
        if (result.id) {
          window.location.href = `${BASE_URL}/${result.id}`;
        }
      }
    } catch (error) {
      console.error('Failed to create call:', error);
    }
  },

  joinCall: async (callId: string) => {
    try {
      const BASE_URL = import.meta.env.BASE_URL || '';
      console.log('joinCall - BASE_URL:', BASE_URL);
      console.log('joinCall - callId:', callId);
      const response = await fetch(`${BASE_URL}/api/join-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call_id: callId, node_auth: null }),
      });
      
      if (response.ok) {
        const result = await response.json();
        console.log('joinCall response:', result);
        if (result.participant_id) {
          set({ 
            myParticipantId: result.participant_id,
            myRole: result.role,
          });
          
          // Connect to WebSocket
          const wsUrl = `${window.location.origin.replace('http', 'ws')}${BASE_URL}/ws`;
          console.log('Attempting WebSocket connection to:', wsUrl);
          console.log('BASE_URL:', BASE_URL);
          const ws = new WebSocket(wsUrl);
          
          ws.onopen = () => {
            console.log('WebSocket connected successfully');
            // Authenticate
            ws.send(JSON.stringify({
              Authenticate: {
                participant_id: result.participant_id,
                auth_token: result.auth_token
              }
            }));
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
            console.error('WebSocket readyState:', ws.readyState);
            console.error('WebSocket URL:', ws.url);
            set({ connectionStatus: 'disconnected' });
          };
        }
      }
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

  promoteParticipant: (participantId: string, newRole: Role) => {
    // TODO: Implement role update
    console.log('Promoting participant:', participantId, 'to', newRole);
  },

  handleWebSocketMessage: (message: any) => {
    const { participants, chatMessages } = get();
    
    if ('Chat' in message) {
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
      const { participant_id, new_role } = message.RoleUpdated;
      const participant = newParticipants.get(participant_id);
      if (participant) {
        participant.role = new_role;
        newParticipants.set(participant_id, participant);
        set({ participants: newParticipants });
      }
    } else if ('ParticipantMuted' in message) {
      const newParticipants = new Map(participants);
      const { participant_id, is_muted } = message.ParticipantMuted;
      const participant = newParticipants.get(participant_id);
      if (participant) {
        participant.isMuted = is_muted;
        newParticipants.set(participant_id, participant);
        set({ participants: newParticipants });
      }
    } else if ('WebrtcSignal' in message) {
      // TODO: Handle WebRTC signaling
      console.log('WebRTC signal received:', message.WebrtcSignal);
    } else if ('Error' in message) {
      console.error('WebSocket error:', message.Error);
    } else if ('CallEnded' in message) {
      // Reset state and redirect to home
      set({
        currentCall: null,
        participants: new Map(),
        chatMessages: [],
        myParticipantId: null,
        myRole: null,
        wsConnection: null,
        connectionStatus: 'disconnected'
      });
      window.location.href = import.meta.env.BASE_URL || '/';
    }
  },
}));