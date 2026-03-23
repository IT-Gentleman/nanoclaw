import fs from 'fs';
import path from 'path';
import { Agent as HttpsAgent } from 'node:https';

import { Bot, InlineKeyboard } from 'grammy';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  registerChannel,
  ChannelOpts,
  SessionInfo,
  JobEntry,
} from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface ModelEntry {
  id: string;
  alias: string;
  label: string;
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onStop?: (chatJid: string) => boolean;
  onNewSession?: (chatJid: string) => void;
  onListSessions?: (chatJid: string) => SessionInfo[];
  onSwitchSession?: (chatJid: string, sessionId: string) => boolean;
  onHideSession?: (chatJid: string, sessionId: string) => void;
  onGetModel?: (chatJid: string) => string | undefined;
  onSwitchModel?: (chatJid: string, modelId: string | null) => boolean;
  onGetContextTokens?: (chatJid: string) => number | undefined;
  onGetUsage?: (
    chatJid: string,
    since: Date,
  ) => import('../db.js').UsageSummary | null;
  onCompact?: (
    chatJid: string,
  ) => Promise<{ preTokens?: number; postTokens?: number }>;
  onCompactAndSwitch?: (
    chatJid: string,
    modelId: string | null,
  ) => Promise<{ preTokens?: number; postTokens?: number }>;
  onJobConfirm?: (
    chatJid: string,
    selectedJobs: JobEntry[],
    skippedJobs: JobEntry[],
  ) => Promise<void>;
  onListTasks?: (chatJid: string) => import('../types.js').ScheduledTask[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

function formatDate(d: Date): string {
  return (
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:` +
    `${String(d.getMinutes()).padStart(2, '0')}`
  );
}

function buildSessionsMessage(list: SessionInfo[]): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const lines: string[] = ['세션 목록:\n'];
  const keyboard = new InlineKeyboard();

  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const size = formatBytes(s.sizeBytes);
    const date = formatDate(s.modifiedAt);
    const currentMark = s.isCurrent ? '✅ ' : '';
    const currentLabel = s.isCurrent ? ' (현재)' : '';
    lines.push(`${currentMark}${i + 1} · ${size} · ${date}${currentLabel}`);
    if (s.preview) {
      lines.push(`  "${s.preview}"`);
    }

    const btnLabel = s.isCurrent
      ? `✅ ${i + 1} · ${size} (현재)`
      : `   ${i + 1} · ${size}        `;
    keyboard
      .text(btnLabel, `sess:${s.sessionId}`)
      .text('🙈 숨기기', `hide:${s.sessionId}`)
      .row();
  }

  keyboard.text('🆕 새 세션 시작', 'sess:new');

  return { text: lines.join('\n'), keyboard };
}

// --- File-backed pending jobs (survives process restarts, no RAM leak) ---
const PENDING_KEYBOARDS_DIR = path.join(DATA_DIR, 'pending-keyboards');
const PENDING_KEYBOARD_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function pendingJobsPath(jid: string): string {
  return path.join(
    PENDING_KEYBOARDS_DIR,
    jid.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json',
  );
}

interface PendingKeyboardState {
  jobs: JobEntry[];
  selected: number[]; // job IDs that are currently checked
  page: number; // current page (0-indexed)
  messageId?: number;
  createdAt: number;
}

function savePendingState(jid: string, state: PendingKeyboardState): void {
  fs.mkdirSync(PENDING_KEYBOARDS_DIR, { recursive: true });
  const tempPath = pendingJobsPath(jid) + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(state));
  fs.renameSync(tempPath, pendingJobsPath(jid));
}

function loadPendingState(jid: string): PendingKeyboardState | null {
  try {
    const data = JSON.parse(fs.readFileSync(pendingJobsPath(jid), 'utf-8'));
    if (Date.now() - data.createdAt > PENDING_KEYBOARD_TTL_MS) {
      try {
        fs.unlinkSync(pendingJobsPath(jid));
      } catch {
        /* ignore */
      }
      return null;
    }
    return {
      jobs: data.jobs || [],
      selected: data.selected || [],
      page: data.page ?? 0,
      messageId: data.messageId,
      createdAt: data.createdAt,
    };
  } catch {
    return null;
  }
}

function savePendingJobs(jid: string, jobs: JobEntry[]): void {
  savePendingState(jid, { jobs, selected: [], page: 0, createdAt: Date.now() });
}

function loadPendingJobs(jid: string): JobEntry[] {
  return loadPendingState(jid)?.jobs ?? [];
}

function deletePendingJobs(jid: string): void {
  try {
    fs.unlinkSync(pendingJobsPath(jid));
  } catch {
    /* ignore */
  }
}

// --- Model config ---
const MODELS_CONFIG_PATH = path.join(DATA_DIR, 'models.json');
const DEFAULT_MODELS: ModelEntry[] = [
  { id: 'claude-opus-4-6', alias: 'opus', label: 'Opus 4.6   (최고 성능)' },
  { id: 'claude-sonnet-4-6', alias: 'sonnet', label: 'Sonnet 4.6 (기본)' },
  {
    id: 'claude-haiku-4-5-20251001',
    alias: 'haiku',
    label: 'Haiku 4.5  (빠름/저렴)',
  },
];

function loadModelsConfig(): ModelEntry[] {
  try {
    return JSON.parse(fs.readFileSync(MODELS_CONFIG_PATH, 'utf-8'));
  } catch {
    return DEFAULT_MODELS;
  }
}

const COMPACT_WARN_TOKENS = 20000;

function buildModelKeyboard(
  availableModels: ModelEntry[],
  currentId: string | undefined,
  showCompact = false,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const m of availableModels) {
    const isCurrent = m.id === currentId;
    keyboard.text(`${isCurrent ? '✅ ' : ''}${m.label}`, `mdl:${m.id}`).row();
  }
  const isDefault = !currentId;
  keyboard.text(`${isDefault ? '✅ ' : ''}🔄 기본값 (SDK 자동)`, 'mdl:default');
  if (showCompact) {
    keyboard.row().text('⚡ 압축 후 전환...', 'mdl:compact:show');
  }
  return keyboard;
}

function buildCompactSwitchKeyboard(
  availableModels: ModelEntry[],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const m of availableModels) {
    keyboard.text(`⚡ → ${m.label}`, `mdl:compact:${m.id}`).row();
  }
  keyboard.text('⚡ → SDK 기본값', 'mdl:compact:default');
  keyboard.row().text('← 취소', 'mdl:compact:cancel');
  return keyboard;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Convert markdown to Telegram HTML.
 *
 * - Headings (##): keep # symbols visible, wrap line in <b>
 * - Bold/italic/strikethrough: REMOVE markdown symbols, wrap content in HTML tag
 * - Inline code: strip backticks, wrap content in <code>
 * - Code blocks: strip ``` markers, wrap content in <pre><code>
 * - List items (- / * at line start): convert to • bullet character
 */
function markdownToTelegramHtml(text: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. Extract fenced code blocks → strip ``` markers, preserve content
  let r = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, _lang, content) => {
    const escaped = (content as string)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    codeBlocks.push(`<pre><code>${escaped}</code></pre>`);
    return `\x00C${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract inline code → strip backticks, preserve content
  r = r.replace(/`([^`\n]+)`/g, (_, content) => {
    const escaped = (content as string)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    inlineCodes.push(`<code>${escaped}</code>`);
    return `\x00I${inlineCodes.length - 1}\x00`;
  });

  // 3. Escape HTML entities in remaining text
  r = r.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 4. Headings: keep # prefix visible, wrap line in <b>
  r = r.replace(/^(#{1,6} .+)$/gm, (match) => `<b>${match}</b>`);

  // 5. Bold **...**: remove **, wrap content in <b>
  r = r.replace(/\*\*([^*\n]+?)\*\*/g, (_, inner) => `<b>${inner}</b>`);

  // 6. Italic *...*: remove *, wrap content in <i> (skip leading "* item" bullets)
  r = r.replace(
    /(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g,
    (_, inner) => `<i>${inner}</i>`,
  );

  // 7. Italic _..._: remove _, wrap content in <i> (skip snake_case)
  r = r.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, (_, inner) => `<i>${inner}</i>`);

  // 8. Strikethrough ~~...~~: remove ~~, wrap content in <s>
  r = r.replace(/~~([^~\n]+?)~~/g, (_, inner) => `<s>${inner}</s>`);

  // 9. Restore placeholders
  r = r.replace(/\x00I(\d+)\x00/g, (_, i) => inlineCodes[Number(i)]);
  r = r.replace(/\x00C(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);

  return r;
}

const JOBS_PER_PAGE = 48; // 48 job buttons + 2 action + 2 nav ≤ 100 Telegram limit

function buildJobKeyboard(
  jobs: JobEntry[],
  selected: Set<number>,
  page = 0,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  // Action row at the top — always visible regardless of list length
  const selectedCount = selected.size;
  if (selectedCount > 0) {
    keyboard
      .text(`✅ 스크랩 (${selectedCount}건)`, 'job:confirm')
      .text('⏭ 전체 건너뛰기', 'job:skipall');
  } else {
    keyboard.text('⏭ 전체 건너뛰기', 'job:skipall');
  }
  keyboard.row();

  const totalPages = Math.ceil(jobs.length / JOBS_PER_PAGE);
  const clampedPage = Math.max(0, Math.min(page, totalPages - 1));
  const start = clampedPage * JOBS_PER_PAGE;
  const pageJobs = jobs.slice(start, start + JOBS_PER_PAGE);

  for (let i = 0; i < pageJobs.length; i++) {
    const globalIdx = start + i;
    const job = pageJobs[i];
    const isSelected = selected.has(job.id);
    const icon = isSelected ? '☑' : '☐';
    const title =
      job.title.length > 18 ? job.title.slice(0, 17) + '…' : job.title;
    keyboard.text(`${icon} ${globalIdx + 1}. ${title}`, `job:toggle:${job.id}`);
    if ((i + 1) % 2 === 0) keyboard.row();
  }
  // Close last row if odd number of items on this page
  if (pageJobs.length % 2 !== 0) keyboard.row();

  // Navigation row (only when multiple pages)
  if (totalPages > 1) {
    if (clampedPage > 0)
      keyboard.text(
        `◀ 이전 (${clampedPage}/${totalPages})`,
        `job:page:${clampedPage - 1}`,
      );
    if (clampedPage < totalPages - 1)
      keyboard.text(
        `다음 (${clampedPage + 2}/${totalPages}) ▶`,
        `job:page:${clampedPage + 1}`,
      );
  }

  return keyboard;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        timeoutSeconds: 60,
        baseFetchConfig: {
          // Node.js 22 happy eyeballs (autoSelectFamily) fails when IPv6 is
          // unreachable, causing ETIMEDOUT. Force IPv4-only connections.
          agent: new HttpsAgent({ keepAlive: true, family: 4 }),
        },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to stop the active agent task
    this.bot.command('stop', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      const stopped = this.opts.onStop?.(chatJid) ?? false;
      ctx.reply(
        stopped ? '⏹ 작업을 중단했습니다.' : '실행 중인 작업이 없습니다.',
      );
    });

    // Command to start a fresh Claude session
    this.bot.command('newsession', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      this.opts.onNewSession?.(chatJid);
      ctx.reply(
        '🆕 세션을 초기화했습니다. 다음 메시지부터 새 대화로 처리됩니다.',
      );
    });

    // Command to list saved sessions with InlineKeyboard
    this.bot.command('sessions', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        ctx.reply('등록되지 않은 채팅입니다.');
        return;
      }
      const list = this.opts.onListSessions?.(chatJid) ?? [];
      if (list.length === 0) {
        ctx.reply('저장된 세션이 없습니다.');
        return;
      }
      const { text, keyboard } = buildSessionsMessage(list);
      ctx.reply(text, { reply_markup: keyboard });
    });

    // Command to list scheduled tasks
    this.bot.command('tasks', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        ctx.reply('등록되지 않은 채팅입니다.');
        return;
      }
      const tasks = this.opts.onListTasks?.(chatJid) ?? [];
      if (tasks.length === 0) {
        ctx.reply('등록된 태스크가 없습니다.');
        return;
      }
      const lines = tasks.map((t) => {
        const scheduleLabel =
          t.schedule_type === 'cron'
            ? `cron: ${t.schedule_value}`
            : t.schedule_type === 'interval'
              ? `매 ${Math.round(parseInt(t.schedule_value) / 60000)}분`
              : `1회: ${t.schedule_value}`;
        const nextRun = t.next_run
          ? new Date(t.next_run).toLocaleString('ko-KR', {
              timeZone: 'Asia/Seoul',
              hour12: false,
            })
          : '-';
        const statusIcon =
          t.status === 'active' ? '▶' : t.status === 'paused' ? '⏸' : '✓';
        const promptPreview = t.prompt.slice(0, 40).replace(/\n/g, ' ');
        return `${statusIcon} [${t.id.slice(-8)}] ${scheduleLabel}\n  다음: ${nextRun}\n  내용: ${promptPreview}...`;
      });
      ctx.reply(`태스크 목록 (${tasks.length}건):\n\n${lines.join('\n\n')}`);
    });

    // Command to view/change the active model
    this.bot.command('model', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const availableModels = loadModelsConfig();
      const arg = (ctx.match ?? '').trim().toLowerCase();

      if (arg) {
        // /model default | /model none → reset
        if (arg === 'default' || arg === 'none') {
          this.opts.onSwitchModel?.(chatJid, null);
          await ctx.reply(
            '🔄 SDK 기본 모델로 초기화됩니다. 현재 컨테이너를 닫고 다음 메시지부터 적용됩니다.',
          );
          return;
        }
        // /model haiku | /model sonnet | /model opus | full id
        const target = availableModels.find(
          (m) => m.alias === arg || m.id === arg,
        );
        if (!target) {
          const aliases = availableModels.map((m) => m.alias).join(', ');
          await ctx.reply(
            `알 수 없는 모델입니다. 사용 가능: ${aliases}, default`,
          );
          return;
        }
        this.opts.onSwitchModel?.(chatJid, target.id);
        await ctx.reply(
          `✅ ${target.label}로 변경됩니다. 현재 컨테이너를 닫고 다음 메시지부터 적용됩니다.`,
        );
        return;
      }

      // No arg: show current model + inline keyboard
      const currentModel = this.opts.onGetModel?.(chatJid);
      const currentEntry = availableModels.find((m) => m.id === currentModel);
      const currentLabel = currentEntry?.label ?? currentModel ?? 'SDK 기본값';
      const ctxTokens = this.opts.onGetContextTokens?.(chatJid);
      const showCompact = ctxTokens != null && ctxTokens >= COMPACT_WARN_TOKENS;
      const contextNote =
        ctxTokens != null && ctxTokens > 0
          ? ctxTokens >= COMPACT_WARN_TOKENS
            ? `\n컨텍스트: ${formatTokens(ctxTokens)} 토큰 ⚠️ (전환 시 캐시 초기화 — 1회 비용 증가)`
            : `\n컨텍스트: ${formatTokens(ctxTokens)} 토큰`
          : '';
      const keyboard = buildModelKeyboard(
        availableModels,
        currentModel,
        showCompact,
      );
      await ctx.reply(`현재 모델: ${currentLabel}${contextNote}`, {
        reply_markup: keyboard,
      });
    });

    // /compact — trigger manual compaction of current session
    this.bot.command('compact', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      if (!this.opts.onCompact) {
        await ctx.reply('compaction 기능을 사용할 수 없습니다.');
        return;
      }
      const preTokens = this.opts.onGetContextTokens?.(chatJid);
      if (preTokens == null || preTokens === 0) {
        await ctx.reply(
          '현재 대화 기록이 없거나 컨텍스트 크기를 알 수 없습니다.',
        );
        return;
      }
      const statusMsg = await ctx.reply(
        `🗜 컨텍스트 압축 중... (현재 ${formatTokens(preTokens)} 토큰)`,
      );
      this.opts
        .onCompact(chatJid)
        .then(({ postTokens }) => {
          const saved =
            postTokens != null
              ? ` → ${formatTokens(postTokens)} 토큰 (${formatTokens((preTokens ?? 0) - postTokens)} 절감)`
              : '';
          ctx.api
            .editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              `✅ 압축 완료${saved}`,
            )
            .catch(() => {});
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.api
            .editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              `❌ 압축 실패: ${msg}`,
            )
            .catch(() => {});
        });
    });

    // /usage — show token usage and cost summary
    this.bot.command('usage', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      if (!this.opts.onGetUsage) {
        await ctx.reply('사용량 조회 기능을 사용할 수 없습니다.');
        return;
      }
      const now = new Date();
      const todayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );
      const weekStart = new Date(todayStart);
      weekStart.setDate(todayStart.getDate() - todayStart.getDay());

      const today = this.opts.onGetUsage(chatJid, todayStart);
      const week = this.opts.onGetUsage(chatJid, weekStart);

      if (!today || !week) {
        await ctx.reply('사용량 데이터가 없습니다.');
        return;
      }

      const ctxTokens = this.opts.onGetContextTokens?.(chatJid);
      const ctxLine =
        ctxTokens != null && ctxTokens > 0
          ? `\n현재 컨텍스트: ${formatTokens(ctxTokens)} 토큰`
          : '';

      const fmtSummary = (label: string, s: typeof today) => {
        const lines = [`<b>${label}</b>`];
        lines.push(
          `  입력: ${formatTokens(s.inputTokens)} · 출력: ${formatTokens(s.outputTokens)}`,
        );
        if (s.cacheReadTokens > 0 || s.cacheCreationTokens > 0) {
          lines.push(
            `  캐시: 히트 ${formatTokens(s.cacheReadTokens)} / 생성 ${formatTokens(s.cacheCreationTokens)}`,
          );
        }
        if (s.costUsd > 0) {
          lines.push(`  비용: $${s.costUsd.toFixed(4)}`);
        }
        const modelEntries = Object.entries(s.byModel);
        if (modelEntries.length > 1) {
          const breakdown = modelEntries
            .sort((a, b) => b[1].inputTokens - a[1].inputTokens)
            .map(([id, u]) => {
              const alias = id.includes('opus')
                ? 'opus'
                : id.includes('sonnet')
                  ? 'sonnet'
                  : 'haiku';
              return `  ${alias}: ${formatTokens(u.inputTokens + u.outputTokens)}tok`;
            })
            .join(' · ');
          lines.push(breakdown);
        }
        return lines.join('\n');
      };

      const text = [
        fmtSummary('오늘', today),
        fmtSummary('이번 주', week),
        ctxLine,
      ]
        .filter(Boolean)
        .join('\n\n');

      await ctx.reply(text, { parse_mode: 'HTML' });
    });

    // Command to select jobs for scraping (text fallback for InlineKeyboard)
    this.bot.command('scrape', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const jobs = loadPendingJobs(chatJid);
      if (jobs.length === 0) {
        await ctx.reply('선택할 공고가 없습니다.');
        return;
      }

      const arg = (ctx.match ?? '').trim().toLowerCase();

      if (arg === 'skip') {
        deletePendingJobs(chatJid);
        if (this.opts.onJobConfirm) {
          void this.opts.onJobConfirm(chatJid, [], jobs);
        }
        await ctx.reply('전체 건너뛰었습니다.');
        return;
      }

      if (arg === 'all') {
        deletePendingJobs(chatJid);
        if (this.opts.onJobConfirm) {
          void this.opts.onJobConfirm(chatJid, jobs, []);
        }
        await ctx.reply(`${jobs.length}개 공고 전체 스크랩을 시작합니다.`);
        return;
      }

      // "1,3,5" 또는 "1 3 5" 파싱
      const nums = arg
        .split(/[,\s]+/)
        .map(Number)
        .filter((n) => n >= 1 && n <= jobs.length);
      if (nums.length === 0) {
        await ctx.reply('사용법: /scrape 1,3,5 | /scrape all | /scrape skip');
        return;
      }

      const uniqueNums = [...new Set(nums)];
      const selectedJobs = uniqueNums.map((n) => jobs[n - 1]);
      const skippedJobs = jobs.filter((_, i) => !uniqueNums.includes(i + 1));
      deletePendingJobs(chatJid);
      if (this.opts.onJobConfirm) {
        void this.opts.onJobConfirm(chatJid, selectedJobs, skippedJobs);
      }
      await ctx.reply(`${selectedJobs.length}개 공고 스크랩을 시작합니다.`);
    });

    // InlineKeyboard callback: switch session, hide session, new session
    this.bot.callbackQuery(/^sess:(.+)$/, async (ctx) => {
      const chatJid = `tg:${ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id}`;
      const sessionId = ctx.match[1];

      if (sessionId === 'new') {
        this.opts.onNewSession?.(chatJid);
        await ctx.answerCallbackQuery({ text: '🆕 새 세션이 시작됩니다.' });
        await ctx.editMessageText(
          '🆕 세션을 초기화했습니다. 다음 메시지부터 새 대화로 처리됩니다.',
        );
        return;
      }

      const switched = this.opts.onSwitchSession?.(chatJid, sessionId) ?? false;
      if (switched) {
        // Refresh list
        const list = this.opts.onListSessions?.(chatJid) ?? [];
        if (list.length > 0) {
          const { text, keyboard } = buildSessionsMessage(list);
          await ctx.editMessageText(text, { reply_markup: keyboard });
        }
        await ctx.answerCallbackQuery({ text: '✅ 세션 전환됨' });
      } else {
        await ctx.answerCallbackQuery({ text: '❌ 전환 실패' });
      }
    });

    // Model selection callback
    this.bot.callbackQuery(/^mdl:(.+)$/, async (ctx) => {
      const chatJid = `tg:${ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        await ctx.answerCallbackQuery({ text: '등록되지 않은 채팅입니다.' });
        return;
      }

      const availableModels = loadModelsConfig();
      const modelArg = ctx.match[1];

      // Capture previous model before switching
      const prevModelId = this.opts.onGetModel?.(chatJid);
      const prevEntry = availableModels.find((m) => m.id === prevModelId);
      const prevLabel = prevEntry?.label ?? prevModelId ?? 'SDK 기본값';

      // Check context token count for usage warning
      const ctxTokens = this.opts.onGetContextTokens?.(chatJid);
      const contextWarning =
        ctxTokens != null && ctxTokens >= COMPACT_WARN_TOKENS
          ? `\n\n⚠️ 컨텍스트 ${formatTokens(ctxTokens)} 토큰 — 모델 전환 시 프롬프트 캐시가 초기화되어 전체 기록을 새 모델 기준으로 재처리합니다 (1회 비용 증가).`
          : '';

      if (modelArg === 'default') {
        this.opts.onSwitchModel?.(chatJid, null);
        await ctx.answerCallbackQuery({
          text: '🔄 SDK 기본 모델로 초기화됩니다.',
        });
        const msg = `기존 모델: ${prevLabel}\n변경 모델: SDK 기본값 (자동)${contextWarning}`;
        try {
          await ctx.editMessageText(msg);
        } catch {
          /* ignore */
        }
        return;
      }

      const target = availableModels.find((m) => m.id === modelArg);
      if (!target) {
        await ctx.answerCallbackQuery({ text: '알 수 없는 모델' });
        return;
      }

      // No-op if already selected
      if (prevModelId === target.id) {
        await ctx.answerCallbackQuery({ text: '이미 선택된 모델입니다.' });
        return;
      }

      this.opts.onSwitchModel?.(chatJid, target.id);
      await ctx.answerCallbackQuery({
        text: `✅ ${target.label}로 변경됩니다.`,
      });
      const msg = `기존 모델: ${prevLabel}\n변경 모델: ${target.label}${contextWarning}`;
      try {
        await ctx.editMessageText(msg);
      } catch {
        /* ignore */
      }
    });

    // Compact+switch: show model selection keyboard
    this.bot.callbackQuery('mdl:compact:show', async (ctx) => {
      const chatJid = `tg:${ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        await ctx.answerCallbackQuery({ text: '등록되지 않은 채팅입니다.' });
        return;
      }
      const availableModels = loadModelsConfig();
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText('⚡ 압축 후 전환할 모델을 선택하세요:', {
          reply_markup: buildCompactSwitchKeyboard(availableModels),
        });
      } catch {
        /* ignore */
      }
    });

    // Compact+switch: cancel
    this.bot.callbackQuery('mdl:compact:cancel', async (ctx) => {
      const chatJid = `tg:${ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        await ctx.answerCallbackQuery();
        return;
      }
      const availableModels = loadModelsConfig();
      const currentModel = this.opts.onGetModel?.(chatJid);
      const currentEntry = availableModels.find((m) => m.id === currentModel);
      const currentLabel = currentEntry?.label ?? currentModel ?? 'SDK 기본값';
      const ctxTokens = this.opts.onGetContextTokens?.(chatJid);
      const showCompact = ctxTokens != null && ctxTokens >= COMPACT_WARN_TOKENS;
      const contextNote =
        ctxTokens != null && ctxTokens > 0
          ? ctxTokens >= COMPACT_WARN_TOKENS
            ? `\n컨텍스트: ${formatTokens(ctxTokens)} 토큰 ⚠️ (전환 시 캐시 초기화 — 1회 비용 증가)`
            : `\n컨텍스트: ${formatTokens(ctxTokens)} 토큰`
          : '';
      await ctx.answerCallbackQuery({ text: '취소됐습니다.' });
      try {
        await ctx.editMessageText(`현재 모델: ${currentLabel}${contextNote}`, {
          reply_markup: buildModelKeyboard(
            availableModels,
            currentModel,
            showCompact,
          ),
        });
      } catch {
        /* ignore */
      }
    });

    // Compact+switch: execute (mdl:compact:<model_id> or mdl:compact:default)
    this.bot.callbackQuery(/^mdl:compact:(.+)$/, async (ctx) => {
      const chatJid = `tg:${ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        await ctx.answerCallbackQuery({ text: '등록되지 않은 채팅입니다.' });
        return;
      }

      const modelArg = ctx.match[1];
      if (modelArg === 'show' || modelArg === 'cancel') return; // handled above

      const availableModels = loadModelsConfig();
      const targetModelId = modelArg === 'default' ? null : modelArg;
      const targetEntry = availableModels.find((m) => m.id === targetModelId);
      const targetLabel = targetEntry?.label ?? targetModelId ?? 'SDK 기본값';

      await ctx.answerCallbackQuery({ text: '⚡ 압축을 시작합니다...' });
      try {
        await ctx.editMessageText('🗜 컨텍스트 압축 중... (완료 후 알림)');
      } catch {
        /* ignore */
      }

      // Run compact+switch asynchronously
      this.opts
        .onCompactAndSwitch?.(chatJid, targetModelId)
        .then(({ preTokens, postTokens }) => {
          const saved =
            preTokens != null && postTokens != null
              ? ` (${formatTokens(preTokens)} → ${formatTokens(postTokens)} 토큰)`
              : '';
          ctx
            .reply(`✅ 압축 완료 → ${targetLabel}로 전환됨${saved}`)
            .catch(() => {});
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.reply(`❌ 압축 실패: ${msg}`).catch(() => {});
        });
    });

    // Job keyboard: toggle checkbox
    this.bot.callbackQuery(/^job:toggle:(\d+)$/, async (ctx) => {
      const chatJid = `tg:${ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id}`;
      const jobId = Number(ctx.match[1]);
      const state = loadPendingState(chatJid);
      if (!state) {
        await ctx.answerCallbackQuery({ text: '공고 목록이 만료되었습니다.' });
        return;
      }
      const selectedSet = new Set(state.selected);
      if (selectedSet.has(jobId)) {
        selectedSet.delete(jobId);
      } else {
        selectedSet.add(jobId);
      }
      state.selected = [...selectedSet];
      savePendingState(chatJid, state);
      const keyboard = buildJobKeyboard(
        state.jobs,
        selectedSet,
        state.page ?? 0,
      );
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
      } catch {
        /* message unchanged — ignore */
      }
      const job = state.jobs.find((j) => j.id === jobId);
      const icon = selectedSet.has(jobId) ? '☑' : '☐';
      await ctx.answerCallbackQuery({ text: `${icon} ${job?.title ?? jobId}` });
    });

    // Job keyboard: page navigation
    this.bot.callbackQuery(/^job:page:(\d+)$/, async (ctx) => {
      const chatJid = `tg:${ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id}`;
      const page = Number(ctx.match[1]);
      const state = loadPendingState(chatJid);
      if (!state) {
        await ctx.answerCallbackQuery({ text: '공고 목록이 만료되었습니다.' });
        return;
      }
      state.page = page;
      savePendingState(chatJid, state);
      const keyboard = buildJobKeyboard(
        state.jobs,
        new Set(state.selected),
        page,
      );
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
      } catch {
        /* unchanged */
      }
      await ctx.answerCallbackQuery();
    });

    // Job keyboard: confirm scrape
    this.bot.callbackQuery('job:confirm', async (ctx) => {
      const chatJid = `tg:${ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id}`;
      const state = loadPendingState(chatJid);
      if (!state || state.selected.length === 0) {
        await ctx.answerCallbackQuery({ text: '선택된 공고가 없습니다.' });
        return;
      }
      const selectedSet = new Set(state.selected);
      const selectedJobs = state.jobs.filter((j) => selectedSet.has(j.id));
      const skippedJobs = state.jobs.filter((j) => !selectedSet.has(j.id));
      deletePendingJobs(chatJid);
      await ctx.answerCallbackQuery({
        text: `✅ ${selectedJobs.length}건 스크랩 시작`,
      });
      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: new InlineKeyboard(),
        });
      } catch {
        /* ignore */
      }
      if (this.opts.onJobConfirm) {
        void this.opts.onJobConfirm(chatJid, selectedJobs, skippedJobs);
      }
    });

    // Job keyboard: skip all
    this.bot.callbackQuery('job:skipall', async (ctx) => {
      const chatJid = `tg:${ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id}`;
      const state = loadPendingState(chatJid);
      deletePendingJobs(chatJid);
      await ctx.answerCallbackQuery({ text: '⏭ 전체 건너뜀' });
      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: new InlineKeyboard(),
        });
      } catch {
        /* ignore */
      }
      if (state && this.opts.onJobConfirm) {
        void this.opts.onJobConfirm(chatJid, [], state.jobs);
      }
    });

    this.bot.callbackQuery(/^hide:(.+)$/, async (ctx) => {
      const chatJid = `tg:${ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id}`;
      const sessionId = ctx.match[1];

      this.opts.onHideSession?.(chatJid, sessionId);

      // Refresh list
      const list = this.opts.onListSessions?.(chatJid) ?? [];
      if (list.length > 0) {
        const { text, keyboard } = buildSessionsMessage(list);
        await ctx.editMessageText(text, { reply_markup: keyboard });
      } else {
        await ctx.editMessageText('저장된 세션이 없습니다.');
      }
      await ctx.answerCallbackQuery({ text: '🙈 세션을 숨겼습니다.' });
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        drop_pending_updates: true,
        timeout: 25,
        onStart: (botInfo) => {
          // Update bot command menu (fire-and-forget, non-critical)
          this.bot!.api.setMyCommands([
            { command: 'chatid', description: '현재 채팅 ID 확인' },
            { command: 'ping', description: '봇 상태 확인' },
            { command: 'stop', description: '진행 중인 작업 중단' },
            { command: 'newsession', description: '새 세션 시작' },
            { command: 'sessions', description: '세션 목록 보기' },
            { command: 'tasks', description: '스케줄 태스크 목록 보기' },
            {
              command: 'model',
              description: '모델 변경 (opus/sonnet/haiku)',
            },
            { command: 'compact', description: '컨텍스트 압축' },
            { command: 'usage', description: '토큰 사용량 및 비용 조회' },
            {
              command: 'scrape',
              description: '공고 스크랩 (예: /scrape 1,3,5)',
            },
          ]).catch((err) =>
            logger.debug({ err }, 'Failed to register bot commands'),
          );
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const numericId = jid.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;

    // Retry on transient network errors (ETIMEDOUT, ECONNRESET, etc.)
    const RETRY_DELAYS_MS = [2000, 5000, 10000, 15000, 20000];
    let lastErr: unknown;

    // Convert markdown to Telegram HTML before sending
    text = markdownToTelegramHtml(text);

    // Try HTML parse mode first; if Telegram rejects malformed HTML, fall back to plain text
    const sendChunk = async (chunk: string, htmlMode: boolean) => {
      const opts = htmlMode ? { parse_mode: 'HTML' as const } : undefined;
      try {
        await this.bot!.api.sendMessage(numericId, chunk, opts);
      } catch (err) {
        if (htmlMode && (err as any)?.error?.description?.includes('parse')) {
          // HTML parse error — strip tags and retry as plain text
          const plain = chunk.replace(/<[^>]+>/g, '');
          await this.bot!.api.sendMessage(numericId, plain);
        } else {
          throw err;
        }
      }
    };

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        if (text.length <= MAX_LENGTH) {
          await sendChunk(text, true);
        } else {
          for (let i = 0; i < text.length; i += MAX_LENGTH) {
            await sendChunk(text.slice(i, i + MAX_LENGTH), true);
          }
        }
        logger.info({ jid, length: text.length }, 'Telegram message sent');
        return;
      } catch (err) {
        lastErr = err;
        const code = (err as any)?.error?.code || (err as any)?.error?.errno;
        const isTransient =
          typeof code === 'string' &&
          [
            'ETIMEDOUT',
            'ECONNRESET',
            'ECONNREFUSED',
            'ENOTFOUND',
            'EAI_AGAIN',
          ].includes(code);

        if (isTransient && attempt < RETRY_DELAYS_MS.length) {
          logger.warn(
            {
              jid,
              attempt: attempt + 1,
              code,
              retryIn: RETRY_DELAYS_MS[attempt],
            },
            'Telegram transient error — retrying',
          );
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        break;
      }
    }

    // All retries exhausted — try to send a brief error notice so the user isn't left waiting
    logger.error(
      { jid, err: lastErr },
      'Failed to send Telegram message after retries',
    );
    try {
      await this.bot.api.sendMessage(
        numericId,
        '⚠️ 메시지 전송에 실패했습니다. 잠시 후 다시 요청해주세요.',
      );
    } catch {
      logger.error(
        { jid },
        'Telegram fallback error notice also failed — network may be down',
      );
    }
  }

  async sendJobKeyboard(
    jid: string,
    text: string,
    jobs: JobEntry[],
  ): Promise<void> {
    if (!this.bot) return;
    savePendingJobs(jid, jobs);

    const numericId = jid.replace(/^tg:/, '');

    // Send full list with URLs first via sendMessage (handles chunking + retry internally)
    const lines = jobs.map((job, i) => {
      const datePart = job.date ? ` (${job.date})` : '';
      return `${i + 1}. ${job.title}${datePart}\n   ${job.url}`;
    });
    await this.sendMessage(jid, lines.join('\n\n'));

    // Send header + keyboard after the list
    const keyboard = buildJobKeyboard(jobs, new Set<number>());
    try {
      const sent = await this.bot.api.sendMessage(numericId, text, {
        reply_markup: keyboard,
      });
      const state = loadPendingState(jid);
      if (state) {
        state.messageId = sent.message_id;
        savePendingState(jid, state);
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send job keyboard');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  /** Send a progress message and return its message_id (for later edits). */
  async sendProgressMessage(jid: string, text: string): Promise<string | null> {
    if (!this.bot) return null;
    const numericId = jid.replace(/^tg:/, '');
    const RETRY_DELAYS = [2000, 5000, 10000];
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const msg = await this.bot.api.sendMessage(numericId, text);
        return String(msg.message_id);
      } catch (err) {
        const code = (err as any)?.error?.code || (err as any)?.error?.errno;
        const isTransient =
          typeof code === 'string' &&
          [
            'ETIMEDOUT',
            'ECONNRESET',
            'ECONNREFUSED',
            'ENOTFOUND',
            'EAI_AGAIN',
          ].includes(code);
        if (isTransient && attempt < RETRY_DELAYS.length) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
          continue;
        }
        logger.debug({ jid, err }, 'Failed to send Telegram progress message');
        return null;
      }
    }
    return null;
  }

  /** Edit an existing progress message in-place. */
  async updateProgressMessage(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.editMessageText(numericId, Number(messageId), text);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update Telegram progress message');
    }
  }

  /** Delete the progress message when the agent's response is ready. */
  async deleteProgressMessage(jid: string, messageId: string): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.deleteMessage(numericId, Number(messageId));
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to delete Telegram progress message');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
