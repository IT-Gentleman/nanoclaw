import dns from 'node:dns';
import fs from 'fs';
import path from 'path';

// IPv6 is unreachable on this system, causing ETIMEDOUT for all Node.js HTTP
// clients (node-fetch, undici). Force IPv4-first DNS resolution.
dns.setDefaultResultOrder('ipv4first');

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
  SessionInfo,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  createTask,
  deleteSession,
  deleteSessionModel,
  getIsolatedSessionIds,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getSessionModel,
  getUsageSummary,
  initDatabase,
  markSessionIsolated,
  recordUsage,
  setRegisteredGroup,
  setRouterState,
  setSession,
  setSessionModel,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher, JobEntry } from './ipc.js';
import { TelegramChannel } from './channels/telegram.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { extractSessionCommand, handleSessionCommand, isSessionCommandAllowed } from './session-commands.js';
import { startSchedulerLoop, triggerTaskNow } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let models: Record<string, string> = {}; // group_folder → user-set model_id
let detectedModels: Record<string, string> = {}; // group_folder → SDK-reported model_id
let lastContextTokens: Record<string, number> = {}; // group_folder → last known input_tokens
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// Assigned once startSchedulerLoop is called; used by onJobConfirm for immediate task triggering.
let schedulerDeps: Parameters<typeof triggerTaskNow>[1] | null = null;

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  for (const [folder, sessionId] of Object.entries(sessions)) {
    const m = getSessionModel(sessionId);
    if (m) models[folder] = m;
  }
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

