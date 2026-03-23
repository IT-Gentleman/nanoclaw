# Job Scraper

inthiswork.com 채용공고를 자동으로 탐색하고 Obsidian vault에 저장하는 스킬.

## 전제 조건

- `/workspace/extra/obsidian` — Obsidian vault 마운트 지점
- `/workspace/extra/obsidian/A.Career/` — Career 폴더 (없으면 `node scraper.mjs init`으로 생성)
- git 환경 설정 완료 (add-git 스킬)

## 스크립트 위치

```
/home/node/.claude/skills/job-scraper/scraper.mjs
```

## 명령어

```bash
node /home/node/.claude/skills/job-scraper/scraper.mjs <command> [args]
```

| 명령어 | 설명 |
|--------|------|
| `init` | 필요 디렉토리 및 파일 초기화 |
| `discover` | 신규 공고 탐색 (레지스트리에 없는 것만 반환) |
| `fetch-post <id>` | 특정 공고 내용 가져오기 (id: 숫자) |
| `discover-latest <n>` | 최신 N개 공고 반환 (레지스트리 무관, 기본 10) |
| `next-seq` | 다음 파일 시퀀스 번호 반환 |

## 자동 탐색 (채용공고 체크)

### 1단계: 신규 공고 탐색

```bash
node /home/node/.claude/skills/job-scraper/scraper.mjs discover
```

출력 형식 (JSON):
```json
{
  "new": [
    {
      "id": 123,
      "title": "회사명 - 직군",
      "url": "https://inthiswork.com/archives/123",
      "date": "2024-01-15",
      "tags": ["대기업", "IT"]
    }
  ],
  "total_new": 5,
  "total_checked": 100
}
```

`new`가 빈 배열이면 "새로운 공고가 없습니다." 라고 답하고 종료.

### 2단계: send_job_list 툴로 공고 목록 전송

`send_job_list` MCP 툴을 호출해 번호 목록과 `/scrape` 명령 안내를 전송한다.
사용자가 `/scrape 1,3,5` (선택), `/scrape all` (전체), `/scrape skip` (건너뛰기) 명령으로 응답하면 호스트가 스크랩을 실행한다.
이 툴 호출 후 즉시 종료한다 — 사용자 응답을 기다리지 않는다.

```json
{
  "tool": "send_job_list",
  "text": "신규 채용공고 5건을 발견했습니다. 스크랩할 공고를 선택하세요:",
  "jobs": [
    {"id": 123, "title": "2026 한국철도공사 하반기 신입채용", "url": "https://inthiswork.com/archives/123", "date": "2024-01-15"},
    {"id": 456, "title": "현대자동차 2026 상반기 대졸 신입공채", "url": "https://inthiswork.com/archives/456", "date": "2024-01-14"}
  ]
}
```

**필수 규칙**:
- discover 결과의 `new` 배열을 **전체** `jobs`로 전달한다. 건수가 많아도 절대 생략/축약하지 않는다.
- `title`은 discover 결과의 원본 문자열을 **그대로** 사용한다. 재구성·재포맷·요약 금지.
- `url`은 반드시 포함한다. discover 결과에 url이 있으면 그대로 전달.
- `send_job_list` 호출이 실패하면 send_message로 텍스트 대체하지 말고, 에러 내용을 send_message로 보고한 뒤 즉시 종료한다.
- 목록 제시 시점에 아무것도 마킹하지 않는다. 마킹은 스크랩 단계(3~5단계)에서 수행한다.

### 3단계: 선택한 공고 스크랩

각 선택된 공고에 대해:

1. **내용 가져오기**:
   ```bash
   node /home/node/.claude/skills/job-scraper/scraper.mjs fetch-post <id>
   ```

   출력:
   ```json
   {
     "id": 123,
     "title": "회사명 - 직군",
     "url": "https://inthiswork.com/archives/123",
     "date": "2024-01-15",
     "deadline": "2026-03-27T10:59",
     "images": ["https://cdn.inthiswork.com/wp-content/uploads/2024/01/image.jpg"],
     "apply_url": "https://company.com/apply",
     "content_text": "공고 본문 텍스트...",
     "tags": ["대기업", "IT"]
   }
   ```

   `deadline`은 서류마감일시 (ISO 형식, 분 단위). `null`이면 마감일 미지정 공고.

2. **외부 링크 처리** (`apply_url`이 있을 경우):
   - 먼저 `WebFetch`로 시도
   - 응답이 500자 미만이거나 의미 있는 내용이 없으면 → `agent-browser` 사용
   - 외부 사이트는 "지원 링크" 섹션에 URL만 기재해도 무방

3. **Markdown 파일 작성**: 아래 형식으로 저장

### 4단계: 파일 저장

먼저 다음 시퀀스 번호 조회:
```bash
node /home/node/.claude/skills/job-scraper/scraper.mjs next-seq
```
출력: `{"next": 22}` (현재 최대 번호 + 1)

