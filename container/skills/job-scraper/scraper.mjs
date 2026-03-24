#!/usr/bin/env node
/**
 * job-scraper/scraper.mjs
 * inthiswork.com 채용공고 탐색 및 스크랩
 *
 * 명령어:
 *   init                  — 필요 디렉토리 초기화
 *   discover [page]       — 신규 공고 탐색 후 keyboard_message IPC 작성 (page>1: 과거 백필)
 *   fetch-post <id>       — 특정 공고 내용 가져오기
 *   next-seq              — 다음 파일 시퀀스 번호 반환
 *
 * 의존성: Node.js 내장 모듈만 사용 (https, fs, path)
 */

import https from 'https';
import fs from 'fs';
import path from 'path';

// ─── 경로 설정 ───────────────────────────────────────────────────────────────

const OBSIDIAN_ROOT = '/workspace/extra/obsidian';
const CAREER_DIR = path.join(OBSIDIAN_ROOT, 'A.Career');
const STATE_FILE = path.join(CAREER_DIR, '.job-scraper-state.json');
const IPC_MESSAGES_DIR = '/workspace/ipc/messages';

// inthiswork WordPress REST API
const API_BASE = 'https://inthiswork.com/wp-json/wp/v2';
const DEFAULT_CATEGORIES = '191700167,191700168';
const DEFAULT_TAGS = '191700264,191700269,191700187,191700391';
const PER_PAGE = 100;

