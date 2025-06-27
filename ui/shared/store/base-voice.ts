import { CallInfo, ParticipantInfo, ChatMessage, Role, joinCall as joinCallApi, joinCallUnauthenticated } from '../../../target/ui/caller-utils';

export interface BaseVoiceState {
  // Connection state
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
}

export interface BaseVoiceActions {
  // Core actions
  joinCall: (callId: string) => Promise<void>;
  sendChatMessage: (content: string) => void;
  toggleMute: () => void;
  handleWebSocketMessage: (message: any) => void;
  connectWebSocket: (url: string, authToken?: string, participantId?: string) => void;
  disconnect: () => void;
}

export type BaseVoiceStore = BaseVoiceState & BaseVoiceActions;

export const createBaseVoiceStore = (set: any, get: any): BaseVoiceStore => ({
  // Initial state
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
  joinCall: async (callId: string) => {
    try {
      const BASE_URL = '/voice:voice:sys';
      const isAuthenticated = !!(window as any).our?.node;
      const nodeAuthToken = sessionStorage.getItem('nodeAuthToken');
      
      // Connect to WebSocket first
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}${BASE_URL}/ws`;
      console.log('Attempting WebSocket connection to:', wsUrl);
      
      const ws = new WebSocket(wsUrl);
      
      ws.onopen = async () => {
        console.log('WebSocket connected');
        set({ wsConnection: ws, connectionStatus: 'connected' });
        
        if (isAuthenticated && nodeAuthToken) {
          // Case 2: User has a node - use traditional auth flow
          try {
            const result = await joinCallApi({ callId, nodeAuth: nodeAuthToken });
            ws.send(JSON.stringify({
              Authenticate: {
                participantId: result.participantId,
                authToken: result.authToken || ""
              }
            }));
            
            set({ 
              myParticipantId: result.participantId,
              myRole: result.role,
            });
          } catch (error) {
            console.error('Failed to join call with auth:', error);
          }
        } else {
          // Case 1: Browser user without node - join directly via WebSocket
          ws.send(JSON.stringify({
            JoinCall: {
              callId: callId,
              displayName: null
            }
          }));
        }
      };
      
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          get().handleWebSocketMessage(message);
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };
      
      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
      
      ws.onclose = () => {
        console.log('WebSocket disconnected');
        set({ wsConnection: null, connectionStatus: 'disconnected' });
      };
      
      set({ wsConnection: ws, connectionStatus: 'connecting' });
      
    } catch (error) {
      console.error('Failed to join call:', error);
    }
  },

  sendChatMessage: (content: string) => {
    const ws = get().wsConnection;
    const myRole = get().myRole;
    
    if (ws && ws.readyState === WebSocket.OPEN && myRole && ['Chatter', 'Speaker', 'Admin'].includes(myRole)) {
      ws.send(JSON.stringify({
        Chat: content
      }));
    }
  },

  toggleMute: () => {
    const localStream = get().localStream;
    const isMuted = get().isMuted;
    
    if (localStream) {
      localStream.getAudioTracks().forEach((track: MediaStreamTrack) => {
        track.enabled = isMuted; // If currently muted, enable (unmute)
      });
      set({ isMuted: !isMuted });
    }
  },

  handleWebSocketMessage: (message: any) => {
    console.log('WebSocket message:', message);
    
    if (message.ParticipantJoined) {
      const participant = message.ParticipantJoined.participant;
      set((state: BaseVoiceState) => ({
        participants: new Map(state.participants).set(participant.id, participant)
      }));
    }
    
    if (message.ParticipantLeft) {
      const { participantId } = message.ParticipantLeft;
      set((state: BaseVoiceState) => {
        const newParticipants = new Map(state.participants);
        newParticipants.delete(participantId);
        return { participants: newParticipants };
      });
    }
    
    if (message.Chat) {
      const chatMessage = message.Chat.message;
      set((state: BaseVoiceState) => ({
        chatMessages: [...state.chatMessages, chatMessage]
      }));
    }
    
    if (message.RoleUpdated) {
      const { participantId, newRole } = message.RoleUpdated;
      set((state: BaseVoiceState) => {
        const participant = state.participants.get(participantId);
        if (participant) {
          const newParticipants = new Map(state.participants);
          newParticipants.set(participantId, { ...participant, role: newRole });
          
          // Update own role if it's the current user
          if (participantId === state.myParticipantId) {
            return { 
              participants: newParticipants,
              myRole: newRole
            };
          }
          
          return { participants: newParticipants };
        }
        return state;
      });
    }

    // Special handling for ui-call JoinSuccess message
    if (message.JoinSuccess) {
      const { participantId, role, participants, chatHistory } = message.JoinSuccess;
      const participantsMap = new Map();
      participants.forEach((p: ParticipantInfo) => {
        participantsMap.set(p.id, p);
      });
      
      set({
        myParticipantId: participantId,
        myRole: role,
        participants: participantsMap,
        chatMessages: chatHistory || []
      });
    }
  },

  connectWebSocket: (url: string, authToken?: string, participantId?: string) => {
    const ws = new WebSocket(url);
    
    ws.onopen = () => {
      console.log('WebSocket connected');
      set({ wsConnection: ws, connectionStatus: 'connected' });
      
      // Send authentication if we have tokens
      if (authToken && participantId) {
        ws.send(JSON.stringify({
          Authenticate: {
            participantId: participantId,
            authToken: authToken
          }
        }));
      }
    };
    
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        get().handleWebSocketMessage(message);
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };
    
    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    
    ws.onclose = () => {
      console.log('WebSocket disconnected');
      set({ wsConnection: null, connectionStatus: 'disconnected' });
    };
    
    set({ wsConnection: ws, connectionStatus: 'connecting' });
  },

  disconnect: () => {
    const ws = get().wsConnection;
    if (ws) {
      ws.close();
    }
    set({
      wsConnection: null,
      connectionStatus: 'disconnected',
      currentCall: null,
      participants: new Map(),
      chatMessages: [],
      myParticipantId: null,
      myRole: null
    });
  }
});