// 좌석배치도(좌석 하나하나가 그려지는 화면)에서 "총 좌석수"를 자동으로 셀 수 있는지
// 확인하기 위한 1회성 진단 스크립트입니다. (운영 스크립트인 ticket-watch.js와는 별개, 읽기 전용)
//
// 확인하는 것 두 가지:
//   1. 좌석배치도가 실제 DOM 요소(원/버튼 같은 것)로 그려지는지, 아니면 <canvas>에 그림으로만
//      그려져서 우리가 낱개로 셀 수 없는 방식인지
//   2. 날짜/회차를 클릭하는 과정에서 좌석 총원이 담긴 JSON 응답이 오가는지 (NOL 자체 기준)
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
      const status = res.status();
      let bodySnippet = '';
      try {
        const text = await res.text();
        // 좌석/총원 관련 응답만 골라서 좀 더 길게 보여준다 (그 외엔 앞부분만)
        const looksSeatRelated = /seat|grade|remain|total|capacity|좌석|잔여|총/i.test(text);
        bodySnippet = text.slice(0, looksSeatRelated ? 4000 : 300);
      } catch (_) {}
      seenJson.push({ url, status, bodySnippet });
    } catch (_) {}
  });

  try {
    console.log('▶ 접속:', TICKET_URL);
    await page.goto(TICKET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    console.log('🔎 페이지 제목:', await page.title().catch(() => ''));

    const dateBtn = await tryFindDateButton(page);
    if (dateBtn) {
      console.log(`▶ ${targetDayNum}일 버튼 클릭`);
      await dateBtn.click().catch(() => {});
      await page.waitForTimeout(2000);
    } else {
      console.log('ℹ️ 날짜 버튼을 못 찾았습니다.');
    }

    // 회차(시간)로 보이는 요소를 찾아서 클릭 — 좌석배치도까지 들어가 보기 위함
    const roundCandidates = await page.$$('button, [role="button"], li, a');
    let clickedRound = false;
    for (const el of roundCandidates.slice(0, 300)) {
      const text = (await el.innerText().catch(() => '')).trim();
      if (/^\d{1,2}:\d{2}/.test(text)) {
        console.log('▶ 회차로 보이는 요소 클릭 시도:', text.slice(0, 30));
        await el.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(3000);
        clickedRound = true;
        break;
      }
    }
    if (!clickedRound) console.log('ℹ️ 회차 버튼을 못 찾았습니다 (날짜 클릭만으로 좌석배치도가 나오는 구조일 수도 있음).');

    await page.waitForTimeout(2000);

    // ── ① 좌석배치도가 DOM으로 그려지는지, canvas로 그려지는지 확인 ──
    const canvasCount = await page.locator('canvas').count().catch(() => -1);
    const svgCircleCount = await page.locator('svg circle').count().catch(() => -1);
    const svgRectCount = await page.locator('svg rect').count().catch(() => -1);
    const seatClassCount = await page.locator('[class*="seat" i]').count().catch(() => -1);
    const seatDataCount = await page.locator('[data-seat], [data-seat-id], [data-seatid]').count().catch(() => -1);

    console.log('\n===== 좌석배치도 DOM 구조 확인 =====');
    console.log('canvas 요소 개수:', canvasCount);
    console.log('svg > circle 요소 개수:', svgCircleCount);
    console.log('svg > rect 요소 개수:', svgRectCount);
    console.log('class에 "seat" 포함된 요소 개수:', seatClassCount);
    console.log('data-seat* 속성 가진 요소 개수:', seatDataCount);

    // 개수가 그럴듯하게 많은(예: 수십~수천 개) 후보들의 실제 HTML 샘플을 몇 개만 출력
    async function sampleHTML(selector, label) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count > 0) {
        console.log(`\n--- ${label} 샘플 (총 ${count}개 중 최대 3개) ---`);
        for (let i = 0; i < Math.min(3, count); i++) {
          const html = await page.locator(selector).nth(i).evaluate(el => el.outerHTML).catch(() => '(읽기 실패)');
          console.log(`[${i}]`, html.slice(0, 400));
        }
      }
    }
    await sampleHTML('svg circle', 'svg circle');
    await sampleHTML('[class*="seat" i]', 'class*=seat');
    await sampleHTML('[data-seat], [data-seat-id], [data-seatid]', 'data-seat*');

    // ── ② 지금까지 잡힌 JSON 네트워크 응답 ──
    console.log(`\n===== 가로챈 JSON 응답 ${seenJson.length}건 (최대 20건만 출력, 좌석/총원 관련으로 보이는 건 더 길게) =====\n`);
    seenJson.slice(0, 20).forEach((s, i) => {
      console.log(`--- [${i + 1}] status=${s.status} ---`);
      console.log('URL:', s.url);
      console.log('BODY:', s.bodySnippet);
      console.log('');
    });

    await page.screenshot({ path: 'ticket-seatmap-diag.png', fullPage: true }).catch(() => {});
  } catch (err) {
    console.error('❌ 진단 중 오류:', err && err.message ? err.message : String(err));
    await page.screenshot({ path: 'ticket-seatmap-diag.png', fullPage: true }).catch(() => {});
  }
  await browser.close();
})();
