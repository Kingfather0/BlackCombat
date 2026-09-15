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
// 2026-09-15 추가 — 같은 행사를 "지정석/비지정" 같은 별도 상품 페이지 2개로 나눠 파는 경우
// (예: 야차클럽 "복마전" — 지정석 상품과 비지정 상품이 URL이 아예 다름):
//   TICKET_URL_ALT         (선택) 같은 행사의 두 번째 상품 페이지 주소. 채우면 두 페이지를
//                          모두 방문해서 등급별 잔여석을 하나로 합쳐(회차별로 병합) 기록한다.
//                          두 상품이 서로 다른 등급 이름을 쓴다고 가정한다(겹치면 나중 값이 덮어씀).
//   TICKET_URL_LABEL       (선택) 기본 버튼 문구 — 비우면 TICKET_URL_ALT가 있을 때 "지정석",
//                          없을 때는 빈 문자열(기존처럼 그냥 "예매하러 가기")
//   TICKET_URL_ALT_LABEL   (선택) 두 번째 버튼 문구 — 기본값 "비지정"
// TICKET_URL_ALT가 비어 있으면 기존과 완전히 동일하게 동작한다(회귀 없음).
//
// 실패해도 사이트 자체는 멈추지 않습니다 — 이번 회차 기록만 건너뜁니다.
// 실패 원인 파악용으로 ticket-debug.png 스크린샷을 남깁니다(워크플로에서 아티팩트로 업로드).
//
// ※ 참고: 티켓 사이트 화면 구조는 언제든 바뀔 수 있습니다. 실제 티켓이 오픈된 뒤
//   workflow_dispatch(수동 실행)로 먼저 한 번 테스트해보고, 잘 안 잡히면 이 파일의
//   findAndClickDate() / parseGrades() 부분을 화면 구조에 맞게 손봐야 할 수도 있습니다.

const { chromium } = require('playwright');

