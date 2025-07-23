// Import the generated types
import type { UserSettings, VadSensitivity } from '../../../target/ui/caller-utils';
export type { UserSettings, VadSensitivity } from '../../../target/ui/caller-utils';

// Backend expects lowercase, but TypeScript generates PascalCase
// Create a mapped type for the wire format
export type VadSensitivityWire = 'low' | 'medium' | 'high';

// Helper functions to convert between formats
export function toWireFormat(sensitivity: VadSensitivity | string): VadSensitivityWire {
  return sensitivity.toLowerCase() as VadSensitivityWire;
}

export function fromWireFormat(sensitivity: VadSensitivityWire | string): VadSensitivity {
  const lower = sensitivity.toLowerCase();
  return (lower.charAt(0).toUpperCase() + lower.slice(1)) as VadSensitivity;
}

// Convert full settings object to wire format
export function settingsToWire(settings: UserSettings): UserSettingsWire {
  return {
    ...settings,
    vadSensitivity: toWireFormat(settings.vadSensitivity)
  };
}

// Convert wire format to TypeScript types
export function settingsFromWire(settings: any): UserSettings {
  return {
    ...settings,
    vadSensitivity: fromWireFormat(settings.vadSensitivity || 'medium')
  };
}

// Settings type that matches wire format
export interface UserSettingsWire extends Omit<UserSettings, 'vadSensitivity'> {
  vadSensitivity: VadSensitivityWire;
}

export const DEFAULT_SETTINGS: UserSettingsWire = {
  soundOnUserJoin: false,
  soundOnUserLeave: false,
  soundOnChatMessage: false,
  showImagesInChat: false,
  showAvatars: false,
  vadAdaptive: true,
  vadSensitivity: 'medium',
};