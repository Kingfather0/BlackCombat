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

function bail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

if (!TICKET_URL) bail('TICKET_URL 환경변수가 없습니다.');
if (!TARGET_DATE || !/^\d{4}-\d{2}-\d{2}$/.test(TARGET_DATE)) bail('TARGET_DATE 환경변수가 없거나 형식이 잘못됐습니다. (예: 2026-07-26)');
if (!EVENT_KEY) bail('EVENT_KEY 환경변수가 없습니다.');
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) bail('SUPABASE_URL / SUPABASE_ANON_KEY 환경변수가 없습니다.');
if (!TICKET_BOT_SECRET) bail('TICKET_BOT_SECRET 환경변수가 없습니다.');

const targetDayNum = String(parseInt(TARGET_DATE.split('-')[2], 10));

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

async function postSnapshot(grades, roundLabel, note) {
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
      p_totals: null,
      p_note: note || null,
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
  try {
    console.log('▶ 기록 대상 event_key:', EVENT_KEY);
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
    await page.waitForTimeout(1500);

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
      await postSnapshot(grades, null, '회차 구분 없이 페이지 전체에서 추출');
      recorded++;
    } else {
      for (const line of roundLines) {
        const timeMatch = line.match(/\d{1,2}:\d{2}/);
        const grades = parseGrades(line);
        if (Object.keys(grades).length === 0) continue;
        await postSnapshot(grades, `${TARGET_DATE} ${timeMatch[0]}`, null);
        recorded++;
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