const TICKET_URL = process.env.TICKET_URL;
const TICKET_URL_ALT = process.env.TICKET_URL_ALT || '';
const TICKET_URL_LABEL = process.env.TICKET_URL_LABEL || (TICKET_URL_ALT ? '지정석' : '');
const TICKET_URL_ALT_LABEL = process.env.TICKET_URL_ALT_LABEL || '비지정';
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
// 2026-09-15: 지정석/비지정처럼 같은 행사를 상품 페이지 2개로 나눠 파는 경우, 이 문자열이
// 두 상품에서 정확히 똑같이 나와야(같은 날짜·시간이면) 회차별 병합이 제대로 된다 — 그래서
// 상품마다 다를 수 있는 정보(등급명 등)는 전혀 안 쓰고 오직 날짜/시간만으로 만든다.
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
function extractMeta(bodyText, pageTitle, h1Title) {
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

  const skipExact = ['로그인', '회원가입', '장바구니', '메뉴', '검색', '고객센터', 'NOL', '홈', '일반 예매', '인터파크', '마이', '찜', '최근 본 상품'];
  const skipPattern = /^(일반\s*예매|장소|기간|시간|연령|D-\d+|\d{1,2}\.\d{1,2}|\d{1,2}월|\d{1,2}차|오픈예정|오픈\s*안내|(NOL|인터파크)\s*(티켓)?$|\d+\s*\/\s*\d+$)/;

  // 제목: 실측 결과 NOL 상품 페이지는 항상 <h1> 태그 하나에 행사명을 정확히 담고 있다
  // (2026-08-19 https://nol.yanolja.com/ticket/products/26011375 실측: h1 = "굽네 ROAD FC 078
  // with K-POP"). 화면 텍스트를 줄 단위로 훑어 "그럴듯한 첫 줄"을 추측하는 기존 방식은 상단
  // 네비게이션 구성이 바뀔 때마다("NOL 티켓" 브랜드 줄 → "마이/찜/장바구니/최근 본 상품" 메뉴
  // 줄 → 이미지 카운터 "1/1" 등) 매번 새로운 오탐 사례가 나오는 두더지잡기였다. h1은 페이지
  // 구조상 행사명 전용 자리라 훨씬 안정적이므로 최우선으로 쓰고, 혹시 h1을 못 찾은 경우에만
  // 아래 줄 단위 추측 → 탭 제목(document.title) 순으로 안전망을 둔다.
  if (h1Title) {
    const h1 = String(h1Title).trim();
    if (h1 && h1.length >= 2 && h1.length <= 80 && !skipExact.includes(h1) && !skipPattern.test(h1)) {
      meta.title = h1;
    }
  }

  // 안전망 1: h1을 못 찾았거나 못 믿을 값이었던 경우, 페이지 맨 위쪽 줄들 중 메뉴/버튼/날짜
  // 표기가 아닌 첫 번째 그럴듯한 줄을 후보로 삼는다. (사이트 구조가 바뀌면 다시 어긋날 수 있음)
  if (!meta.title) {
    for (const l of lines.slice(0, 15)) {
      if (l.length < 2 || l.length > 60) continue;
      if (skipExact.includes(l)) continue;
      if (skipPattern.test(l)) continue;
      meta.title = l;
      break;
    }
  }

  // 안전망 2: 그래도 못 찾은 경우, 브라우저 탭 제목(document.title)에서 뽑아본다. 사이트들이
  // 보통 "행사명 - NOL 티켓" / "행사명 | 인터파크" 처럼 행사명을 맨 앞에 두고 사이트명을 뒤에
  // 구분자로 붙이므로, 맨 앞 구분자 이전 조각을 쓰고 그 조각 자체가 브랜드명뿐이면 버린다.
  if (!meta.title && pageTitle) {
    const head = String(pageTitle).split(/\s*[-|::·]\s*/)[0].trim();
    if (head && head.length >= 2 && head.length <= 60 && !skipExact.includes(head) && !/^(NOL|인터파크)(\s*티켓)?$/.test(head)) {
      meta.title = head;
    }
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
//
// 2026-08-20 추가: "판매 도중 새 등급이 풀리는" 경우도 처리한다. 실제 사례 — 로드FC가 경기를
// 앞두고 낮 12시에 VIP 플로어(1열)/(2열) 좌석을 추가 오픈했는데, 기존 로직은 "회차의 첫
// 기록"에서만 총원을 추정해서 뒤늦게 등장한 새 등급은 총원을 영영 모르는 채로 남았다(사이트에
// 판매율 막대 없음, 전체 좌석 합계에도 미반영 — 북마클릿을 수동으로 다시 돌려야만 채워졌다).
// 이제 직전 기록들에 한 번도 없던 등급이 새로 나타나면, 그 등급의 "처음 목격 시점 잔여석 =
// 총원"으로 추정해(추가 오픈 직후의 첫 수집이므로 실제 총원과 거의 같다) 기존에 알고 있던
// 총원에 합쳐서 기록한다. 새 등급이 없으면 totals를 아예 기록하지 않는다(null) — 사이트는
// "totals가 담긴 가장 최근 기록"을 총원의 기준으로 쓰기 때문에, 일부 등급만 담긴 totals를
// 함부로 기록하면 북마클릿이 좌석맵을 실제로 세어 넣어둔 정확한 총원을 덮어쓰게 된다.
// 같은 이유로 합칠 때도 기존에 알던 값을 그대로 두고 새 등급만 보탠다.
//
// 2026-09-15: 지정석/비지정처럼 두 상품을 합쳐서 기록하는 경우에도 이 함수는 그대로 쓸 수
// 있다 — 호출부(main)에서 두 상품의 grades를 먼저 하나로 합친 뒤 이 함수를 부르기 때문에,
// 여기서는 "지정/비지정"을 구분할 필요 없이 그냥 등급별 총원 추정만 하면 된다.
async function computeTotalsToRecord(grades, roundLabel) {
  const priorCount = await fetchExistingSnapshotCount(roundLabel);
  if (priorCount === null) return null; // 확인 자체에 실패 — 추정하지 않는다(안전)
  if (priorCount === 0) {
    const totals = {};
    for (const g of Object.keys(grades)) totals[g] = grades[g].remain;
    console.log(`🆕 ${roundLabel ? `[${roundLabel}] ` : ''}첫 기록으로 보여, 지금 잔여석을 총원으로 기록합니다:`, JSON.stringify(totals));
    return totals;
  }
  try {
    const params = new URLSearchParams({
      event_key: `eq.${EVENT_KEY}`,
      select: 'grades,totals,meta',
      order: 'captured_at.desc',
      limit: '200',
    });
    if (roundLabel) params.set('round_label', `eq.${roundLabel}`);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/ticket_snapshots?${params.toString()}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!res.ok) return null;
    const rows = await res.json().catch(() => null);
    if (!Array.isArray(rows) || !rows.length) return null;
    // 최근 기록(최대 200건)에서 세 가지를 모은다:
    //  1) known    — 잔여/총원 어느 쪽에든 한 번이라도 등장한 등급(일시적 API 누락으로 기존
    //                등급을 새 등급으로 오인하지 않기 위해 여러 기록을 함께 본다)
    //  2) prevTotals — 가장 최근에 알아낸 등급별 총원(북마클릿 캡처 또는 이 함수의 과거 기록)
    //  3) maxRemain  — 등급별로 지금까지 목격된 최대 잔여석(총원 소급 추정용)
    const known = new Set();
    let prevTotals = null;
    let prevExact = null; // 북마클릿이 실제 좌석 데이터에서 센 정확한 등급별 총원(meta.gradeTotals)
    const maxRemain = {};
    for (const r of rows) {
      for (const k of Object.keys(r.grades || {})) {
        known.add(k);
        const v = r.grades[k];
        if (v && v.remain != null) maxRemain[k] = Math.max(maxRemain[k] != null ? maxRemain[k] : -1, v.remain);
      }
      for (const k of Object.keys(r.totals || {})) known.add(k);
      if (!prevTotals && r.totals && Object.keys(r.totals).length) prevTotals = r.totals;
      if (!prevExact && r.meta && r.meta.gradeTotals && Object.keys(r.meta.gradeTotals).length) prevExact = r.meta.gradeTotals;
    }
    // 실측값(북마클릿 캡처)이 있으면 추정치 위에 덮어써서 "알고 있는 총원"의 기준으로 삼는다 —
    // 이 함수가 낡은 추정치를 근거로 실측보다 작은 총원을 다시 기록하는 일을 막는다.
    // (실사례: 추가 오픈된 VIP 플로어 1열/2열을 최대 잔여석 기준 31/40석으로 추정했지만
    //  실측은 35/45석 — 첫 수집 전에 이미 몇 석이 팔린 만큼 추정이 항상 작거나 같다.)
    if (prevExact) prevTotals = Object.assign({}, prevTotals || {}, prevExact);
    // 총원을 새로 알게 되거나 고쳐야 하는 등급을 찾는다. 세 가지 경우:
    //  A) 완전히 처음 보는 등급(추가 오픈 직후의 첫 수집) — 지금 잔여석 = 총원으로 추정
    //  B) 잔여석은 이미 쌓이고 있는데 총원만 모르는 등급 — 이 백필 로직이 생기기 전에 추가
    //     오픈된 등급(실사례: VIP 플로어 1열/2열 — 북마클릿의 등급 총원/가격 소스에도 새
    //     등급이 안 담겨 있어 수동 캡처로도 총원이 안 채워졌다). 오픈 이후 목격된 최대
    //     잔여석을 총원으로 소급 추정한다(오픈 직후 기록일수록 실제 총원에 가깝다).
    //  C) 알고 있던 총원보다 잔여석이 더 커진 등급 = 기존 등급에 좌석이 추가로 풀림 — 총원을
    //     그만큼 올려잡는다(안 그러면 판매수가 음수가 되어 표시가 깨진다).
    const changes = {};
    const why = [];
    for (const g of Object.keys(grades)) {
      const v = grades[g];
      if (!v || v.remain == null) continue;
      const seenMax = Math.max(v.remain, maxRemain[g] != null ? maxRemain[g] : -1);
      if (seenMax <= 0) continue; // 목격된 좌석이 0뿐인 등급은 총원 추정이 무의미
      const knownTotal = prevTotals ? prevTotals[g] : null;
      if (!known.has(g)) {
        changes[g] = v.remain; why.push(`${g}: 신규 등장(잔여 ${v.remain} = 총원)`);
      } else if (prevTotals && knownTotal == null) {
        changes[g] = seenMax; why.push(`${g}: 총원 미기록 소급(최대 잔여 ${seenMax} = 총원)`);
      } else if (knownTotal != null && seenMax > knownTotal) {
        changes[g] = seenMax; why.push(`${g}: 좌석 추가 감지(총원 ${knownTotal} → ${seenMax})`);
      }
    }
    if (!Object.keys(changes).length) return null; // 바꿀 게 없으면 총원을 아예 기록하지 않는다(기존 값 보존)
    const merged = Object.assign({}, prevTotals || {}, changes);
    console.log(`🆕 ${roundLabel ? `[${roundLabel}] ` : ''}등급별 총원 갱신 — ${why.join(' / ')}`);
    console.log('   기록할 총원:', JSON.stringify(merged));
    return merged;
  } catch (_) {
    return null;
  }
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

// 상품 페이지 1개를 방문해서 "회차별 등급 잔여석"과 "행사 정보(meta)"를 긁어온다.
// TICKET_URL 하나만 쓰던 기존 로직을 그대로 옮긴 것뿐 — 상품 페이지 2개(지정/비지정)를
// 각각 이 함수로 따로 방문한 뒤 main에서 결과를 회차 단위로 합친다.
//
// 반환값:
//   { status: 'ok',        gradesByRound: Map<roundLabel, {grade:{remain}}>, meta, apiInfo }
//   { status: 'sold_out' }        — 이 상품은 판매 종료 상태 (정상, 에러 아님)
//   { status: 'not_open_yet' }    — 아직 판매 시작 전 (정상, 에러 아님)
// 그 외 문제는 예외(throw)로 알린다 — 호출하는 쪽에서 처리.
async function scrapeTicketPage(context, url, label) {
  const tag = label ? `[${label}] ` : '';
  const page = await context.newPage();
  const capturedRemainByPlaySeq = new Map(); // playSeq -> {VIP:{remain:5}, ...}
  const capturedScheduleByPlaySeq = new Map(); // playSeq -> {playDate, playTime, saleOpenTime}
  let capturedGoodsCode = null; // 사이트의 "수동 갱신(실시간 조회)" 버튼이 쓸 API 주소 재료

  // NOL은 화면에 회차/잔여석을 그려주기 전에, 자체 API에서 깨끗한 JSON으로 그 데이터를
  // 받아온다는 걸 진단 과정에서 확인했다 (/ticket/products/api/remaining-seats,
  // /ticket/products/api/schedules). 화면 텍스트를 정규식으로 긁는 것보다 이 응답을
  // 직접 읽는 게 훨씬 정확하고 화면 구조가 바뀌어도 잘 안 깨지므로, 날짜/회차를 클릭하는
  // 동안 이 응답들이 지나가면 가로채서 저장해둔다. (여기서 못 잡으면 기존처럼 화면 텍스트
  // 파싱으로 자동 대체됨 — 안전망은 그대로 유지)
  page.on('response', async (res) => {
    try {
      const resUrl = res.url();
      if (/\/api\/remaining-seats/.test(resUrl)) {
        try { capturedGoodsCode = new URL(resUrl).searchParams.get('goodsCode') || capturedGoodsCode; } catch (_) {}
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
      } else if (/\/api\/schedules/.test(resUrl)) {
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
    console.log(`▶ ${tag}티켓 페이지 접속:`, url);
    // networkidle(요청이 완전히 잠잠해질 때까지 대기)은 채팅위젯/광고/분석 스크립트가
    // 계속 백그라운드 통신을 하는 요즘 사이트에서는 영영 안 걸릴 수 있어 타임아웃이 잦다.
    // 대신 HTML만 로드되면 넘어가고, 뒤이어 자바스크립트 렌더링 시간을 넉넉히 기다린다.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    const pageTitle = await page.title().catch(() => '(제목 없음)');
    const diagText = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 600);
    console.log(`🔎 ${tag}페이지 제목:`, pageTitle);
    console.log(`🔎 ${tag}화면 텍스트(앞부분 600자):`, diagText || '(비어 있음 — 아무 텍스트도 못 읽었습니다)');

    // 실제 상품 화면이 아니라 클라우드플레어 등의 봇 차단 페이지가 뜬 경우, 명확하게 구분해서 알린다
    // ("판매 종료"와는 다른 문제 — 접속 자체가 막힌 것이므로 재시도/우회가 필요함).
    if (/UNDER CONSTRUCTION|RayID|일시적으로 서비스를 이용하실 수 없습니다/i.test(diagText + ' ' + pageTitle)) {
      throw new Error(`${tag}봇 차단 페이지가 표시되었습니다 (실제 티켓 페이지가 아님). 접속 IP가 자동화 트래픽으로 감지되어 막힌 것으로 보입니다.`);
    }

    // 제목/장소/기간/오픈안내는 달력을 누르기 전, 페이지 상단에 이미 나와 있는 경우가 많다.
    // (날짜를 클릭하면 회차별 잔여석이 나오는 것과는 별개 정보라 여기서 미리 읽어둔다)
    const fullBodyText = await page.innerText('body').catch(() => '');
    // 2026-08-19: 줄 단위 추측이 상단 네비게이션 변화("NOL 티켓" → "마이/찜/장바구니" 등)에
    // 계속 오탐을 내서, 실제 행사명이 항상 담기는 <h1> 태그를 최우선 소스로 함께 넘긴다.
    const h1Title = await page.locator('h1').first().innerText({ timeout: 3000 }).catch(() => '');
    const meta = extractMeta(fullBodyText, pageTitle === '(제목 없음)' ? '' : pageTitle, h1Title);
    meta.buyUrl = url;
    meta.platform = 'NOL 티켓';
    console.log(`🔎 ${tag}자동 추출된 행사 정보:`, JSON.stringify(meta));

    const dateBtn = await findAndClickDate(page);
    if (!dateBtn) {
      // 달력이 아예 없는 상황(판매 종료/판매 예정 등)인지 먼저 확인한다.
      // 이런 경우는 스크립트나 화면 구조 문제가 아니라 "지금은 기록할 게 없다"는 정상 상태이므로,
      // 실패(빨간 X)로 처리하지 않고 조용히 넘어간다.
      const preText = await page.innerText('body').catch(() => '');
      if (/판매\s*종료/.test(preText)) {
        console.log(`ℹ️ ${tag}이 상품은 판매가 종료된 상태입니다. 기록할 내용이 없습니다.`);
        await page.close().catch(() => {});
        return { status: 'sold_out' };
      }
      if (/판매\s*(예정|대기|전)|오픈\s*예정/.test(preText)) {
        console.log(`ℹ️ ${tag}아직 판매 시작 전(오픈 예정) 상태로 보입니다. 기록할 내용이 없습니다.`);
        await page.close().catch(() => {});
        return { status: 'not_open_yet' };
      }
      throw new Error(
        `${tag}달력에서 ${targetDayNum}일 버튼을 찾지 못했습니다. (판매 종료/예정 문구도 없었습니다 — 화면 구조가 예상과 다를 수 있습니다)`
      );
    }
    await dateBtn.click();
    await page.waitForTimeout(2000); // API 응답이 도착할 시간을 조금 더 준다

    const gradesByRound = new Map(); // roundLabel -> {grade:{remain}}
    let apiInfo = null;

    if (capturedRemainByPlaySeq.size > 0) {
      // NOL 자체 API에서 잔여석 JSON을 직접 받았으면, 화면 텍스트를 긁는 것보다 이게 훨씬
      // 정확하고 화면 구조 변경에도 안 깨지므로 이쪽을 우선 사용한다.
      console.log(`🔗 ${tag}API에서 ${capturedRemainByPlaySeq.size}개 회차의 잔여석 응답을 직접 받았습니다 (화면 텍스트 대신 이걸 우선 사용).`);
      for (const [playSeq, grades] of capturedRemainByPlaySeq) {
        if (Object.keys(grades).length === 0) continue;
        const sched = capturedScheduleByPlaySeq.get(playSeq);
        const roundLabel = sched ? formatRoundLabel(sched.playDate, sched.playTime) : `${TARGET_DATE} (playSeq ${playSeq})`;
        gradesByRound.set(roundLabel, grades);
        // 이 회차의 API 좌표(goodsCode/playSeq) — 사이트의 "수동 갱신" 버튼이 쓴다.
        // 두 상품을 합치는 경우, 첫 번째(지정석) 상품 것만 대표로 쓴다(수동 갱신은 그쪽만 지원).
        if (!apiInfo && capturedGoodsCode) apiInfo = { goodsCode: capturedGoodsCode, playSeq };
      }
    } else {
      // 안전망: API 응답을 못 잡았을 경우, 기존처럼 화면 텍스트를 정규식으로 긁는다.
      console.log(`ℹ️ ${tag}API 응답을 못 잡았습니다 — 화면 텍스트 파싱 방식으로 대체합니다.`);
      const bodyText = await page.innerText('body').catch(() => '');
      const lines = bodyText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const roundLines = lines.filter((l) => /\d{1,2}:\d{2}/.test(l) && /석/.test(l));

      if (roundLines.length === 0) {
        const grades = parseGrades(bodyText);
        if (Object.keys(grades).length > 0) gradesByRound.set(null, grades);
      } else {
        for (const line of roundLines) {
          const timeMatch = line.match(/\d{1,2}:\d{2}/);
          const grades = parseGrades(line);
          if (Object.keys(grades).length === 0) continue;
          const roundLabel = formatRoundLabel(TARGET_DATE, timeMatch[0]);
          const existing = gradesByRound.get(roundLabel);
          gradesByRound.set(roundLabel, existing ? Object.assign({}, existing, grades) : grades);
        }
      }
    }

    await page.close().catch(() => {});
    if (gradesByRound.size === 0) {
      throw new Error(`${tag}날짜는 클릭했지만 등급별 잔여석 정보를 화면에서 찾지 못했습니다.`);
    }
    return { status: 'ok', gradesByRound, meta, apiInfo };
  } catch (err) {
    await page.screenshot({ path: 'ticket-debug.png', fullPage: true }).catch(() => {});
    await page.close().catch(() => {});
    throw err;
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

  try {
    console.log('▶ 기록 대상 event_key:', EVENT_KEY);
    if (SET_CURRENT) await setCurrentTicketEvent();
    else console.log('ℹ️ 보조 대회 기록 모드(SET_CURRENT=false) — 사이트 메인 표시는 건드리지 않고 데이터만 쌓습니다.');

    const primary = await scrapeTicketPage(context, TICKET_URL, TICKET_URL_ALT ? (TICKET_URL_LABEL || '상품1') : '');

    if (primary.status === 'sold_out' || primary.status === 'not_open_yet') {
      // 대표 상품 자체가 아직 볼 게 없는 상태면(오픈 예정/판매 종료), 두 번째 상품도 굳이
      // 확인할 필요 없이 그대로 정상 종료한다 — 같은 행사라 상태가 보통 같이 바뀐다.
      await browser.close();
      process.exit(0);
    }

    const gradesByRound = primary.gradesByRound; // roundLabel -> grades (병합 대상)
    const meta = primary.meta;
    let apiInfo = primary.apiInfo;

    if (TICKET_URL_ALT) {
      try {
        const alt = await scrapeTicketPage(context, TICKET_URL_ALT, TICKET_URL_ALT_LABEL);
        if (alt.status === 'ok') {
          for (const [roundLabel, grades] of alt.gradesByRound) {
            const existing = gradesByRound.get(roundLabel);
            gradesByRound.set(roundLabel, existing ? Object.assign({}, existing, grades) : grades);
          }
          meta.buyUrl2 = TICKET_URL_ALT;
          console.log(`✅ 두 번째 상품(${TICKET_URL_ALT_LABEL}) 병합 완료.`);
        } else {
          console.log(`ℹ️ 두 번째 상품(${TICKET_URL_ALT_LABEL})은 지금 기록할 내용이 없어(오픈 예정/판매 종료) 첫 번째 상품만으로 기록합니다.`);
          meta.buyUrl2 = TICKET_URL_ALT; // 버튼은 미리 보여줘도 무방(오픈되면 자동으로 값이 참)
        }
      } catch (e) {
        console.error(`⚠️ 두 번째 상품(${TICKET_URL_ALT_LABEL}) 확인 중 오류 — 이번엔 건너뛰고 첫 번째 상품만 기록합니다: ` + (e && e.message ? e.message : String(e)));
        meta.buyUrl2 = TICKET_URL_ALT;
      }
      // 2026-09-15: "지정석 예매하기"/"비지정 예매하기"(+ 미리보기의 "현재 티켓으로 돌아가기")
      // 버튼 3개가 한 줄에 안 들어가고 줄바꿈되는 문제가 있어 문구를 "예매하기"→"예매"로 줄임
      // (preview.html의 버튼 줄 CSS도 함께 손봄 — 그쪽 주석 참고).
      meta.buyLabel = (TICKET_URL_LABEL ? `${TICKET_URL_LABEL} ` : '') + '예매';
      meta.buyLabel2 = `${TICKET_URL_ALT_LABEL} 예매`;
    }

    let recorded = 0;
    for (const [roundLabel, grades] of gradesByRound) {
      if (!grades || Object.keys(grades).length === 0) continue;
      const totals = await computeTotalsToRecord(grades, roundLabel);
      const metaForRound = apiInfo ? Object.assign({}, meta, { api: apiInfo }) : meta;
      const note = TICKET_URL_ALT ? `NOL API 응답에서 직접 추출 (${TICKET_URL_LABEL || '상품1'}+${TICKET_URL_ALT_LABEL} 병합)` : 'NOL API 응답에서 직접 추출';
      await postSnapshot(grades, roundLabel, note, totals, metaForRound);
      recorded++;
    }

    if (recorded === 0) throw new Error('파싱된 회차가 없어 기록하지 못했습니다.');
    console.log(`✅ ${recorded}개 회차 기록 완료`);
  } catch (err) {
    console.error('❌ ' + (err && err.message ? err.message : String(err)));
    await browser.close();
    process.exit(1);
  }
  await browser.close();
})();
