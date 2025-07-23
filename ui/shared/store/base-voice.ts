import { CallInfo, ParticipantInfo, ChatMessage, Role, UserSettings } from '../../../target/ui/caller-utils';
import { AudioServiceV3 } from '../services/audio-service-v3';
import { DEFAULT_SETTINGS, settingsToWire, settingsFromWire } from '../types/settings';
import { notificationSounds } from '../utils/sounds';

export interface BaseVoiceState {
  // Connection state
  wsConnection: WebSocket | null;
  connectionStatus: 'disconnected' | 'connecting' | 'connected';
  isNodeConnection: boolean;
  isAuthenticated: boolean;
  heartbeatInterval: NodeJS.Timeout | null;
  lastHeartbeat: number;

  // Call state
  currentCall: CallInfo | null;
  participants: Map<string, ParticipantInfo>;
  chatMessages: ChatMessage[];
  myParticipantId: string | null;
  myRole: Role | null;
  callEnded: boolean;

  // Audio state
  localStream: MediaStream | null;
  setMediaStream: (stream: MediaStream | null) => void;
  getMediaStream: () => MediaStream | null;
  isMuted: boolean;

  // Audio service
  audioService: AudioServiceV3 | null;
  audioLevels: Map<string, number>;
  speakingStates: Map<string, boolean>;
  
  // Settings
  mySettings: UserSettings;
}

export interface BaseVoiceActions {
  // Core actions
  joinCall: (callId: string, authToken?: string | null, settings?: UserSettings) => Promise<void>;
  leaveCall: () => Promise<void>;
  sendChatMessage: (content: string) => void;
  toggleMute: () => void;
  updateRole: (targetId: string, newRole: Role) => void;
  updateSettings: (settings: UserSettings) => void;
  updateAvatar: (avatarUrl: string | null) => void;
  handleWebSocketMessage: (message: any) => void;
  connectWebSocket: (url: string) => void;
  disconnect: () => void;

  // Audio actions
  initializeAudio: () => void;
  cleanupAudio: () => void;
  handleUserInteraction: () => void;
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
  heartbeatInterval: null,
  lastHeartbeat: Date.now(),
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
  callEnded: false,
  mySettings: settingsFromWire(DEFAULT_SETTINGS),

