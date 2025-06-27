import { create } from 'zustand';
import { createBaseVoiceStore, BaseVoiceStore, BaseVoiceState } from '../../shared/store/base-voice';
import { Role, createCall as createCallApi, joinCall as joinCallApi } from '../../../target/ui/caller-utils';
// HyperwareClientApi type - using 'any' for now since the exact type isn't critical
type HyperwareClientApi<T> = any;

interface ExtendedVoiceState extends BaseVoiceState {
  api: HyperwareClientApi<Record<string, unknown>> | null;
  nodeConnected: boolean;
}

interface ExtendedVoiceActions {
  setApi: (api: HyperwareClientApi<Record<string, unknown>>) => void;
  setNodeConnected: (connected: boolean) => void;
  createCall: (defaultRole: Role) => Promise<void>;
  joinCall: (callId: string, displayName?: string) => Promise<void>;
}

export type VoiceStore = ExtendedVoiceState & ExtendedVoiceActions & BaseVoiceStore;

export const useVoiceStore = create<VoiceStore>((set, get) => ({
  // Base store functionality
  ...createBaseVoiceStore(set, get),
  
  // Extended state
  api: null,
  nodeConnected: false,

  // Extended actions
  setApi: (api) => set({ api }),
  setNodeConnected: (connected) => set({ nodeConnected: connected }),

  createCall: async (defaultRole: Role = 'Speaker') => {
    try {
      const BASE_URL = import.meta.env.BASE_URL || '';
      
      try {
        const result = await createCallApi({ defaultRole });
        console.log('createCall response:', result);
        
        // Store a special token to indicate this user is the host
        sessionStorage.setItem('isHost', 'true');
        sessionStorage.setItem('hostCallId', result.id);
        
        window.location.href = `${BASE_URL}/${result.id}`;
      } catch (error) {
        console.error('Create call error:', error);
      }
    } catch (error) {
      console.error('Failed to create call:', error);
    }
  },

  joinCall: async (callId: string, displayName?: string) => {
    // Override base joinCall to use the correct BASE_URL from env
    try {
      const BASE_URL = import.meta.env.BASE_URL || '';
      const isAuthenticated = !!(window as any).our?.node;
      const nodeAuthToken = sessionStorage.getItem('nodeAuthToken');
      const isHost = sessionStorage.getItem('isHost') === 'true' && sessionStorage.getItem('hostCallId') === callId;
      
      console.log('joinCall - BASE_URL:', BASE_URL);
      console.log('joinCall - callId:', callId);
      console.log('joinCall - authenticated:', isAuthenticated);
      console.log('joinCall - nodeAuthToken:', nodeAuthToken);
      console.log('joinCall - isHost:', isHost);
      
      // Connect to WebSocket
      const wsUrl = `${window.location.origin.replace('http', 'ws')}${BASE_URL}/ws`;
      console.log('Attempting WebSocket connection to:', wsUrl);
      
      const ws = new WebSocket(wsUrl);
      
      ws.onopen = async () => {
        console.log('WebSocket connected');
        set({ wsConnection: ws, connectionStatus: 'connected' });
        
        if (isAuthenticated && (nodeAuthToken || isHost)) {
          // Case 2: User has a node - use traditional auth flow
          try {
            const result = await joinCallApi({ callId, nodeAuth: nodeAuthToken });
            ws.send(JSON.stringify({
              Authenticate: {
                participantId: result.participantId,
                authToken: result.authToken || "",
                displayName: displayName || null
              }
            }));
            
            set({ 
              myParticipantId: result.participantId,
              myRole: result.role,
            });
            
            // Clear host flag after joining
            if (isHost) {
              sessionStorage.removeItem('isHost');
              sessionStorage.removeItem('hostCallId');
            }
          } catch (error) {
            console.error('Failed to join call with auth:', error);
          }
        } else {
          // Case 1: Browser user without node - join directly via WebSocket
          ws.send(JSON.stringify({
            JoinCall: {
              callId: callId,
              displayName: displayName || null
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
  }
}));