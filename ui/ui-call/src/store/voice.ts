import { create } from 'zustand';
import { createBaseVoiceStore, BaseVoiceStore } from '../../../shared/store/base-voice';

export type VoiceStore = BaseVoiceStore;

export const useVoiceStore = create<VoiceStore>((set, get) => createBaseVoiceStore(set, get));