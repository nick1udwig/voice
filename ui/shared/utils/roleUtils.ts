import { Role } from '../../../target/ui/caller-utils';

export const ROLE_EMOJIS: Record<Role, string> = {
  Admin: '👑',
  Speaker: '🔊',
  Chatter: '⌨️',
  Listener: '👂'
};

export function getRoleEmoji(role: Role | null | undefined): string {
  return role ? ROLE_EMOJIS[role] : ROLE_EMOJIS.Listener;
}

export const ROLE_OPTIONS: Role[] = ['Admin', 'Speaker', 'Chatter', 'Listener'];