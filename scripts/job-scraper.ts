/**
 * job-scraper.ts
 * Shell task: fetch new job postings from inthiswork.com via WordPress REST API
 * and write a keyboard_message IPC file for NanoClaw to send to Telegram.
 *
 * Run as a NanoClaw shell task (schedule_type: 'shell', schedule_value: cron expression).
 * Required env: JOBS_CHAT_JID
 * Optional env: JOBS_IPC_GROUP (default: main), DATA_DIR (default: /data)
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const CHAT_JID = process.env.JOBS_CHAT_JID;
const IPC_GROUP = process.env.JOBS_IPC_GROUP ?? 'main';

if (!CHAT_JID) {
  console.error('Error: JOBS_CHAT_JID environment variable is required');
  process.exit(1);
}

const STATE_FILE = process.env.JOBS_STATE_FILE ?? path.join(DATA_DIR, 'job-scraper', 'state.json');
const IPC_DIR = path.join(DATA_DIR, 'ipc', IPC_GROUP, 'messages');

const API_BASE = process.env.JOBS_API_BASE ?? 'https://inthiswork.com/wp-json/wp/v2/posts';
const CATEGORIES = process.env.JOBS_CATEGORIES ?? '191700167,191700168';
const TAGS = process.env.JOBS_TAGS ?? '191700264,191700269,191700187,191700391';
const PER_PAGE = Number(process.env.JOBS_PER_PAGE ?? '100');
// Page > 1 for historical backfill. lastSeenId filter is skipped for page > 1
// since historical posts always have lower IDs than the current last_seen_id.
const PAGE = Number(process.env.JOBS_PAGE ?? '1');

interface WpPost {
  id: number;
  title: { rendered: string };
  link: string;
  date: string;
}

interface JobEntry {
  id: number;
  title: string;
  url: string;
  date?: string;
}

interface State {
  last_seen_id: number;
}

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { last_seen_id: 0 };
  }
}

function saveState(state: State): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function writeIpcMessage(chatJid: string, text: string, jobs: JobEntry[]): void {
  fs.mkdirSync(IPC_DIR, { recursive: true });
  const filename = `job-scraper-${Date.now()}.json`;
  const filepath = path.join(IPC_DIR, filename);
  const tmp = filepath + '.tmp';
  fs.writeFileSync(
    tmp,
    JSON.stringify({ type: 'keyboard_message', chatJid, text, jobs }),
  );
  fs.renameSync(tmp, filepath);
}

async function fetchNewPosts(lastSeenId: number): Promise<WpPost[]> {
  const url = new URL(API_BASE);
  url.searchParams.set('categories', CATEGORIES);
  url.searchParams.set('tags', TAGS);
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('orderby', 'id');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('_fields', 'id,title,link,date');
  if (PAGE > 1) url.searchParams.set('page', String(PAGE));

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  const posts: WpPost[] = await res.json();
  // For page > 1 (historical backfill), skip the lastSeenId filter —
  // older posts always have lower IDs than the current last_seen_id.
  return PAGE > 1 ? posts : posts.filter((p) => p.id > lastSeenId);
}

async function main(): Promise<void> {
  const state = loadState();
  let newPosts: WpPost[];

  try {
    newPosts = await fetchNewPosts(state.last_seen_id);
  } catch (err) {
    console.error('Failed to fetch posts:', err);
    process.exit(1);
  }

  if (newPosts.length === 0) {
    console.log('No new job postings.');
    return;
  }

  // Sort ascending so earliest posts are listed first
  newPosts.sort((a, b) => a.id - b.id);

  const jobs: JobEntry[] = newPosts.map((p) => ({
    id: p.id,
    title: p.title.rendered.replace(/&amp;/g, '&').replace(/&#8211;/g, '–').replace(/&#8217;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
    url: p.link,
    date: p.date ? p.date.slice(0, 10) : undefined,
  }));

  writeIpcMessage(CHAT_JID!, `🆕 새 채용공고 ${jobs.length}건`, jobs);
  console.log(`Wrote ${jobs.length} new job(s)`);
}

main();
