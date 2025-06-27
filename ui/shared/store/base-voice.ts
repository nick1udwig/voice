import { CallInfo, ParticipantInfo, ChatMessage, Role } from '../../../target/ui/caller-utils';

export interface BaseVoiceState {
  // Connection state
  wsConnection: WebSocket | null;
  connectionStatus: 'disconnected' | 'connecting' | 'connected';
  isNodeConnection: boolean;

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
  joinCall: (callId: string, authToken?: string | null) => Promise<void>;
  sendChatMessage: (content: string) => void;
  toggleMute: () => void;
  handleWebSocketMessage: (message: any) => void;
  connectWebSocket: (url: string) => void;
  disconnect: () => void;
}

export type BaseVoiceStore = BaseVoiceState & BaseVoiceActions;

export const createBaseVoiceStore = (set: any, get: any): BaseVoiceStore => ({
  // Initial state
  wsConnection: null,
  connectionStatus: 'disconnected',
  isNodeConnection: false,
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
  joinCall: async (callId: string, authToken?: string | null) => {
    try {
      const BASE_URL = import.meta.env.BASE_URL;
      if ((window as any).our) (window as any).our.process = BASE_URL?.replace("/", "");
      
      // Use provided authToken, or fall back to sessionStorage (for backward compatibility)
      const nodeAuthToken = authToken !== undefined ? authToken : sessionStorage.getItem('nodeAuthToken');

      // Connect to WebSocket first
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}${BASE_URL}/ws`;
      console.log('Attempting WebSocket connection to:', wsUrl);

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('WebSocket connected');
        set({
          wsConnection: ws,
          connectionStatus: 'connected',
          isNodeConnection: !!nodeAuthToken
        });

        console.log(`joining with auth token ${nodeAuthToken}`);
        // Send JoinCall message with optional auth token
        const joinMessage = {
          JoinCall: {
            callId: callId,
            authToken: nodeAuthToken,
            displayName: null
          }
        };

        console.log('Sending JoinCall message:', joinMessage);
        ws.send(JSON.stringify(joinMessage));
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
      const { participantId, role, participants, chatHistory, authToken } = message.JoinSuccess;
      const participantsMap = new Map();
      participants.forEach((p: ParticipantInfo) => {
        participantsMap.set(p.id, p);
      });

      // Store auth token for future WebSocket messages if needed
      if (authToken) {
        sessionStorage.setItem('wsAuthToken', authToken);
      }

      set({
        myParticipantId: participantId,
        myRole: role,
        participants: participantsMap,
        chatMessages: chatHistory || []
      });
    }
  },

  connectWebSocket: (url: string) => {
    const ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('WebSocket connected');
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
