// 좌석 총원(total) 데이터가 실제로 어떤 API 응답에 어떤 모양으로 들어있는지 확인하기 위한
// 1회성 진단 스크립트입니다. (본 운영 스크립트인 ticket-watch.js와는 별개)
//
// 페이지 로딩부터 날짜 클릭까지 진행하면서 오가는 JSON 네트워크 응답을 전부 가로채서,
// 요청 주소와 응답 내용 일부를 그대로 로그에 찍습니다. 실제 저장은 하지 않습니다(읽기 전용).
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

  const seen = [];
  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const url = res.url();
      const status = res.status();
      let bodySnippet = '';
      try {
        const text = await res.text();
        bodySnippet = text.slice(0, 1500);
      } catch (_) {}
      seen.push({ url, status, bodySnippet });
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
      await page.waitForTimeout(2500);
    } else {
      console.log('ℹ️ 날짜 버튼을 못 찾았습니다 (그래도 지금까지 잡힌 네트워크 응답은 로그로 남깁니다).');
    }

    // 회차/시간처럼 보이는 걸 하나 더 클릭해본다 (좌석맵 진입 시도)
    const roundCandidates = await page.$$('button, [role="button"], li, a');
    for (const el of roundCandidates.slice(0, 200)) {
      const text = (await el.innerText().catch(() => '')).trim();
      if (/^\d{1,2}:\d{2}/.test(text)) {
        console.log('▶ 회차로 보이는 요소 클릭 시도:', text.slice(0, 30));
        await el.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(2500);
        break;
      }
    }
    await page.waitForTimeout(1500);

    console.log(`\n===== 가로챈 JSON 응답 ${seen.length}건 (최대 25건만 출력) =====\n`);
    seen.slice(0, 25).forEach((s, i) => {
      console.log(`--- [${i + 1}] status=${s.status} ---`);
      console.log('URL:', s.url);
      console.log('BODY(앞부분):', s.bodySnippet);
      console.log('');
    });
    if (seen.length === 0) {
      console.log('(JSON 응답을 하나도 못 잡았습니다 — content-type이 json이 아니거나, 데이터가 처음부터 HTML에 박혀서 오는 방식일 수 있습니다)');
    }

    await page.screenshot({ path: 'ticket-diag.png', fullPage: true }).catch(() => {});
  } catch (err) {
    console.error('❌ 진단 중 오류:', err && err.message ? err.message : String(err));
    await page.screenshot({ path: 'ticket-diag.png', fullPage: true }).catch(() => {});
  }
  await browser.close();
})();