function getToolEmoji(tool: string): string {
  const map: Record<string, string> = {
    Bash: '⚡',
    Read: '📖',
    Write: '✏️',
    Edit: '✏️',
    Glob: '🔍',
    Grep: '🔍',
    WebSearch: '🌐',
    WebFetch: '🌐',
    Task: '🤖',
    Agent: '🤖',
    TodoWrite: '📝',
  };
  return map[tool] ?? '🔧';
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: TRIGGER_PATTERN,
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) => channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) => runAgent(group, prompt, chatJid, onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => { lastAgentTimestamp[chatJid] = ts; saveState(); },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = TRIGGER_PATTERN.test(msg.content.trim());
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return isMainGroup || !reqTrigger || (hasTrigger && (
          msg.is_from_me ||
          isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())
        ));
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);

  // Progress streaming: lazily create a "처리현황" message on each turn's first tool use,
  // accumulate tool calls as a stack for that turn.
  // "Turn" = one user request → one agent response cycle. Multiple turns can occur
  // within a single container session when subsequent messages are piped to stdin.
  // Typing keepalive pauses between turns (isProcessing=false) and resumes on the
  // next tool use via startTurn() — prevents typing showing during idle/greeting responses.
  const tg = channel as any;
  const hasTgProgress =
    typeof tg.sendProgressMessage === 'function' &&
    typeof tg.updateProgressMessage === 'function';

  const toolHistory: string[] = [];
  let progressMsgId: string | null = null;
  let progressCreating: Promise<string | null> | null = null;
  let turnActive = false;
  // Declared before startTurn/finalizeTurn so closures can reference it.
  let isProcessing = true;

  // Called on first tool use of each turn — creates a fresh progress message and
  // re-enables the typing keepalive (needed when subsequent messages are piped).
  const startTurn = () => {
    if (turnActive) return;
    turnActive = true;
    isProcessing = true;
    toolHistory.length = 0;
    progressCreating = tg
      .sendProgressMessage(chatJid, '⏳ 답변 준비중...')
      .catch(() => null);
    progressCreating!.then((id: string | null) => {
      progressMsgId = id;
      progressCreating = null;
    });
  };

  // Called when a turn ends — updates the header to "답변 준비과정" (was "답변 준비중...")
  // so the tool stack remains visible as a record of what was done, then resets for the next turn.
  // If no tools were used (e.g. simple greeting), deletes the eagerly-created placeholder.
  const finalizeTurn = async () => {
    if (!turnActive) return;
    turnActive = false;
    if (progressCreating) await progressCreating;
    if (progressMsgId) {
      if (toolHistory.length > 0) {
        await tg
          .updateProgressMessage(
            chatJid,
            progressMsgId,
            '🗂️ 답변 준비과정\n' + toolHistory.join('\n'),
          )
          .catch(() => {});
      } else {
        // No tools were used — delete the eagerly-created placeholder
        await tg.deleteProgressMessage(chatJid, progressMsgId).catch(() => {});
      }
      progressMsgId = null;
    }
  };

  // Typing keepalive: Telegram's typing indicator expires after ~5s.
  // isProcessing is false between turns so the interval idles harmlessly.
  const typingKeepalive = setInterval(() => {
    if (isProcessing) channel.setTyping?.(chatJid, true)?.catch(() => {});
  }, 4000);

  // Eagerly start the first turn before container cold start so users see
  // "답변 준비중..." immediately on submission rather than after first tool use.
  if (hasTgProgress) startTurn();

  const onProgress:
    | ((tool: string, preview: string) => Promise<void>)
    | undefined = hasTgProgress
    ? async (tool: string, preview: string) => {
        startTurn(); // 항상 먼저 — 피치드 턴 초기화 포함
        if (progressCreating) await progressCreating;
        if (!progressMsgId) return;
        // mcp__nanoclaw__* 툴은 progress 목록에서 제외 (응답 전달 수단이지 작업 내역 아님)
        if (tool.startsWith('mcp__nanoclaw__')) return;
        const emoji = getToolEmoji(tool);
        const line = preview
          ? `${emoji} ${tool}: \`${preview}\``
          : `${emoji} ${tool}`;
        toolHistory.push(line);
        tg.updateProgressMessage(
          chatJid,
          progressMsgId,
          '📑 답변 준비중...\n' + toolHistory.join('\n'),
        ).catch(() => {});
      }
    : undefined;

  let hadError = false;
  let outputSentToUser = false;
  let output: 'success' | 'error' = 'error';

  try {
    output = await runAgent(
      group,
      prompt,
      chatJid,
      async (result) => {
        // Streaming output callback — called for each agent result
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          logger.info(
            { group: group.name },
            `Agent output: ${raw.length} chars`,
          );
          if (text) {
            await channel.sendMessage(chatJid, text);
            outputSentToUser = true;
          }
          // Only reset idle timer on actual results, not session-update markers (result: null)
          resetIdleTimer();
        }

        if (result.status === 'success') {
          isProcessing = false; // pause typing keepalive until next tool use
          await finalizeTurn();
          queue.notifyIdle(chatJid);
        }

        if (result.status === 'error') {
          hadError = true;
          isProcessing = false;
          await finalizeTurn();
        }
      },
      onProgress,
    );
  } finally {
    isProcessing = false;
    clearInterval(typingKeepalive);
    await channel.setTyping?.(chatJid, false);
    await finalizeTurn();
    if (idleTimer) clearTimeout(idleTimer);
  }

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onProgress?: (tool: string, preview: string) => void | Promise<void>,
  isCompaction?: boolean,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];
  const model = models[group.folder] || undefined;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID, detected model, and usage from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        if (output.usedModel) {
          detectedModels[group.folder] = output.usedModel;
        }
        if (output.inputTokens != null) {
          lastContextTokens[group.folder] = output.inputTokens;
          recordUsage(
            group.folder,
            sessions[group.folder],
            output.usedModel ?? models[group.folder],
            {
              inputTokens: output.inputTokens,
              outputTokens: output.outputTokens ?? 0,
              cacheReadTokens: output.cacheReadTokens ?? 0,
              cacheCreationTokens: output.cacheCreationTokens ?? 0,
              costUsd: output.totalCostUsd ?? 0,
            },
          );
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        isCompaction,
        assistantName: ASSISTANT_NAME,
        model,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
      onProgress,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }
    if (output.usedModel) {
      detectedModels[group.folder] = output.usedModel;
    }
    if (output.inputTokens != null && !wrappedOnOutput) {
      // Only record if wrappedOnOutput didn't already record (streaming mode)
      lastContextTokens[group.folder] = output.inputTokens;
      recordUsage(
        group.folder,
        sessions[group.folder],
        output.usedModel ?? models[group.folder],
        {
          inputTokens: output.inputTokens,
          outputTokens: output.outputTokens ?? 0,
          cacheReadTokens: output.cacheReadTokens ?? 0,
          cacheCreationTokens: output.cacheCreationTokens ?? 0,
          costUsd: output.totalCostUsd ?? 0,
        },
      );
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) => extractSessionCommand(m.content, TRIGGER_PATTERN) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            if (isSessionCommandAllowed(isMainGroup, loopCmdMsg.is_from_me === true)) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

function getSessionPreview(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, 8192);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const text = buf.toString('utf-8');
    // Find last assistant text block
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (
          entry.type === 'assistant' &&
          Array.isArray(entry.message?.content)
        ) {
          for (const block of [...entry.message.content].reverse()) {
            if (
              block.type === 'text' &&
              typeof block.text === 'string' &&
              block.text.trim()
            ) {
              return block.text.trim().slice(0, 60);
            }
          }
        }
      } catch {
        // not valid JSON, skip
      }
    }
  } catch {
    // file unreadable
  }
  return undefined;
}

