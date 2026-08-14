// 티켓 판매 현황 자동 기록 스크립트 (GitHub Actions에서 주기적으로 실행)
//
// NOL티켓/인터파크 같은 예매 페이지는 좌석 잔여 수량을 자바스크립트로 그려주기
// 때문에 일반적인 fetch로는 볼 수 없습니다. 그래서 이 스크립트는 진짜 브라우저
// (Playwright)로 페이지를 열어서, 사람이 보는 것과 똑같은 화면 텍스트를 읽습니다.
//
// 동작 순서:
//   1. TICKET_URL 접속
//   2. 달력에서 TARGET_DATE(공연/경기 날짜) 클릭
//   3. 화면에 나온 회차별 "OO석 N" 같은 잔여 좌석 요약을 긁어서 파싱
//   4. Supabase record_ticket_snapshot 함수를 호출해 기록
//
// 필요한 환경변수:
//   TICKET_URL          예매 페이지 주소 (예: https://nol.yanolja.com/ticket/products/26010059)
//   TARGET_DATE          잡을 날짜, YYYY-MM-DD 형식 (예: 2026-07-26)
//   EVENT_KEY             이 행사를 구분하는 키 (예: bc_2026_07_lotte) — 사이트 표시용
//   SUPABASE_URL           기존 사이트와 동일한 값
//   SUPABASE_ANON_KEY      기존 사이트와 동일한 값
//   TICKET_BOT_SECRET      티켓현황_패치.sql 에서 설정한 "봇 전용 비밀키"
//
// 실패해도 사이트 자체는 멈추지 않습니다 — 이번 회차 기록만 건너뜁니다.
// 실패 원인 파악용으로 ticket-debug.png 스크린샷을 남깁니다(워크플로에서 아티팩트로 업로드).
//
// ※ 참고: 티켓 사이트 화면 구조는 언제든 바뀔 수 있습니다. 실제 티켓이 오픈된 뒤
//   workflow_dispatch(수동 실행)로 먼저 한 번 테스트해보고, 잘 안 잡히면 이 파일의
//   findAndClickDate() / parseGrades() 부분을 화면 구조에 맞게 손봐야 할 수도 있습니다.

const { chromium } = require('playwright');

const TICKET_URL = process.env.TICKET_URL;
const TARGET_DATE = process.env.TARGET_DATE; // '2026-07-26'
const EVENT_KEY = process.env.EVENT_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TICKET_BOT_SECRET = process.env.TICKET_BOT_SECRET;
// SET_CURRENT: 'false'면 "사이트가 지금 볼 event_key" 포인터를 갱신하지 않는다.
// 메인 대회(예: 블랙컴뱃)와 보조 대회(예: 지난 대회로 내려간 로드FC)를 동시에 기록할 때,
// 보조 대회 기록이 사이트 메인 화면을 뺏어가지 않게 하기 위한 옵션. (기본값: 갱신함)
const SET_CURRENT = process.env.SET_CURRENT !== 'false';

function bail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

if (!TICKET_URL) bail('TICKET_URL 환경변수가 없습니다.');
if (!TARGET_DATE || !/^\d{4}-\d{2}-\d{2}$/.test(TARGET_DATE)) bail('TARGET_DATE 환경변수가 없거나 형식이 잘못됐습니다. (예: 2026-07-26)');
if (!EVENT_KEY) bail('EVENT_KEY 환경변수가 없습니다.');
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) bail('SUPABASE_URL / SUPABASE_ANON_KEY 환경변수가 없습니다.');
if (!TICKET_BOT_SECRET) bail('TICKET_BOT_SECRET 환경변수가 없습니다.');

// 티켓 판매는 경기 당일(TARGET_DATE)로 끝나므로, 그 다음 날부터는 기록을 자동 정지한다.
// (Variables를 지우거나 스케줄을 끄는 걸 잊어도 의미 없는 기록/실패가 쌓이지 않게 하는 안전장치.
//  경기 당일까지는 정상 기록됨. 한국시간 기준으로 판단한다.)
const kstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
if (kstToday > TARGET_DATE) {
  console.log(`⏹️ ${EVENT_KEY}: 경기일(${TARGET_DATE})이 지나 티켓 판매가 종료되었습니다 — 기록을 정지합니다. (오늘: ${kstToday} KST)`);
  process.exit(0);
}

