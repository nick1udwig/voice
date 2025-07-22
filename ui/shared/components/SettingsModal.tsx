import React from 'react';
import { UserSettings } from '../../../target/ui/caller-utils';
import { SettingsPanel } from './SettingsPanel';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: UserSettings;
  onSettingsChange: (settings: UserSettings) => void;
  onUpdateAvatar?: (avatarUrl: string | null) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  onUpdateAvatar
}) => {
  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="settings-modal" onClick={handleBackdropClick}>
      <div className="settings-modal-content">
        <button className="settings-modal-close" onClick={onClose}>
          ×
        </button>
        <SettingsPanel
          settings={settings}
          onSettingsChange={onSettingsChange}
          isInCall={true}
          onUpdateAvatar={onUpdateAvatar}
        />
      </div>
    </div>
  );
};