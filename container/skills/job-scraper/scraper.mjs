#!/usr/bin/env node
/**
 * job-scraper/scraper.mjs
 * inthiswork.com 채용공고 탐색 및 레지스트리 관리
 *
 * 명령어:
 *   init                  — 필요 디렉토리 및 파일 초기화
 *   discover              — 신규 공고 탐색 (레지스트리 미등록 항목만)
 *   fetch-post <id>       — 특정 공고 내용 가져오기
 *   mark-scraped <url>    — URL을 스크랩 완료로 마킹
 *   mark-seen <url>       — URL을 확인함으로 마킹 (저장 없이 건너뜀)
 *
 * 의존성: Node.js 내장 모듈만 사용 (https, fs, path, url)
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── 경로 설정 ───────────────────────────────────────────────────────────────

const OBSIDIAN_ROOT = '/workspace/extra/obsidian';
const CAREER_DIR = path.join(OBSIDIAN_ROOT, 'A.Career');
const REGISTRY_FILE = path.join(CAREER_DIR, '.job-registry.json');
const CONFIG_FILE = path.join(CAREER_DIR, '.job-scraper-config.json');

// inthiswork WordPress REST API
const API_BASE = 'https://inthiswork.com/wp-json/wp/v2';
// 카테고리 ID: 신입/인턴=191700167, 주니어경력=191700168
const DEFAULT_CATEGORIES = '191700167,191700168';
// 태그 ID: 대기업=191700264, 공공기관=191700269, IT개발=191700187, 공채=191700391
// categories AND tags 조합 → 해당 카테고리 중 해당 태그가 붙은 것만 반환
const DEFAULT_TAGS = '191700264,191700269,191700187,191700391';
const FIELDS = 'id,title,link,date,tags,tag_slugs';
const FIELDS_WITH_CONTENT = 'id,title,link,date,content,tags,tag_slugs';
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

// ─── 레지스트리 ──────────────────────────────────────────────────────────────

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_FILE)) return {};
  const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    // 손상된 파일 — 백업 후 에러 보고 (조용히 빈 객체 반환하면 데이터 유실)
    const backup = REGISTRY_FILE + '.corrupted.' + Date.now();
    fs.writeFileSync(backup, raw, 'utf8');
    process.stderr.write(JSON.stringify({ error: 'registry_corrupted', backup, message: e.message }) + '\n');
    process.exit(1);
  }
}

function saveRegistry(registry) {
  // 원자적 쓰기: tmp 파일에 먼저 쓰고 rename (같은 파일시스템이면 atomic)
  const tmpFile = REGISTRY_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(registry, null, 2), 'utf8');
  fs.renameSync(tmpFile, REGISTRY_FILE);
}

// 파일 락 — 동시 mark-seen/mark-scraped 호출 시 race condition 방지
function withRegistryLock(fn) {
  const lockFile = REGISTRY_FILE + '.lock';
  const maxRetries = 50; // 최대 5초 대기
  let acquired = false;

  for (let i = 0; i < maxRetries; i++) {
    try {
      // O_EXCL: 파일이 없을 때만 생성 (POSIX atomic)
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      acquired = true;
      break;
    } catch {
      // 락 파일 존재 — 100ms busy-wait
      const end = Date.now() + 100;
      while (Date.now() < end) { /* spin */ }
    }
  }

  if (!acquired) {
    process.stderr.write(JSON.stringify({ error: 'lock_timeout', message: 'registry lock 획득 실패 (5초 초과)' }) + '\n');
    process.exit(1);
  }

  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockFile); } catch { /* 무시 */ }
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
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

  if (!fs.existsSync(REGISTRY_FILE)) {
    fs.writeFileSync(REGISTRY_FILE, '{}', 'utf8');
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    const defaultConfig = {
      categories: DEFAULT_CATEGORIES,
      tags: DEFAULT_TAGS,
      per_page: PER_PAGE,
      created_at: new Date().toISOString(),
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), 'utf8');
  }

  console.log(JSON.stringify({ ok: true, dirs, registry: REGISTRY_FILE, config: CONFIG_FILE }));
}

// ─── 명령어: discover ────────────────────────────────────────────────────────