  // Actions
  joinCall: async (callId: string, authToken?: string | null, settings?: UserSettings) => {
    try {
      const BASE_URL = import.meta.env.BASE_URL;
      if ((window as any).our) (window as any).our.process = BASE_URL?.replace("/", "");

      // Use provided authToken, or fall back to sessionStorage (for backward compatibility)
      const nodeAuthToken = authToken !== undefined ? authToken : sessionStorage.getItem('nodeAuthToken');

      // Connect to WebSocket first
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}${BASE_URL}/ws`;

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        
        // Clear audio decoders on new connection to ensure fresh state
        const audioService = get().audioService;
        if (audioService) {
          audioService.clearDecoders();
        }
        
        set({
          wsConnection: ws,
          connectionStatus: 'connected',
          isNodeConnection: !!nodeAuthToken
        });
        
        // Start heartbeat
        const startHeartbeat = () => {
          // Clear any existing heartbeat
          const existingInterval = get().heartbeatInterval;
          if (existingInterval) {
            clearInterval(existingInterval);
          }
          
          // Send heartbeat every 30 seconds
          const interval = setInterval(() => {
            const currentWs = get().wsConnection;
            if (currentWs && currentWs.readyState === WebSocket.OPEN) {
              currentWs.send(JSON.stringify({ Heartbeat: null }));
              set({ lastHeartbeat: Date.now() });
            } else {
              // Stop heartbeat if connection is lost
              clearInterval(interval);
              set({ heartbeatInterval: null });
            }
          }, 30000);
          
          set({ heartbeatInterval: interval });
        };
        
        startHeartbeat();

        // Get saved avatar URL from localStorage
        const savedAvatarUrl = localStorage.getItem('avatarUrl');
        
        // Send JoinCall message with optional auth token and settings
        const currentSettings = settings || get().mySettings;
        const wireSettings = settingsToWire(currentSettings);
        
        const joinMessage = {
          JoinCall: {
            callId: callId,
            authToken: nodeAuthToken,
            displayName: null,
            settings: wireSettings,
            avatarUrl: savedAvatarUrl
          }
        };

        ws.send(JSON.stringify(joinMessage));
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          get().handleWebSocketMessage(message);
        } catch (e) {
        }
      };

      ws.onerror = (error) => {
      };

      ws.onclose = () => {
        
        // Clean up heartbeat
        const interval = get().heartbeatInterval;
        if (interval) {
          clearInterval(interval);
          set({ heartbeatInterval: null });
        }
        
        // Preserve callEnded state when WebSocket closes
        const currentCallEnded = get().callEnded;
        set({ wsConnection: null, connectionStatus: 'disconnected', isAuthenticated: false, callEnded: currentCallEnded });
      };

      set({ wsConnection: ws, connectionStatus: 'connecting' });

    } catch (error) {
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
    const audioService = get().audioService;
    const isMuted = get().isMuted;
    const ws = get().wsConnection;

    if (audioService) {
      const newMutedState = !isMuted;

      // Update store state FIRST
      set({ isMuted: newMutedState });

      // Then update audio service (now async)
      audioService.toggleMute(newMutedState)
        .then(() => {
        })
        .catch((error: Error) => {
        });
      

      // Send mute state to server
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          Mute: newMutedState
        }));
      } else {
      }
    } else {
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
    }
  },
  
  updateSettings: (settings: UserSettings) => {
    const ws = get().wsConnection;
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Update local state immediately
      set({ mySettings: settings });
      
      // Update audio service VAD settings
      const audioService = get().audioService;
      if (audioService) {
        audioService.updateVadSettings(settings);
      }
      
      // Convert to wire format for backend
      const wireSettings = settingsToWire(settings);
      
      // Send to server
      ws.send(JSON.stringify({
        UpdateSettings: wireSettings
      }));
    } else {
    }
  },
  
  updateAvatar: (avatarUrl: string | null) => {
    const ws = get().wsConnection;
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Send to server
      ws.send(JSON.stringify({
        UpdateAvatar: { avatarUrl: avatarUrl || null }
      }));
    } else {
    }
  },

  handleWebSocketMessage: (message: any) => {

    if (message.ParticipantJoined) {
      const participant = message.ParticipantJoined.participant;
      set((state: BaseVoiceState) => ({
        participants: new Map(state.participants).set(participant.id, participant)
      }));
      
      // Play sound if enabled in settings
      const settings = get().mySettings;
      if (settings.soundOnUserJoin) {
        notificationSounds.playUserJoinSound();
      }
    }

    if (message.ParticipantLeft) {
      const { participantId } = message.ParticipantLeft;
      set((state: BaseVoiceState) => {
        const newParticipants = new Map(state.participants);
        newParticipants.delete(participantId);
        return { participants: newParticipants };
      });
      
      // Play sound if enabled in settings
      const settings = get().mySettings;
      if (settings.soundOnUserLeave) {
        notificationSounds.playUserLeaveSound();
      }
    }

    if (message.Chat) {
      const chatMessage = message.Chat.message;
      set((state: BaseVoiceState) => ({
        chatMessages: [...state.chatMessages, chatMessage]
      }));
      
      // Play sound if enabled and not from ourselves
      const settings = get().mySettings;
      const myId = get().myParticipantId;
      if (settings.soundOnChatMessage && chatMessage.senderId !== myId) {
        notificationSounds.playChatMessageSound();
      }
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
              // Reinitialize audio with new role after state update
              // This will set up audio capture without destroying existing service
              setTimeout(() => get().initializeAudio(), 100);
            } else if (wasSpeaker && isNowNonSpeaker) {
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
      // Find our own participant info to get settings
      const myParticipant = participants.find((p: ParticipantInfo) => p.id === participantId);
      
      set({
        myParticipantId: participantId,
        myRole: role,
        participants: participantsMap,
        chatMessages: chatHistory || [],
        hostId: hostId || null,
        isMuted: true, // Everyone starts muted
        isAuthenticated: true, // Mark as authenticated after JoinSuccess
        mySettings: myParticipant?.settings ? 
          settingsFromWire(myParticipant.settings) : 
          settingsFromWire(DEFAULT_SETTINGS),
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

    // Handle speaking state updates from VAD
    if (message.SpeakingStateUpdated) {
      const { participantId, isSpeaking } = message.SpeakingStateUpdated;
      set((state: BaseVoiceState) => {
        const newSpeakingStates = new Map(state.speakingStates);
        newSpeakingStates.set(participantId, isSpeaking);
        return { speakingStates: newSpeakingStates };
      });
    }
    
    // Handle avatar updates
    if (message.AvatarUpdated) {
      const { participantId, avatarUrl } = message.AvatarUpdated;
      set((state: BaseVoiceState) => {
        const participant = state.participants.get(participantId);
        if (participant) {
          const updatedParticipant = { ...participant, avatarUrl };
          const newParticipants = new Map(state.participants);
          newParticipants.set(participantId, updatedParticipant);
          return { participants: newParticipants };
        }
        return state;
      });
    }

    // Handle error messages
    if (message.Error) {
      // You might want to show this error to the user in a notification
      // For now, just log it
    }

    // Handle call ended
    if (message === 'CallEnded' || message.CallEnded) {
      // Set call ended state to show the screen
      set({ callEnded: true });
      
      // Clean up audio first
      get().cleanupAudio();

      // Don't redirect immediately - let user see the call ended screen
    }

    // Handle close connection request from server
    if (message === 'CloseConnection' || message.CloseConnection) {
      // Set callEnded to true to show the Call Ended screen
      set({ callEnded: true });
      
      const ws = get().wsConnection;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    
    // Handle settings updates
    if (message.SettingsUpdated) {
      const { participantId, settings } = message.SettingsUpdated;
      
      // Update our own settings if it's for us
      if (participantId === get().myParticipantId) {
        // Convert from wire format
        const convertedSettings = settingsFromWire(settings);
        set({ mySettings: convertedSettings });
      }
      
      // Update participant info in the participants map
      set((state: BaseVoiceState) => {
        const participant = state.participants.get(participantId);
        if (participant) {
          const newParticipants = new Map(state.participants);
          newParticipants.set(participantId, { ...participant, settings });
          return { participants: newParticipants };
        }
        return state;
      });
    }
  },

  connectWebSocket: (url: string) => {
    const ws = new WebSocket(url);

    ws.onopen = () => {
      
      // Clear audio decoders on new connection to ensure fresh state
      const audioService = get().audioService;
      if (audioService) {
        console.log('[VoiceStore] Clearing audio decoders on new WebSocket connection');
        audioService.clearDecoders();
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

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      // Preserve callEnded state when WebSocket closes
      const currentCallEnded = get().callEnded;
      set({ wsConnection: null, connectionStatus: 'disconnected', callEnded: currentCallEnded });
    };

    set({ wsConnection: ws, connectionStatus: 'connecting' });
  },

  leaveCall: async () => {
    const state = get();
    if (!state.currentCall || !state.myParticipantId) {
      return;
    }

    // Show call ended screen for the user who clicked Leave
    set({ callEnded: true });

    // FIRST: Close WebSocket connection immediately to prevent race conditions
    const ws = state.wsConnection;
    if (ws) {
      ws.close();
      // Clear the connection state immediately
      set({ wsConnection: null, connectionStatus: 'disconnected', isAuthenticated: false });
    }

    // Clean up audio immediately to stop any ongoing streams
    get().cleanupAudio();

    try {
      // Import the API function
      const { leaveCall: leaveCallApi } = await import('../../../target/ui/caller-utils');
      
      // Call the leave API
      await leaveCallApi({
        callId: state.currentCall.id,
        participantId: state.myParticipantId
      });
      
    } catch (error) {
    }

    // Clean up remaining state but keep callEnded: true
    set({
      currentCall: null,
      participants: new Map(),
      chatMessages: [],
      myParticipantId: null,
      myRole: null
    });
  },

  disconnect: () => {
    const ws = get().wsConnection;
    if (ws) {
      ws.close();
    }
    
    // Clean up heartbeat
    const interval = get().heartbeatInterval;
    if (interval) {
      clearInterval(interval);
      set({ heartbeatInterval: null });
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
    const store = get();
    
    // Create audio service if it doesn't exist
    let audioService = store.audioService;
    if (!audioService) {
      // Pass a getter function to audio service so it always gets fresh state
      audioService = new AudioServiceV3(get);
      set({ audioService });
    }

    // Initialize audio based on role (even if service already exists - needed for role changes)
    const myRole = store.myRole;
    const myParticipantId = store.myParticipantId;

    if (myRole && myParticipantId && audioService) {
      const isHost = store.hostId === myParticipantId;

      audioService.initializeAudio(myRole, myParticipantId, isHost, store.mySettings)
        .then(() => {
          // Update local stream in store
          const mediaStream = audioService.getMediaStream();
          if (mediaStream) {
            set({ localStream: mediaStream });
          }
        })
        .catch((error: Error) => {
          // Could show a notification to the user about mic permission failure
        });
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
  },
  
  handleUserInteraction: () => {
    const audioService = get().audioService;
    if (audioService) {
      audioService.handleUserInteraction()
        .then(() => {
        })
        .catch((error: Error) => {
        });
    } else {
    }
  }
});
