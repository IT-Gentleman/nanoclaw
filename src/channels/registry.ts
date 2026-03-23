import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { JobEntry } from '../ipc.js';
export type { JobEntry };

export interface SessionInfo {
  sessionId: string;
  sizeBytes: number;
  modifiedAt: Date;
  isCurrent: boolean;
  preview?: string;
}

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Stop the active container for a chat. Returns true if something was stopped. */
  onStop?: (chatJid: string) => boolean;
  /** Clear session for a chat so next message starts a fresh session. */
  onNewSession?: (chatJid: string) => void;
  /** List all saved sessions for a chat's group, most recent first. */
  onListSessions?: (chatJid: string) => SessionInfo[];
  /** Switch the active session for a chat. Returns true on success. */
  onSwitchSession?: (chatJid: string, sessionId: string) => boolean;
  /** Mark a session as isolated (hidden from list). */
  onHideSession?: (chatJid: string, sessionId: string) => void;
  /** Get the last known input token count for the current session (from SDK result). */
  onGetContextTokens?: (chatJid: string) => number | undefined;
  /** Get token usage summary since a given date. */
  onGetUsage?: (
    chatJid: string,
    since: Date,
  ) => import('../db.js').UsageSummary | null;
  /** Compact the current session context. Returns pre/post token counts. */
  onCompact?: (
    chatJid: string,
  ) => Promise<{ preTokens?: number; postTokens?: number }>;
  /** Compact the current session then switch to a new model. */
  onCompactAndSwitch?: (
    chatJid: string,
    modelId: string | null,
  ) => Promise<{ preTokens?: number; postTokens?: number }>;
  /** Called when user confirms job selection from InlineKeyboard. */
  onJobConfirm?: (
    chatJid: string,
    selectedJobs: JobEntry[],
    skippedJobs: JobEntry[],
  ) => Promise<void>;
  /** List scheduled tasks visible to a given chat. */
  onListTasks?: (chatJid: string) => import('../types.js').ScheduledTask[];
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
