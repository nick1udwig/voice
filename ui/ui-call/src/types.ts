// Type definitions for the voice call application

export type Role = 'Listener' | 'Chatter' | 'Speaker' | 'Admin';

export interface CallInfo {
  id: string;
  createdAt: number;
  defaultRole: Role;
  participantCount: number;
}

export interface ParticipantInfo {
  id: string;
  displayName: string;
  role: Role;
  joinedAt: number;
  isMuted: boolean;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: number;
}