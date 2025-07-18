import { create } from 'zustand';
import { createBaseVoiceStore, BaseVoiceStore, BaseVoiceState } from '../../shared/store/base-voice';
import { Role, UserSettings, createCall as createCallApi } from '../../../target/ui/caller-utils';
// HyperwareClientApi type - using 'any' for now since the exact type isn't critical
type HyperwareClientApi<T> = any;

interface ExtendedVoiceState extends BaseVoiceState {
  api: HyperwareClientApi<Record<string, unknown>> | null;
  nodeConnected: boolean;
}

interface ExtendedVoiceActions {
  setApi: (api: HyperwareClientApi<Record<string, unknown>>) => void;
  setNodeConnected: (connected: boolean) => void;
  createCall: (defaultRole: Role, settings?: UserSettings) => Promise<void>;
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

  createCall: async (defaultRole: Role = 'Speaker', settings?: UserSettings) => {
    try {
      const BASE_URL = import.meta.env.BASE_URL || '';
      
      try {
        const result = await createCallApi({ defaultRole });
        console.log('createCall response:', result);
        
        // Store a special token to indicate this user is the host
        sessionStorage.setItem('isHost', 'true');
        sessionStorage.setItem('hostCallId', result.id);
        
        // The host's settings are already stored on backend, but we'll pass them
        // when joining to avoid an extra API call
        if (settings) {
          sessionStorage.setItem('hostSettings', JSON.stringify(settings));
        }
        
        window.location.href = `${BASE_URL}/${result.id}`;
      } catch (error) {
        console.error('Create call error:', error);
      }
    } catch (error) {
      console.error('Failed to create call:', error);
    }
  }
}));