function listGroupSessions(groupFolder: string): SessionInfo[] {
  const sessionDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
  );
  let files: string[];
  try {
    files = fs.readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const currentSessionId = sessions[groupFolder] || '';
  const isolatedIds = getIsolatedSessionIds(groupFolder);
  const results: SessionInfo[] = [];
  for (const f of files) {
    const sessionId = f.replace('.jsonl', '');
    if (isolatedIds.has(sessionId)) continue;
    const filePath = path.join(sessionDir, f);
    try {
      const stat = fs.statSync(filePath);
      const info: SessionInfo = {
        sessionId,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime,
        isCurrent: sessionId === currentSessionId,
      };
      const preview = getSessionPreview(filePath);
      if (preview) info.preview = preview;
      results.push(info);
    } catch {
      // skip unreadable file
    }
  }
  return results.sort(
    (a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime(),
  );
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    onStop: (chatJid: string) => queue.forceStop(chatJid),
    onNewSession: (chatJid: string) => {
      const group = registeredGroups[chatJid];
      if (!group) return;
      delete sessions[group.folder];
      deleteSession(group.folder);
      delete models[group.folder]; // reset model to SDK default on new session
      logger.info(
        { chatJid, groupFolder: group.folder },
        'Session cleared — next message starts fresh',
      );
    },
    onListSessions: (chatJid: string): SessionInfo[] => {
      const group = registeredGroups[chatJid];
      if (!group) return [];
      return listGroupSessions(group.folder);
    },
    onSwitchSession: (chatJid: string, sessionId: string): boolean => {
      const group = registeredGroups[chatJid];
      if (!group) return false;
      sessions[group.folder] = sessionId;
      setSession(group.folder, sessionId);
      // Restore the model associated with this session
      const m = getSessionModel(sessionId);
      if (m) models[group.folder] = m;
      else delete models[group.folder];
      logger.info(
        { chatJid, groupFolder: group.folder, sessionId, model: m },
        'Session switched',
      );
      return true;
    },
    onHideSession: (chatJid: string, sessionId: string) => {
      const group = registeredGroups[chatJid];
      if (!group) return;
      markSessionIsolated(sessionId, group.folder);
      logger.info({ chatJid, sessionId }, 'Session hidden (isolated)');
    },
    onGetModel: (chatJid: string): string | undefined => {
      const group = registeredGroups[chatJid];
      if (!group) return undefined;
      return models[group.folder] || detectedModels[group.folder];
    },
    onSwitchModel: (chatJid: string, modelId: string | null): boolean => {
      const group = registeredGroups[chatJid];
      if (!group) return false;
      const sessionId = sessions[group.folder];
      if (modelId === null) {
        delete models[group.folder];
        if (sessionId) deleteSessionModel(sessionId);
      } else {
        models[group.folder] = modelId;
        if (sessionId) setSessionModel(sessionId, modelId);
      }
      queue.closeStdin(chatJid);
      logger.info(
        { chatJid, groupFolder: group.folder, modelId },
        'Model switched',
      );
      return true;
    },
    onGetContextTokens: (chatJid: string): number | undefined => {
      const group = registeredGroups[chatJid];
      if (!group) return undefined;
      return lastContextTokens[group.folder];
    },
    onGetUsage: (chatJid: string, since: Date) => {
      const group = registeredGroups[chatJid];
      if (!group) return null;
      return getUsageSummary(group.folder, since);
    },
    onCompact: async (
      chatJid: string,
    ): Promise<{ preTokens?: number; postTokens?: number }> => {
      const group = registeredGroups[chatJid];
      if (!group) return {};
      const preTokens = lastContextTokens[group.folder];
      await runAgent(group, '/compact', chatJid, undefined, undefined, true);
      const postTokens = lastContextTokens[group.folder];
      logger.info({ chatJid, preTokens, postTokens }, 'Compaction complete');
      return { preTokens, postTokens };
    },
    onCompactAndSwitch: async (
      chatJid: string,
      modelId: string | null,
    ): Promise<{ preTokens?: number; postTokens?: number }> => {
      const group = registeredGroups[chatJid];
      if (!group) return {};
      const preTokens = lastContextTokens[group.folder];
      await runAgent(group, '/compact', chatJid, undefined, undefined, true);
      const postTokens = lastContextTokens[group.folder];
      // Switch model after compaction
      const sessionId = sessions[group.folder];
      if (modelId === null) {
        delete models[group.folder];
        if (sessionId) deleteSessionModel(sessionId);
      } else {
        models[group.folder] = modelId;
        if (sessionId) setSessionModel(sessionId, modelId);
      }
      queue.closeStdin(chatJid);
      logger.info(
        { chatJid, modelId, preTokens, postTokens },
        'Compact+switch complete',
      );
      return { preTokens, postTokens };
    },
    onListTasks: (chatJid: string) => {
      const group = registeredGroups[chatJid];
      const tasks = getAllTasks();
      if (group?.isMain) return tasks;
      return tasks.filter((t) => t.chat_jid === chatJid);
    },
    onJobConfirm: async (
      chatJid: string,
      selectedJobs: JobEntry[],
      skippedJobs: JobEntry[],
    ) => {
      const group = registeredGroups[chatJid];
      if (!group) return;

      const channel = findChannel(channels, chatJid);

      const allJobs = [...selectedJobs, ...skippedJobs];
      const maxId =
        allJobs.length > 0 ? Math.max(...allJobs.map((j) => j.id)) : 0;
      const saveLastSeenId = (id: number) => {
        const stateFile = path.join(DATA_DIR, 'job-scraper', 'state.json');
        let current = 0;
        try {
          current =
            JSON.parse(fs.readFileSync(stateFile, 'utf-8')).last_seen_id ?? 0;
        } catch {
          /* no state yet */
        }
        if (id > current) {
          fs.writeFileSync(
            stateFile,
            JSON.stringify({ last_seen_id: id }, null, 2),
          );
        }
      };

      if (selectedJobs.length === 0) {
        if (maxId > 0) saveLastSeenId(maxId);
        if (channel) await channel.sendMessage(chatJid, '⏭ 건너뜀 처리됨');
        return;
      }

      const scrapeLines = selectedJobs
        .map((j) => `- ID ${j.id}: node scraper.mjs fetch-post ${j.id}`)
        .join('\n');

      // Compute next sequence number from host filesystem
      const obsidianMount = group.containerConfig?.additionalMounts?.find(
        (m) =>
          m.containerPath === 'obsidian' ||
          m.containerPath === '/workspace/extra/obsidian',
      );
      let startSeq = 1;
      if (obsidianMount) {
        const listingDir = path.join(
          obsidianMount.hostPath,
          'A.Career',
          '00_공고목록',
        );
        try {
          const files = fs.readdirSync(listingDir);
          const max = files.reduce((acc: number, f: string) => {
            const m = /^(\d+)_/.exec(f);
            return m ? Math.max(acc, parseInt(m[1], 10)) : acc;
          }, 0);
          startSeq = max + 1;
        } catch {
          // dir not yet created — start from 1
        }
      }

      const prompt = [
        'job-scraper 스킬을 실행하세요:',
        '',
        `파일 시퀀스 번호는 ${startSeq}부터 시작합니다 (공고마다 +1 증가). next-seq 호출 불필요.`,
        '',
        '스크랩할 공고 (fetch-post → Markdown 저장):',
        scrapeLines,
        '',
        '완료 후: cd /workspace/extra/obsidian && git fetch origin main && git pull origin main && git add A.Career/ && git commit -m "job: add N postings (YYYY-MM-DD)" && git push origin main',
        '상세 절차: SKILL.md 참조 (job-scraper 스킬)',
      ].join('\n');

      if (maxId > 0) saveLastSeenId(maxId);

      const taskId = `job-scrape-${Date.now()}`;
      const now = new Date().toISOString();
      createTask({
        id: taskId,
        group_folder: group.folder,
        chat_jid: chatJid,
        prompt,
        schedule_type: 'once',
        schedule_value: now,
        context_mode: 'isolated',
        model: 'claude-haiku-4-5-20251001',
        next_run: now,
        status: 'active',
        created_at: now,
      });
      if (schedulerDeps) triggerTaskNow(taskId, schedulerDeps);
    },
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  schedulerDeps = {
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (
      groupJid: string,
      proc: unknown,
      containerName: string,
      groupFolder: string,
    ) =>
      queue.registerProcess(
        groupJid,
        proc as import('child_process').ChildProcess,
        containerName,
        groupFolder,
      ),
    sendMessage: async (jid: string, rawText: string) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  };
  startSchedulerLoop(schedulerDeps);
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendKeyboard: async (jid, text, jobs) => {
      const channel = findChannel(channels, jid);
      if (channel instanceof TelegramChannel) {
        await channel.sendJobKeyboard(jid, text, jobs);
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
