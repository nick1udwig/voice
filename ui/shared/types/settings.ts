export interface UserSettings {
  // Sound notifications
  soundOnUserJoin: boolean;
  soundOnUserLeave: boolean;
  soundOnChatMessage: boolean;
  
  // Chat features
  showImagesInChat: boolean;
  
  // Future settings can be added here
  // audioQuality?: 'low' | 'medium' | 'high';
  // theme?: 'light' | 'dark';
}

export const DEFAULT_SETTINGS: UserSettings = {
  soundOnUserJoin: false,
  soundOnUserLeave: false,
  soundOnChatMessage: false,
  showImagesInChat: false,
};