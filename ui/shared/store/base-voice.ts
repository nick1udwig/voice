import { CallInfo, ParticipantInfo, ChatMessage, Role } from '../../../target/ui/caller-utils';
import { AudioServiceV3 } from '../services/audio-service-v3';

export interface BaseVoiceState {
  // Connection state
  wsConnection: WebSocket | null;
  connectionStatus: 'disconnected' | 'connecting' | 'connected';
  isNodeConnection: boolean;
  isAuthenticated: boolean;

  // Call state
  currentCall: CallInfo | null;
  participants: Map<string, ParticipantInfo>;
  chatMessages: ChatMessage[];
  myParticipantId: string | null;
  myRole: Role | null;

  // Audio state
  localStream: MediaStream | null;
  setMediaStream: (stream: MediaStream | null) => void;
  getMediaStream: () => MediaStream | null;
  isMuted: boolean;

  // Audio service
  audioService: AudioServiceV3 | null;
  audioLevels: Map<string, number>;
  speakingStates: Map<string, boolean>;
}

export interface BaseVoiceActions {
  // Core actions
  joinCall: (callId: string, authToken?: string | null) => Promise<void>;
  leaveCall: () => Promise<void>;
  sendChatMessage: (content: string) => void;
  toggleMute: () => void;
  updateRole: (targetId: string, newRole: Role) => void;
  handleWebSocketMessage: (message: any) => void;
  connectWebSocket: (url: string) => void;
  disconnect: () => void;

  // Audio actions
  initializeAudio: () => void;
  cleanupAudio: () => void;
}

export type BaseVoiceStore = BaseVoiceState & BaseVoiceActions;