// ─── HTTP 헬퍼 ───────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; job-scraper/1.0)',
        'Accept': 'application/json',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location));
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout: ${url}`));
    });
  });
}

// ─── HTML 파싱 헬퍼 ──────────────────────────────────────────────────────────

function extractImages(html) {
  const imgs = [];
  const re = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[1];
    // 작은 아이콘/이모지 제외 (inthiswork CDN 또는 외부 이미지만)
    if (src && !src.includes('emoji') && !src.includes('1x1')) {
      imgs.push(src);
    }
  }
  return [...new Set(imgs)];
}

function extractApplyUrl(html) {
  // "지원하러 가기" 버튼 링크 추출
  const patterns = [
    /href=["']([^"']+)["'][^>]*>[^<]*지원하러\s*가기/i,
    /href=["']([^"']+)["'][^>]*>[^<]*지원\s*링크/i,
    /<a[^>]+class=["'][^"']*btn[^"']*["'][^>]+href=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1] && !m[1].startsWith('#') && !m[1].includes('inthiswork.com')) {
      return m[1];
    }
  }
  return null;
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#?\w+;/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── 상태 파일 ───────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { last_seen_id: 0 };
  }
}

function saveState(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

// ─── 명령어: init ────────────────────────────────────────────────────────────

function cmdInit() {
  const dirs = [
    CAREER_DIR,
    path.join(CAREER_DIR, '00_공고목록'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  console.log(JSON.stringify({ ok: true, dirs }));
}

// ─── 명령어: discover [page] ─────────────────────────────────────────────────

async function cmdDiscover(page) {
  const pageNum = Math.max(1, parseInt(page || '1', 10));
  const state = loadState();

  const apiUrl = new URL(`${API_BASE}/posts`);
  apiUrl.searchParams.set('categories', DEFAULT_CATEGORIES);
  apiUrl.searchParams.set('tags', DEFAULT_TAGS);
  apiUrl.searchParams.set('per_page', String(PER_PAGE));
  apiUrl.searchParams.set('orderby', 'id');
  apiUrl.searchParams.set('order', 'desc');
  apiUrl.searchParams.set('_fields', 'id,title,link,date');
  if (pageNum > 1) apiUrl.searchParams.set('page', String(pageNum));

  let resp;
  try {
    resp = await httpsGet(apiUrl.toString());
  } catch (e) {
    console.error(JSON.stringify({ error: 'network', message: e.message }));
    process.exit(1);
  }

  if (resp.status !== 200) {
    console.error(JSON.stringify({ error: 'api', status: resp.status, body: resp.body.slice(0, 200) }));
    process.exit(1);
  }

  let posts;
  try {
    posts = JSON.parse(resp.body);
  } catch (e) {
    console.error(JSON.stringify({ error: 'parse', message: e.message }));
    process.exit(1);
  }

  // page > 1: 과거 백필 — last_seen_id 필터 건너뜀
  const newPosts = pageNum > 1 ? posts : posts.filter((p) => p.id > state.last_seen_id);

  if (newPosts.length === 0) {
    console.log(JSON.stringify({ ok: true, new: 0 }));
    return;
  }

  newPosts.sort((a, b) => a.id - b.id);

  const jobs = newPosts.map((p) => ({
    id: p.id,
    title: stripHtml(p.title?.rendered || `공고 ${p.id}`),
    url: p.link,
    date: p.date ? p.date.slice(0, 10) : undefined,
  }));

  const chatJid = process.env.NANOCLAW_CHAT_JID;
  if (!chatJid) {
    console.error(JSON.stringify({ error: 'NANOCLAW_CHAT_JID not set' }));
    process.exit(1);
  }

  fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
  const filepath = path.join(IPC_MESSAGES_DIR, `job-scraper-${Date.now()}.json`);
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({
    type: 'keyboard_message',
    chatJid,
    text: `🆕 새 채용공고 ${jobs.length}건`,
    jobs,
  }));
  fs.renameSync(tmp, filepath);

  // page 1만 state 갱신 (백필은 state 변경 안 함)
  if (pageNum === 1) {
    saveState({ last_seen_id: Math.max(...jobs.map((j) => j.id)) });
  }

  console.log(JSON.stringify({ ok: true, new: jobs.length }));
}

// ─── 명령어: fetch-post <id> ─────────────────────────────────────────────────

async function cmdFetchPost(id) {
  const apiUrl = `${API_BASE}/posts/${id}?_fields=id,title,link,date,content,tags,meta`;

  let resp;
  try {
    resp = await httpsGet(apiUrl);
  } catch (e) {
    console.error(JSON.stringify({ error: 'network', message: e.message }));
    process.exit(1);
  }

  if (resp.status !== 200) {
    console.error(JSON.stringify({ error: 'api', status: resp.status }));
    process.exit(1);
  }

  let post;
  try {
    post = JSON.parse(resp.body);
  } catch (e) {
    console.error(JSON.stringify({ error: 'parse', message: e.message }));
    process.exit(1);
  }

  const html = post.content?.rendered || '';
  const images = extractImages(html);
  const applyUrl = extractApplyUrl(html);
  const contentText = stripHtml(html).slice(0, 2000); // 텍스트 미리보기 (최대 2000자)

  // 태그 슬러그 조회 (선택적 — 실패해도 계속)
  let tagSlugs = [];
  if (Array.isArray(post.tags) && post.tags.length > 0) {
    try {
      const tagResp = await httpsGet(`${API_BASE}/tags?include=${post.tags.join(',')}&_fields=id,name,slug`);
      if (tagResp.status === 200) {
        const tagData = JSON.parse(tagResp.body);
        tagSlugs = tagData.map((t) => t.name || t.slug);
      }
    } catch {
      // 태그 조회 실패는 무시
    }
  }

  // 마감일: publishpress_future_action.date (사이트가 공고 만료 시 draft로 전환하는 날짜 = 서류마감일)
  const ppfa = post.meta?.publishpress_future_action;
  const deadline = ppfa?.enabled && ppfa?.date ? ppfa.date.slice(0, 16).replace(' ', 'T') : null;

  console.log(JSON.stringify({
    id: post.id,
    title: post.title?.rendered ? stripHtml(post.title.rendered) : `공고 ${post.id}`,
    url: post.link,
    date: post.date ? post.date.slice(0, 10) : '',
    deadline,
    images,
    apply_url: applyUrl,
    content_text: contentText,
    tags: tagSlugs,
  }));
}

// ─── 명령어: next-seq ────────────────────────────────────────────────────────

function cmdNextSeq() {
  const dir = path.join(CAREER_DIR, '00_공고목록');
  if (!fs.existsSync(dir)) {
    console.log(JSON.stringify({ next: 1 }));
    return;
  }
  const files = fs.readdirSync(dir);
  let max = 0;
  for (const f of files) {
    const m = /^(\d+)_/.exec(f);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  console.log(JSON.stringify({ next: max + 1 }));
}

// ─── 진입점 ──────────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'init':
    cmdInit();
    break;
  case 'discover':
    await cmdDiscover(args[0]);
    break;
  case 'next-seq':
    cmdNextSeq();
    break;
  case 'fetch-post':
    if (!args[0]) {
      console.error(JSON.stringify({ error: 'fetch-post requires <id>' }));
      process.exit(1);
    }
    await cmdFetchPost(args[0]);
    break;
  default:
    console.error(JSON.stringify({
      error: 'unknown command',
      usage: 'scraper.mjs <init|discover [page]|next-seq|fetch-post <id>>',
    }));
    process.exit(1);
}