파일 경로: `/workspace/extra/obsidian/A.Career/00_공고목록/{seq}_{공고제목}.md`

파일명 규칙:
- 형식: `{seq}_{공고제목}.md`
  - 예: `22_2026 한국철도공사 하반기 신입채용.md`
- `seq`: `next-seq` 결과값 (각 파일마다 +1 증가)
- 공고제목: post title 원문 그대로 사용 (파일명 불가 문자만 제거: `/\:*?"<>|`)
- 공백은 공백 그대로 유지 (언더스코어로 변환하지 않음)

Markdown 형식:
```markdown
---
source: inthiswork
url: https://inthiswork.com/archives/123
date: 2024-01-15
deadline: 2026-03-27T10:59
tags: [대기업, IT]
status: 검토중
---

# 회사명 - 직군

## 공고 이미지

![공고 이미지](https://cdn.inthiswork.com/wp-content/uploads/2024/01/image.jpg)

## 상세 내용

공고 본문 텍스트...

## 지원하기

- inthiswork: https://inthiswork.com/archives/123
- 공식 지원: https://company.com/apply
```

이미지가 여러 장이면 모두 포함. `content_text`가 짧거나 없으면 이미지만 포함해도 됨.

### 5단계: git 동기화

모든 파일 저장 후:
```bash
cd /workspace/extra/obsidian
git fetch origin main && git pull origin main
git add A.Career/
git commit -m "job: add N postings (YYYY-MM-DD)"
git push origin main
```

N = 실제 저장한 파일 수.

## 최신 공고 강제 조회 (기존 확인 여부 무관)

"최신 공고 N개 보여줘" / "최근 공고 다시 보여줘" 등의 요청 시:

```bash
node /home/node/.claude/skills/job-scraper/scraper.mjs discover-latest 10
```

출력:
```json
{
  "posts": [
    {
      "id": 123,
      "title": "회사명 - 직군",
      "url": "https://inthiswork.com/archives/123",
      "date": "2024-01-15",
      "registry_status": "seen"
    }
  ],
  "total": 10
}
```

`registry_status` 값:
- `new` — 레지스트리 미등록 (처음 보는 공고)
- `seen` — 이전에 확인함으로 처리
- `scraped` — 이미 스크랩 완료

`send_job_list` 툴로 목록 전송. `registry_status`를 title 앞에 표시해 사용자가 상태를 알 수 있도록 한다:

```json
{
  "tool": "send_job_list",
  "text": "최신 채용공고 10건:",
  "jobs": [
    {"id": 123, "title": "[스크랩완료] 2026 한국철도공사 하반기 신입채용", "url": "...", "date": "2024-01-15"},
    {"id": 456, "title": "[건너뜀] 현대자동차 2026 상반기 대졸 신입공채", "url": "...", "date": "2024-01-14"},
    {"id": 789, "title": "삼성전자 2026 상반기 공개채용", "url": "...", "date": "2024-01-13"}
  ]
}
```

선택된 공고 처리는 일반 스크랩 흐름과 동일.
`scraped` 상태인 공고를 다시 선택한 경우에도 덮어쓰기로 처리.

## 수동 스크랩 (URL 직접 제공)

사용자가 URL을 직접 제공한 경우:

1. URL이 inthiswork.com인지 확인
   - inthiswork: URL에서 post ID 추출 후 `fetch-post <id>` 실행
   - 외부 사이트: `WebFetch` → 실패 시 `agent-browser`

2. 내용 파싱 후 동일한 Markdown 형식으로 저장

3. git fetch/pull → git add/commit/push

## 초기화 (최초 실행 시)

```bash
node /home/node/.claude/skills/job-scraper/scraper.mjs init
```

생성되는 항목:
- `/workspace/extra/obsidian/A.Career/` (없는 경우)
- `/workspace/extra/obsidian/A.Career/00_공고목록/` (없는 경우)
- `/workspace/extra/obsidian/A.Career/.job-registry.json` (없는 경우)
- `/workspace/extra/obsidian/A.Career/.job-scraper-config.json` (없는 경우)

### 기준점 설정 (첫 정기 스크랩 전 반드시 실행)

init 직후 현재 공고를 모두 "확인함"으로 선마킹해서 이후 정기 스크랩이 진짜 신규 공고만 잡도록 설정:

```bash
node /home/node/.claude/skills/job-scraper/scraper.mjs mark-all-seen
```

출력: `{"ok": true, "marked": 87, "total": 100}`

이 명령을 실행하지 않으면 첫 정기 스크랩에서 현재 API에 노출된 공고 전체(최대 100건)가 신규로 뜸.

## 오류 처리

- `discover` 실패 (네트워크): "inthiswork.com에 연결할 수 없습니다. 잠시 후 다시 시도해주세요."
- `fetch-post` 실패: 해당 공고만 건너뜀, 나머지 계속 처리
- git push 실패: 저장은 완료됨. "git push 실패 — 나중에 수동으로 push해주세요." 안내
