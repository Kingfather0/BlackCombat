// 좌석배치도(실제 색깔 점이 그려지는 화면, 예매 진행 시 보이는 그 화면)까지 들어가서
// 총 좌석수(정원)를 찾을 수 있는 단서가 있는지 확인하는 1회성 진단 스크립트입니다.
// (운영 스크립트인 ticket-watch.js와는 별개, 읽기 전용)
//
// 지난 진단(ticket-seatmap-diag.js)에서는 날짜+회차까지만 눌러봤고, 거기서는 잔여석
// API(remaining-seats)만 확인됐습니다(총원 필드 없음). 이번엔 한 단계 더 들어가서
// "좌석선택"/"예매하기" 같은 버튼까지 눌러 실제 좌석배치도 화면을 열어보고,
//   1) 화면에 보이는 버튼들 이름을 전부 나열 (어떤 버튼을 눌러야 할지 모르니 우선 확인)
//   2) 그 버튼을 눌렀을 때 DOM 구조(canvas/svg 개수)와
//   3) 그때 오가는 JSON 네트워크 응답
// 을 전부 로그로 남깁니다.
//
// 필요한 환경변수: TICKET_URL, TARGET_DATE (YYYY-MM-DD)

const { chromium } = require('playwright');

const TICKET_URL = process.env.TICKET_URL;
const TARGET_DATE = process.env.TARGET_DATE;

if (!TICKET_URL) { console.error('❌ TICKET_URL 환경변수가 없습니다.'); process.exit(1); }
if (!TARGET_DATE || !/^\d{4}-\d{2}-\d{2}$/.test(TARGET_DATE)) { console.error('❌ TARGET_DATE 형식이 잘못됐습니다.'); process.exit(1); }
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
    if (disabled) continue;
    if (/disabled|other-month|outside|dim|inactive/i.test(classAttr)) continue;
    return el;
  }
  return null;
}

async function domCounts(page) {
  return {
    canvas: await page.locator('canvas').count().catch(() => -1),
    svgCircle: await page.locator('svg circle').count().catch(() => -1),
    svgRect: await page.locator('svg rect').count().catch(() => -1),
    svgPath: await page.locator('svg path').count().catch(() => -1),
    seatClass: await page.locator('[class*="seat" i]').count().catch(() => -1),
    seatData: await page.locator('[data-seat], [data-seat-id], [data-seatid]').count().catch(() => -1),
  };
}

(async () => {
  const browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  const seenJson = [];
  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const url = res.url();
      if (/sentry|kinesis|cognito|googleapis|gen_204/i.test(url)) return; // 분석/광고성 잡음은 제외
      const status = res.status();
      let bodySnippet = '';
      try {
        const text = await res.text();
        const looksSeatRelated = /seat|grade|remain|total|capacity|hall|venue|floor|section|좌석|잔여|총|정원|구역/i.test(text);
        bodySnippet = text.slice(0, looksSeatRelated ? 6000 : 300);
      } catch (_) {}
      seenJson.push({ url, status, bodySnippet });
    } catch (_) {}
  });

  try {
    console.log('▶ 접속:', TICKET_URL);
    await page.goto(TICKET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    const dateBtn = await tryFindDateButton(page);
    if (dateBtn) {
      console.log(`▶ ${targetDayNum}일 버튼 클릭`);
      await dateBtn.click().catch(() => {});
      await page.waitForTimeout(2500);
    } else {
      console.log('ℹ️ 날짜 버튼을 못 찾았습니다.');
    }

    console.log('\n===== 날짜 클릭 후 DOM 구조 =====');
    console.log(JSON.stringify(await domCounts(page)));

    // 화면에 보이는 클릭 가능한 요소 이름을 전부 나열 (중복 제거, 너무 긴 건 자름)
    const clickable = await page.$$('button, [role="button"], a');
    const labels = new Set();
    for (const el of clickable) {
      const text = (await el.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
      if (text && text.length <= 40) labels.add(text);
    }
    console.log('\n===== 현재 화면의 클릭 가능한 요소 이름들 (중복 제거) =====');
    console.log(JSON.stringify([...labels]));

    // 회차(시간)로 보이는 요소 클릭
    const roundCandidates = await page.$$('button, [role="button"], li, a');
    let clickedRound = false;
    for (const el of roundCandidates.slice(0, 300)) {
      const text = (await el.innerText().catch(() => '')).trim();
      if (/^\d{1,2}:\d{2}/.test(text)) {
        console.log('\n▶ 회차로 보이는 요소 클릭 시도:', text.slice(0, 30));
        await el.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(2500);
        clickedRound = true;
        break;
      }
    }
    if (!clickedRound) console.log('ℹ️ 회차 버튼을 못 찾았습니다.');

    console.log('\n===== 회차 클릭 후 DOM 구조 =====');
    console.log(JSON.stringify(await domCounts(page)));

    const clickable2 = await page.$$('button, [role="button"], a');
    const labels2 = new Set();
    for (const el of clickable2) {
      const text = (await el.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
      if (text && text.length <= 40) labels2.add(text);
    }
    console.log('\n===== 회차 클릭 후 클릭 가능한 요소 이름들 (중복 제거) =====');
    console.log(JSON.stringify([...labels2]));

    // "예매"/"좌석"/"선택"/"구매" 등이 포함된 버튼을 찾아서 눌러 좌석배치도 진입을 시도
    let enteredSeatMap = false;
    for (const el of clickable2) {
      const text = (await el.innerText().catch(() => '')).trim();
      if (/예매하기|좌석\s*선택|좌석선택|구매하기|다음\s*단계|예매\s*진행/.test(text) && text.length <= 20) {
        console.log('\n▶ 좌석배치도 진입 버튼으로 보이는 요소 클릭 시도:', text);
        await el.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(4000);
        enteredSeatMap = true;
        break;
      }
    }
    if (!enteredSeatMap) console.log('\nℹ️ "예매하기/좌석선택" 같은 버튼을 못 찾았습니다.');

    console.log('\n===== 좌석배치도 진입 시도 후 DOM 구조 =====');
    console.log(JSON.stringify(await domCounts(page)));

    console.log(`\n===== 지금까지 가로챈 JSON 응답 ${seenJson.length}건 (최대 20건, 좌석/총원 관련은 더 길게) =====\n`);
    seenJson.slice(0, 20).forEach((s, i) => {
      console.log(`--- [${i + 1}] status=${s.status} ---`);
      console.log('URL:', s.url);
      console.log('BODY:', s.bodySnippet);
      console.log('');
    });

    await page.screenshot({ path: 'ticket-seatmap-diag2.png', fullPage: true }).catch(() => {});
  } catch (err) {
    console.error('❌ 진단 중 오류:', err && err.message ? err.message : String(err));
    await page.screenshot({ path: 'ticket-seatmap-diag2.png', fullPage: true }).catch(() => {});
  }
  await browser.close();
})();