const targetDayNum = String(parseInt(TARGET_DATE.split('-')[2], 10));

// 회차 이름을 "YYYY.MM.DD(요일) h:mm AM/PM" 형식으로 통일해서 만든다.
// (북마클릿이 로그인 후 실제 좌석맵 화면에서 그대로 읽어오는 표기와 정확히 같은 형식으로
//  맞춰야, 이 자동 스크립트가 기록한 회차와 북마클릿으로 수동 기록한 같은 회차가
//  round_label 문자열이 달라서 서로 다른 회차로 갈라지는 일이 없다.)
function formatRoundLabel(dateStr, timeStr) {
  const dm = String(dateStr || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  const tm = String(timeStr || '').match(/(\d{1,2}):(\d{2})/);
  if (!dm || !tm) return `${dateStr || ''} ${timeStr || ''}`.trim(); // 형식이 예상과 다르면 원본 그대로(안전망)
  const [, y, mo, d] = dm;
  const h = parseInt(tm[1], 10);
  const mi = tm[2];
  const dow = ['일', '월', '화', '수', '목', '금', '토'][new Date(Number(y), Number(mo) - 1, Number(d)).getDay()];
  const ampm = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${y}.${mo}.${d}(${dow}) ${h12}:${mi} ${ampm}`;
}

async function tryFindDateButton(page) {
  const candidates = await page.$$(
    '[class*="calendar"] button, [class*="Calendar"] button, [class*="date"] button, [role="gridcell"] button, td button, [role="gridcell"], td[class*="day"]'
  );
  for (const el of candidates) {
    const text = (await el.innerText().catch(() => '')).trim();
    if (text !== targetDayNum) continue;
    const disabled = await el.isDisabled().catch(() => false);
    const classAttr = (await el.getAttribute('class').catch(() => '')) || '';
    const ariaDisabled = (await el.getAttribute('aria-disabled').catch(() => '')) || '';
    if (disabled || ariaDisabled === 'true') continue;
    if (/disabled|other-month|outside|dim|inactive/i.test(classAttr)) continue;
    return el;
  }
  return null;
}

async function findAndClickDate(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const btn = await tryFindDateButton(page);
    if (btn) return btn;
    const nextBtn = await page
      .$('[aria-label*="다음"], [class*="next"]:not([class*="disabled"]), button:has-text("›"), button:has-text(">")')
      .catch(() => null);
    if (!nextBtn) break;
    await nextBtn.click().catch(() => {});
    await page.waitForTimeout(600);
  }
  return null;
}

function parseGrades(text) {
  // "VIP석 5", "R석: 22", "S석 매진" 등 다양한 표기를 최대한 넓게 잡는다.
  const grades = {};
  const re = /([A-Za-z가-힣]{1,6}석)\s*[:\-]?\s*(매진|\d[\d,]*)/g;
  let m;
  while ((m = re.exec(text))) {
    const gradeName = m[1].replace(/석$/, '');
    const remain = m[2] === '매진' ? 0 : parseInt(m[2].replace(/,/g, ''), 10);
    grades[gradeName] = { remain };
  }
  return grades;
}

// 티켓 제목/장소/기간/오픈안내를 화면 텍스트에서 최대한 뽑아낸다.
// NOL 상품 페이지는 보통 이런 구조로 나온다 (실제 관찰된 원문):
//   뮤지컬 〈엘리자벳〉
//   08.20(목) 11:00
//   D-10 3차티켓오픈
//   장소
//   블루스퀘어 우리은행홀
//   기간
//   2026.08.16 ~ 2026.11.15
//   ...
//   3차 티켓오픈 : 8월 20일(목) 오전 11시
// 못 찾은 항목은 그냥 비워두고, 부르는 쪽(postSnapshot 호출부)에서 null로 넘어가면
// 사이트가 알아서 기존 값(TICKET_INFO 기본값)으로 대체해서 보여준다.
function extractMeta(bodyText) {
  const meta = {};
  const lines = bodyText.split('\n').map((s) => s.trim()).filter(Boolean);

  // "장소"/"기간" 라벨 줄 다음에 값이 여러 줄로 나뉘어 나오는 경우가 있다
  // (예: "장소" 다음 줄에 "블루스퀘어", 그 다음 줄에 "우리은행홀"이 따로 나옴 →
  // 합쳐서 "블루스퀘어 우리은행홀"이 되어야 함). 다음 라벨 줄이 나올 때까지 이어붙인다.
  // 페이지에 같은 이름의 라벨이 여러 번 나올 수도 있어서(예: 상단 탭 메뉴에도 "장소"라는
  // 글자가 있음), 처음으로 값을 제대로 찾은 것만 쓰고 그 이후 중복은 무시한다.
  const labelSet = new Set(['장소', '기간', '시간', '연령', '일반 예매']);
  for (let i = 0; i < lines.length; i++) {
    const isPlace = lines[i] === '장소' && meta.place == null;
    const isPeriod = lines[i] === '기간' && meta.dateText == null;
    if (!isPlace && !isPeriod) continue;
    const collected = [];
    let j = i + 1;
    while (j < lines.length && !labelSet.has(lines[j]) && collected.length < 3) {
      collected.push(lines[j]);
      j++;
    }
    if (!collected.length) continue;
    if (isPlace) meta.place = collected.join(' ');
    else meta.dateText = collected.join(' ');
  }

  const openMatch = bodyText.match(
    /(\d+차)?\s*티켓\s*오픈\s*[:：]?\s*(\d{1,2}월\s*\d{1,2}일\([가-힣]\)\s*(?:오전|오후)?\s*\d{1,2}시(?:\s*\d{1,2}분)?)/
  );
  if (openMatch) meta.openText = (openMatch[1] ? openMatch[1] + ' ' : '') + openMatch[2];

  // 제목: 페이지 맨 위쪽 줄들 중, 메뉴/버튼/날짜 표기가 아닌 첫 번째 그럴듯한 줄을 후보로 삼는다.
  // (사이트마다 구조가 조금씩 달라질 수 있어서 100% 정확하진 않음 — 못 찾으면 그냥 비워둔다)
  const skipExact = ['로그인', '회원가입', '장바구니', '메뉴', '검색', '고객센터', 'NOL', '홈', '일반 예매'];
  const skipPattern = /^(일반\s*예매|장소|기간|시간|연령|D-\d+|\d{1,2}\.\d{1,2}|\d{1,2}월|\d{1,2}차|오픈예정|오픈\s*안내)/;
  for (const l of lines.slice(0, 15)) {
    if (l.length < 2 || l.length > 60) continue;
    if (skipExact.includes(l)) continue;
    if (skipPattern.test(l)) continue;
    meta.title = l;
    break;
  }

  return meta;
}

// 같은 event_key + round_label로 이미 기록된 스냅샷이 있는지 확인한다.
// (총원 자동 추정에 쓰임 — 아래 참고)
async function fetchExistingSnapshotCount(roundLabel) {
  try {
    const params = new URLSearchParams({
      event_key: `eq.${EVENT_KEY}`,
      select: 'id',
      limit: '1',
    });
    if (roundLabel) params.set('round_label', `eq.${roundLabel}`);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/ticket_snapshots?${params.toString()}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!res.ok) return null;
    const rows = await res.json().catch(() => null);
    return Array.isArray(rows) ? rows.length : null;
  } catch (_) {
    return null;
  }
}

// 등급별 "총 좌석수"는 예매 사이트 화면 어디에도 직접 나오지 않는다(잔여석만 보여줌).
// 대신, 이 회차를 통틀어 우리가 "처음으로" 기록하는 순간이라면 그때의 잔여석 = 총원이라고
// 볼 수 있다(아직 아무도 안 샀을 가능성이 가장 높은 시점이므로). 이후 회차에는 그 총원을
// 기준으로 실제 판매 수/비율을 계산한다.
// 주의: 이미 판매가 어느 정도 진행된 뒤에 자동화를 처음 켠 경우에는 이 방식이 정확하지 않다
// (그 시점의 잔여석을 총원으로 잘못 볼 수 있음) — 그런 경우엔 그냥 총원 없이(null) 넘어가고,
// 지금까지처럼 잔여석만 보여주는 기존 방식 그대로 동작한다(회귀 없음).
async function estimateTotalsIfFirstSnapshot(grades, roundLabel) {
  const priorCount = await fetchExistingSnapshotCount(roundLabel);
  if (priorCount !== 0) return null; // 이미 기록이 있거나, 확인 자체에 실패한 경우엔 추정하지 않는다
  const totals = {};
  for (const g of Object.keys(grades)) totals[g] = grades[g].remain;
  return totals;
}

// 사이트가 "지금 어떤 event_key를 봐야 하는지"를 index.html에 손대지 않고도 알 수 있도록,
// 실행할 때마다 "지금 이 경기를 추적 중"이라고 Supabase에 알려둔다. 이 호출 자체가 실패해도
// (예: 아직 티켓현황_자동event_key_패치.sql을 안 돌렸다면) 전체 스크립트를 멈추지는 않는다 —
// 그 경우 사이트는 기존처럼 index.html에 하드코딩된 TICKET_EVENT_KEY로 대체 동작한다.
async function setCurrentTicketEvent() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/set_current_ticket_event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ p_secret: TICKET_BOT_SECRET, p_event_key: EVENT_KEY }),
    });
    if (!res.ok) {
      console.log('ℹ️ "지금 event_key" 갱신에 실패했습니다(패치를 아직 안 돌렸다면 정상) — 계속 진행합니다.');
    } else {
      console.log(`🔗 사이트가 자동으로 볼 event_key를 "${EVENT_KEY}"로 갱신했습니다.`);
    }
  } catch (_) {
    console.log('ℹ️ "지금 event_key" 갱신 중 오류 — 계속 진행합니다.');
  }
}

async function postSnapshot(grades, roundLabel, note, totals, meta) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_ticket_snapshot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      p_secret: TICKET_BOT_SECRET,
      p_event_key: EVENT_KEY,
      p_grades: grades,
      p_round_label: roundLabel || null,
      p_totals: totals || null,
      p_note: note || null,
      p_meta: meta && Object.keys(meta).length ? meta : null,
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Supabase 기록 실패 (${res.status}): ${bodyText}`);
  }
}