export const createBaseVoiceStore = (set: any, get: any): BaseVoiceStore => ({
  // Helper methods for media stream
  setMediaStream: (stream: MediaStream | null) => set({ localStream: stream }),
  getMediaStream: () => get().localStream,
  // Initial state
  wsConnection: null,
  connectionStatus: 'disconnected',
  isNodeConnection: false,
  isAuthenticated: false,
  currentCall: null,
  participants: new Map(),
  chatMessages: [],
  myParticipantId: null,
  myRole: null,
  localStream: null,
  isMuted: true,
  audioService: null,
  audioLevels: new Map(),
  speakingStates: new Map(),

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
        console.log('WebSocket connected, ws object:', ws);
        set({
          wsConnection: ws,
          connectionStatus: 'connected',
          isNodeConnection: !!nodeAuthToken
        });
        
        // Update audio service with the connected WebSocket
        const audioService = get().audioService;
        if (audioService) {
          audioService.setWebSocket(ws);
        }

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
        set({ wsConnection: null, connectionStatus: 'disconnected', isAuthenticated: false });
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
    console.log('[VoiceStore] Toggle mute called');
    const audioService = get().audioService;
    const isMuted = get().isMuted;
    const ws = get().wsConnection;
    console.log('[VoiceStore] Current state - isMuted:', isMuted, 'audioService:', !!audioService, 'ws:', !!ws, 'ws.readyState:', ws?.readyState);

    if (audioService) {
      const newMutedState = !isMuted;
      console.log('[VoiceStore] Changing mute state from', isMuted, 'to', newMutedState);

      // Update store state FIRST
      set({ isMuted: newMutedState });

      // Then update audio service
      audioService.toggleMute(newMutedState);
      
      // Verify the state was updated
      const verifyMuted = get().isMuted;
      console.log('[VoiceStore] Verified mute state after update:', verifyMuted);

      // Send mute state to server
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('[VoiceStore] Sending mute state to server:', newMutedState);
        ws.send(JSON.stringify({
          Mute: newMutedState
        }));
      } else {
        console.warn('[VoiceStore] Cannot send mute state - WebSocket not ready. State:', ws?.readyState);
      }
    } else {
      console.error('[VoiceStore] No audio service available for mute toggle');
    }
  },

  updateRole: (targetId: string, newRole: Role) => {
    const ws = get().wsConnection;
    const myRole = get().myRole;

    if (ws && ws.readyState === WebSocket.OPEN && myRole === 'Admin') {
      ws.send(JSON.stringify({
        UpdateRole: {
          targetId,
          newRole
        }
      }));
    } else {
      console.error('[VoiceStore] Cannot update role - not connected or not admin');
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
            const oldRole = state.myRole;
            
            // Check if we're being promoted from a non-speaking to speaking role
            const wasNonSpeaker = oldRole && ['Listener', 'Chatter'].includes(oldRole);
            const isNowSpeaker = ['Speaker', 'Admin'].includes(newRole);
            const wasSpeaker = oldRole && ['Speaker', 'Admin'].includes(oldRole);
            const isNowNonSpeaker = ['Listener', 'Chatter'].includes(newRole);
            
            if (wasNonSpeaker && isNowSpeaker) {
              console.log('[VoiceStore] Promoted from non-speaker to speaker, reinitializing audio');
              // Reinitialize audio with new role after state update
              // This will set up audio capture without destroying existing service
              setTimeout(() => get().initializeAudio(), 100);
            } else if (wasSpeaker && isNowNonSpeaker) {
              console.log('[VoiceStore] Demoted from speaker to non-speaker, reinitializing audio');
              // Reinitialize audio with new role after state update
              // This will stop recording but keep playback
              setTimeout(() => get().initializeAudio(), 100);
            }
            
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
      console.log('[VoiceStore] Received JoinSuccess, marking as authenticated');
      const { participantId, role, participants, chatHistory, authToken, hostId } = message.JoinSuccess;
      const participantsMap = new Map();
      participants.forEach((p: ParticipantInfo) => {
        participantsMap.set(p.id, p);
      });

      // Store auth token for future WebSocket messages if needed
      if (authToken) {
        sessionStorage.setItem('wsAuthToken', authToken);
      }

      // Get call ID from the JoinCall message we sent (stored in closure or from URL)
      const callId = window.location.pathname.split('/').pop() || '';

      // Set initial mute state - everyone starts muted
      
      set({
        myParticipantId: participantId,
        myRole: role,
        participants: participantsMap,
        chatMessages: chatHistory || [],
        hostId: hostId || null,
        isMuted: true, // Everyone starts muted
        isAuthenticated: true, // Mark as authenticated after JoinSuccess
        currentCall: {
          id: callId,
          createdAt: Date.now(),
          participantCount: participants.length,
          defaultRole: 'Speaker' // We don't have this info, using default
        }
      });

      // Initialize audio after successful join
      get().initializeAudio();
    }

    // Handle incoming audio data
    if (message.AudioData) {
      console.log('[VoiceStore] Received AudioData from:', message.AudioData.participantId);
      const audioService = get().audioService;
      if (audioService) {
        audioService.handleIncomingAudio(message.AudioData.participantId, message.AudioData)
          .catch((error: Error) => console.error('[VoiceStore] Failed to handle incoming audio:', error));
      } else {
        console.error('[VoiceStore] No audio service available to handle incoming audio');
      }
    }

    // Handle mute state updates
    if (message.ParticipantMuted) {
      const { participantId, isMuted } = message.ParticipantMuted;
      set((state: BaseVoiceState) => {
        const participant = state.participants.get(participantId);
        if (participant) {
          const newParticipants = new Map(state.participants);
          newParticipants.set(participantId, { ...participant, isMuted });
          return { participants: newParticipants };
        }
        return state;
      });
    }

    // Handle error messages
    if (message.Error) {
      console.error('[VoiceStore] Server error:', message.Error);
      // You might want to show this error to the user in a notification
      // For now, just log it
    }

    // Handle call ended
    if (message.CallEnded) {
      console.log('[VoiceStore] Call ended by host, redirecting to home');
      // Clean up audio first
      get().cleanupAudio();

      // Close WebSocket
      const ws = get().wsConnection;
      if (ws) {
        ws.close();
      }

      // Redirect to home page
      setTimeout(() => {
        window.location.href = '/';
      }, 100);
    }
  },

  connectWebSocket: (url: string) => {
    const ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('WebSocket connected');
      set({ wsConnection: ws, connectionStatus: 'connected' });
      
      // Update audio service with the connected WebSocket
      const audioService = get().audioService;
      if (audioService) {
        audioService.setWebSocket(ws);
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

  leaveCall: async () => {
    const state = get();
    if (!state.currentCall || !state.myParticipantId) {
      console.error('[VoiceStore] Cannot leave call: no active call or participant ID');
      return;
    }

    try {
      // Import the API function
      const { leaveCall: leaveCallApi } = await import('../../../target/ui/caller-utils');
      
      // Call the leave API
      await leaveCallApi({
        callId: state.currentCall.id,
        participantId: state.myParticipantId
      });
      
      console.log('[VoiceStore] Successfully called leave API');
    } catch (error) {
      console.error('[VoiceStore] Failed to call leave API:', error);
    }

    // Always disconnect websocket and clean up, regardless of API call success
    get().disconnect();
  },

  disconnect: () => {
    const ws = get().wsConnection;
    if (ws) {
      ws.close();
    }

    // Clean up audio
    get().cleanupAudio();

    set({
      wsConnection: null,
      connectionStatus: 'disconnected',
      isAuthenticated: false,
      currentCall: null,
      participants: new Map(),
      chatMessages: [],
      myParticipantId: null,
      myRole: null
    });
  },

  initializeAudio: () => {
    console.log('[VoiceStore] Initialize audio called');
    const store = get();
    if (!store.audioService) {
      // Pass a getter function to audio service so it always gets fresh state
      const audioService = new AudioServiceV3(get);
      set({ audioService });
      
      // Set the WebSocket on the audio service
      const ws = get().wsConnection;
      if (ws) {
        audioService.setWebSocket(ws);
      }

      // Initialize audio based on role
      const myRole = store.myRole;
      const myParticipantId = store.myParticipantId;

      if (myRole && myParticipantId) {
        const isHost = store.hostId === myParticipantId;
        console.log('[VoiceStore] Audio init params:', { myRole, myParticipantId, isHost, hostId: store.hostId });

        audioService.initializeAudio(myRole, myParticipantId, isHost)
          .then(() => {
            console.log('[VoiceStore] Audio initialized successfully');
            // Update local stream in store
            const mediaStream = audioService.getMediaStream();
            if (mediaStream) {
              set({ localStream: mediaStream });
            }
          })
          .catch(error => {
            console.error('[VoiceStore] Failed to initialize audio:', error);
            // Could show a notification to the user about mic permission failure
          });
      }
    }
  },

  cleanupAudio: () => {
    const audioService = get().audioService;
    if (audioService) {
      audioService.cleanup();
      set({
        audioService: null,
        localStream: null,
        audioLevels: new Map(),
        speakingStates: new Map()
      });
    }
  }
});