async function cmdDiscover() {
  const config = loadConfig();
  const categories = config.categories || DEFAULT_CATEGORIES;
  const tags = config.tags || DEFAULT_TAGS;
  const perPage = config.per_page || PER_PAGE;

  const apiUrl = `${API_BASE}/posts?per_page=${perPage}&categories=${categories}&tags=${tags}&_fields=${FIELDS}&orderby=date&order=desc`;

  let resp;
  try {
    resp = await httpsGet(apiUrl);
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

  const registry = loadRegistry();
  const newPosts = [];

  for (const post of posts) {
    const url = post.link;
    if (registry[url]) continue; // 이미 확인함

    // 태그 이름 추출 (REST API는 tag slug 배열을 별도로 안 줌 — 제목에서 태그 힌트)
    const tags = Array.isArray(post.tags) && post.tags.length > 0
      ? post.tags  // 태그 ID 배열 (숫자)
      : [];

    newPosts.push({
      id: post.id,
      title: post.title?.rendered ? stripHtml(post.title.rendered) : `공고 ${post.id}`,
      url,
      date: post.date ? post.date.slice(0, 10) : '',
      tags,  // ID 배열 (fetch-post에서 slug로 변환)
    });
  }

  console.log(JSON.stringify({
    new: newPosts,
    total_new: newPosts.length,
    total_checked: posts.length,
  }));
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

// ─── 명령어: discover-latest <n> ────────────────────────────────────────────
// 레지스트리와 무관하게 최신 N개 공고를 반환 (스크랩 여부 표시 포함)

async function cmdDiscoverLatest(n, page) {
  const count = parseInt(n, 10);
  if (!count || count < 1) {
    console.error(JSON.stringify({ error: 'discover-latest requires a positive integer <n>' }));
    process.exit(1);
  }
  const pageNum = Math.max(1, parseInt(page, 10) || 1);

  const config = loadConfig();
  const categories = config.categories || DEFAULT_CATEGORIES;
  const tags = config.tags || DEFAULT_TAGS;

  const apiUrl = `${API_BASE}/posts?per_page=${Math.min(count, 100)}&page=${pageNum}&categories=${categories}&tags=${tags}&_fields=${FIELDS}&orderby=date&order=desc`;

  let resp;
  try {
    resp = await httpsGet(apiUrl);
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

  const registry = loadRegistry();

  const result = posts.slice(0, count).map((post) => ({
    id: post.id,
    title: post.title?.rendered ? stripHtml(post.title.rendered) : `공고 ${post.id}`,
    url: post.link,
    date: post.date ? post.date.slice(0, 10) : '',
    tags: Array.isArray(post.tags) ? post.tags : [],
    registry_status: registry[post.link]?.status ?? 'new',  // 'new' | 'seen' | 'scraped'
  }));

  console.log(JSON.stringify({ posts: result, total: result.length, page: pageNum }));
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

// ─── 명령어: mark-all-seen ───────────────────────────────────────────────────
// 현재 API에서 조회되는 모든 공고를 "seen"으로 일괄 마킹 (최초 기준점 설정용)

async function cmdMarkAllSeen() {
  const config = loadConfig();
  const categories = config.categories || DEFAULT_CATEGORIES;
  const tags = config.tags || DEFAULT_TAGS;
  const perPage = config.per_page || PER_PAGE;

  const apiUrl = `${API_BASE}/posts?per_page=${perPage}&categories=${categories}&tags=${tags}&_fields=id,link&orderby=date&order=desc`;

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

  let posts;
  try {
    posts = JSON.parse(resp.body);
  } catch (e) {
    console.error(JSON.stringify({ error: 'parse', message: e.message }));
    process.exit(1);
  }

  let marked = 0;
  const now = new Date().toISOString();
  withRegistryLock(() => {
    const registry = loadRegistry();
    for (const post of posts) {
      if (!registry[post.link]) {
        registry[post.link] = { status: 'seen', at: now };
        marked++;
      }
    }
    saveRegistry(registry);
  });
  console.log(JSON.stringify({ ok: true, marked, total: posts.length }));
}


// ─── 진입점 ──────────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'init':
    cmdInit();
    break;
  case 'discover-latest':
    await cmdDiscoverLatest(args[0] || '10', args[1] || '1');
    break;
  case 'next-seq':
    cmdNextSeq();
    break;
  case 'mark-all-seen':
    await cmdMarkAllSeen();
    break;
  case 'discover':
    await cmdDiscover();
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
      usage: 'scraper.mjs <init|discover|discover-latest <n> [page]|mark-all-seen|next-seq|fetch-post <id>>',
    }));
    process.exit(1);
}