(async () => {
  // 클라우드플레어 등 봇 차단을 피하려고, 일반적인 데스크톱 크롬 사용자처럼 보이도록
  // User-Agent/언어/시간대를 지정하고 자동화 흔적(navigator.webdriver 등)을 숨긴다.
  const browser = await chromium.launch({
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();
  let recorded = 0;

  // NOL은 화면에 회차/잔여석을 그려주기 전에, 자체 API에서 깨끗한 JSON으로 그 데이터를
  // 받아온다는 걸 진단 과정에서 확인했다 (/ticket/products/api/remaining-seats,
  // /ticket/products/api/schedules). 화면 텍스트를 정규식으로 긁는 것보다 이 응답을
  // 직접 읽는 게 훨씬 정확하고 화면 구조가 바뀌어도 잘 안 깨지므로, 날짜/회차를 클릭하는
  // 동안 이 응답들이 지나가면 가로채서 저장해둔다. (여기서 못 잡으면 기존처럼 화면 텍스트
  // 파싱으로 자동 대체됨 — 안전망은 그대로 유지)
  const capturedRemainByPlaySeq = new Map(); // playSeq -> {VIP:{remain:5}, ...}
  const capturedScheduleByPlaySeq = new Map(); // playSeq -> {playDate, playTime, saleOpenTime}
  let capturedGoodsCode = null; // 사이트의 "수동 갱신(실시간 조회)" 버튼이 쓸 API 주소 재료
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (/\/api\/remaining-seats/.test(url)) {
        try { capturedGoodsCode = new URL(url).searchParams.get('goodsCode') || capturedGoodsCode; } catch (_) {}
        const json = await res.json().catch(() => null);
        if (json && Array.isArray(json.remainSeat)) {
          for (const row of json.remainSeat) {
            const seq = row.playSeq;
            if (!seq || !row.seatGradeName) continue;
            const gradeName = String(row.seatGradeName).replace(/석$/, '');
            const prev = capturedRemainByPlaySeq.get(seq) || {};
            prev[gradeName] = { remain: row.remainCnt };
            capturedRemainByPlaySeq.set(seq, prev);
          }
        }
      } else if (/\/api\/schedules/.test(url)) {
        const json = await res.json().catch(() => null);
        if (json && Array.isArray(json.content)) {
          for (const row of json.content) {
            if (row.playSeq) capturedScheduleByPlaySeq.set(row.playSeq, row);
          }
        }
      }
    } catch (_) {}
  });
  try {
    console.log('▶ 기록 대상 event_key:', EVENT_KEY);
    if (SET_CURRENT) await setCurrentTicketEvent();
    else console.log('ℹ️ 보조 대회 기록 모드(SET_CURRENT=false) — 사이트 메인 표시는 건드리지 않고 데이터만 쌓습니다.');
    console.log('▶ 티켓 페이지 접속:', TICKET_URL);
    // networkidle(요청이 완전히 잠잠해질 때까지 대기)은 채팅위젯/광고/분석 스크립트가
    // 계속 백그라운드 통신을 하는 요즘 사이트에서는 영영 안 걸릴 수 있어 타임아웃이 잦다.
    // 대신 HTML만 로드되면 넘어가고, 뒤이어 자바스크립트 렌더링 시간을 넉넉히 기다린다.
    await page.goto(TICKET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    // 진단용: 스크린샷을 따로 안 받아도 로그만 보고 "지금 실제로 브라우저가 뭘 보고 있는지"
    // 바로 알 수 있도록, 페이지 제목과 화면 텍스트 앞부분을 그대로 출력해둔다.
    const pageTitle = await page.title().catch(() => '(제목 없음)');
    const diagText = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 600);
    console.log('🔎 페이지 제목:', pageTitle);
    console.log('🔎 화면 텍스트(앞부분 600자):', diagText || '(비어 있음 — 아무 텍스트도 못 읽었습니다)');

    // 실제 상품 화면이 아니라 클라우드플레어 등의 봇 차단 페이지가 뜬 경우, 명확하게 구분해서 알린다
    // ("판매 종료"와는 다른 문제 — 접속 자체가 막힌 것이므로 재시도/우회가 필요함).
    if (/UNDER CONSTRUCTION|RayID|일시적으로 서비스를 이용하실 수 없습니다/i.test(diagText + ' ' + pageTitle)) {
      throw new Error('봇 차단 페이지가 표시되었습니다 (실제 티켓 페이지가 아님). 접속 IP가 자동화 트래픽으로 감지되어 막힌 것으로 보입니다.');
    }

    // 제목/장소/기간/오픈안내는 달력을 누르기 전, 페이지 상단에 이미 나와 있는 경우가 많다.
    // (날짜를 클릭하면 회차별 잔여석이 나오는 것과는 별개 정보라 여기서 미리 읽어둔다)
    const fullBodyText = await page.innerText('body').catch(() => '');
    const meta = extractMeta(fullBodyText);
    // 예매 페이지 주소도 기록에 남긴다 — 사이트의 "예매하러 가기" 버튼이 이 값을 우선 사용해서,
    // 행사가 바뀔 때마다 index.html의 하드코딩 주소(TICKET_INFO.buyUrl)를 고칠 필요가 없어진다.
    meta.buyUrl = TICKET_URL;
    console.log('🔎 자동 추출된 행사 정보:', JSON.stringify(meta));

    const dateBtn = await findAndClickDate(page);
    if (!dateBtn) {
      // 달력이 아예 없는 상황(판매 종료/판매 예정 등)인지 먼저 확인한다.
      // 이런 경우는 스크립트나 화면 구조 문제가 아니라 "지금은 기록할 게 없다"는 정상 상태이므로,
      // 실패(빨간 X)로 처리하지 않고 조용히 종료한다.
      const preText = await page.innerText('body').catch(() => '');
      if (/판매\s*종료/.test(preText)) {
        console.log('ℹ️ 이 상품은 판매가 종료된 상태입니다. 기록할 내용이 없어 정상 종료합니다.');
        await browser.close();
        process.exit(0);
      }
      if (/판매\s*(예정|대기|전)|오픈\s*예정/.test(preText)) {
        console.log('ℹ️ 아직 판매 시작 전(오픈 예정) 상태로 보입니다. 기록할 내용이 없어 정상 종료합니다.');
        await browser.close();
        process.exit(0);
      }
      throw new Error(
        `달력에서 ${targetDayNum}일 버튼을 찾지 못했습니다. (판매 종료/예정 문구도 없었습니다 — 화면 구조가 예상과 다를 수 있습니다)`
      );
    }
    await dateBtn.click();
    await page.waitForTimeout(2000); // API 응답이 도착할 시간을 조금 더 준다

    if (capturedRemainByPlaySeq.size > 0) {
      // NOL 자체 API에서 잔여석 JSON을 직접 받았으면, 화면 텍스트를 긁는 것보다 이게 훨씬
      // 정확하고 화면 구조 변경에도 안 깨지므로 이쪽을 우선 사용한다.
      console.log(`🔗 API에서 ${capturedRemainByPlaySeq.size}개 회차의 잔여석 응답을 직접 받았습니다 (화면 텍스트 대신 이걸 우선 사용).`);
      for (const [playSeq, grades] of capturedRemainByPlaySeq) {
        if (Object.keys(grades).length === 0) continue;
        const sched = capturedScheduleByPlaySeq.get(playSeq);
        const roundLabel = sched ? formatRoundLabel(sched.playDate, sched.playTime) : `${TARGET_DATE} (playSeq ${playSeq})`;
        const totals = await estimateTotalsIfFirstSnapshot(grades, roundLabel);
        if (totals) console.log(`🆕 [${roundLabel}] 첫 기록으로 보여, 지금 잔여석을 총원으로 기록합니다:`, JSON.stringify(totals));
        // 이 회차의 API 좌표(goodsCode/playSeq)를 meta에 같이 남긴다 — 사이트의 "수동 갱신"
        // 버튼이 5분 스케줄을 기다리지 않고 예매 사이트에서 즉석으로 잔여석을 조회할 때 쓴다.
        const metaForRound = capturedGoodsCode
          ? Object.assign({}, meta, { api: { goodsCode: capturedGoodsCode, playSeq } })
          : meta;
        await postSnapshot(grades, roundLabel, 'NOL API 응답에서 직접 추출', totals, metaForRound);
        recorded++;
      }
    } else {
      // 안전망: API 응답을 못 잡았을 경우, 기존처럼 화면 텍스트를 정규식으로 긁는다.
      console.log('ℹ️ API 응답을 못 잡았습니다 — 화면 텍스트 파싱 방식으로 대체합니다.');
      const bodyText = await page.innerText('body').catch(() => '');
      // 회차(시간)별로 줄을 나눠서, 시간 표기 + 등급/잔여석이 함께 있는 줄만 추린다.
      const lines = bodyText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const roundLines = lines.filter((l) => /\d{1,2}:\d{2}/.test(l) && /석/.test(l));

      if (roundLines.length === 0) {
        // 회차 목록이 한 줄로 안 묶여 있을 수도 있으니, 페이지 전체에서 한 번 더 시도한다.
        const grades = parseGrades(bodyText);
        if (Object.keys(grades).length === 0) {
          throw new Error('날짜는 클릭했지만 등급별 잔여석 정보를 화면에서 찾지 못했습니다.');
        }
        const totals = await estimateTotalsIfFirstSnapshot(grades, null);
        if (totals) console.log('🆕 이 회차의 첫 기록으로 보여, 지금 잔여석을 총원으로 기록합니다:', JSON.stringify(totals));
        await postSnapshot(grades, null, '회차 구분 없이 페이지 전체에서 추출', totals, meta);
        recorded++;
      } else {
        for (const line of roundLines) {
          const timeMatch = line.match(/\d{1,2}:\d{2}/);
          const grades = parseGrades(line);
          if (Object.keys(grades).length === 0) continue;
          const roundLabel = formatRoundLabel(TARGET_DATE, timeMatch[0]);
          const totals = await estimateTotalsIfFirstSnapshot(grades, roundLabel);
          if (totals) console.log(`🆕 [${roundLabel}] 첫 기록으로 보여, 지금 잔여석을 총원으로 기록합니다:`, JSON.stringify(totals));
          await postSnapshot(grades, roundLabel, null, totals, meta);
          recorded++;
        }
      }
    }

    if (recorded === 0) throw new Error('파싱된 회차가 없어 기록하지 못했습니다.');
    console.log(`✅ ${recorded}개 회차 기록 완료`);
  } catch (err) {
    await page.screenshot({ path: 'ticket-debug.png', fullPage: true }).catch(() => {});
    console.error('❌ ' + (err && err.message ? err.message : String(err)));
    await browser.close();
    process.exit(1);
  }
  await browser.close();
})();
