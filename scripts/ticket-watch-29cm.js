// 티켓 판매 현황 자동 기록 스크립트 — 29CM 버전 (GitHub Actions에서 주기적으로 실행)
//
// scripts/ticket-watch.js(NOL/인터파크용)와 결과물은 완전히 동일합니다 — 같은 Supabase
// record_ticket_snapshot 함수를 호출해서 같은 ticket_snapshots 테이블에 기록하므로,
// index.html 쪽 표시 코드는 전혀 손댈 필요가 없습니다. 다른 점은 "잔여석을 어떻게 알아내는가"
// 뿐입니다.
//
// NOL은 화면을 실제 브라우저(Playwright)로 열어서 봐야 하지만, 29CM 티켓
// (ticket.29cm.co.kr)은 로그인 없이도 접근 가능한 공개 JSON API를 그대로 제공합니다
// (2026-08-17 직접 확인: 쿠키 없이 fetch해도 200 응답, 로그인 화면으로 튕기지 않음).
// 그래서 이 스크립트는 브라우저 없이 순수 HTTP 요청만으로 동작합니다 (더 가볍고 빠르고
// 화면 구조 변경에도 덜 취약함).
//
// 확인된 API 흐름 (productMasterCode는 내부 상품코드로, 우리가 아는 카탈로그 번호와 다릅니다):
//   1. GET /api/public/product/ticket/item/code?itemId={catalogId}
//        → { data: productMasterCode }
//        (catalogId는 https://ticket.29cm.co.kr/catalog/{catalogId} 의 그 숫자)
//   2. GET /api/public/product/ticket/info?productMasterCode={pmc}
//        → 상품명/장소/가격/판매기간/공지사항 등 행사 메타 정보
//   3. GET /api/public/product/ticket/turn/info?productMasterCode={pmc}
//        → 회차(날짜/시간) 목록, 좌석 배치도가 있는 placeId도 여기서 얻는다
//   4. GET /api/public/product/ticket/turn/detail/seat/info?productMasterCode={pmc}&turnSequence={turn}
//        → 그 회차의 등급별 잔여석(quantityList)
//   5. GET /api/preempt/seat/info?productMasterCode={pmc}&turnSequence={turn}&placeId={placeId}
//        → 좌석 하나하나의 등급/판매상태가 담긴 전체 좌석배치(seatAssignUnits). 여기 있는
//          좌석을 등급별로 세면 "등급별 총원"을 추측이 아니라 정확한 숫자로 알 수 있다
//          (NOL 티켓을 로드FC 판매 중간에 웹사이트 코드를 직접 뜯어서 총 좌석 수를 확인했던
//          것과 같은 방식 — 2026-08-17 직접 확인: 이 상품은 VIP 100석 + 일반 442석 + 그 외
//          공개 판매 대상이 아닌 8석 = 총 550석으로, quantityList의 잔여석과도 정확히 들어맞음).
//          이 방식 덕분에 판매 도중에 추적을 시작해도(이미 일부 매진된 등급이 있어도) 총원이
//          항상 정확하다 — "처음 기록 = 총원"으로 추측하던 이전 방식보다 훨씬 신뢰할 수 있다.
//
// 필요한 환경변수:
//   ITEM_ID_29CM        29CM 티켓 상품 번호 (예: https://ticket.29cm.co.kr/catalog/3998565 → 3998565)
//   EVENT_KEY            이 행사를 구분하는 키 (예: bc_2026_29cm) — 사이트 표시용
//   TARGET_DATE          (선택) 경기/공연일 YYYY-MM-DD. 비우면 API에서 받은 공연일로 자동 판단.
//   SUPABASE_URL           기존 사이트와 동일한 값
//   SUPABASE_ANON_KEY      기존 사이트와 동일한 값
//   TICKET_BOT_SECRET      티켓현황_패치.sql 에서 설정한 "봇 전용 비밀키" (ticket-watch.js와 동일)
//   SET_CURRENT           'false'면 "사이트가 지금 볼 event_key" 포인터를 갱신하지 않는다.
//                          (메인 대회와 동시에 보조 대회를 기록할 때 메인 화면을 뺏지 않기 위한 옵션)
//
// 실패해도 사이트 자체는 멈추지 않습니다 — 이번 회차 기록만 건너뜁니다.

const ITEM_ID_29CM = process.env.ITEM_ID_29CM;
const EVENT_KEY = process.env.EVENT_KEY;
const TARGET_DATE = process.env.TARGET_DATE; // 없으면 API의 공연일로 대체
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TICKET_BOT_SECRET = process.env.TICKET_BOT_SECRET;
const SET_CURRENT = process.env.SET_CURRENT !== 'false';

const API_BASE = 'https://ticket.29cm.co.kr/api/public/product/ticket';
const ORDER_API_BASE = 'https://ticket.29cm.co.kr/api'; // 좌석배치(전체 좌석 수) 조회용 — /public 하위가 아님

// 수동 검증된 총원 오버라이드 (productMasterCode별) — 아래 fetchSeatBreakdown()이 쓰는
// preempt/seat/info(좌석배치도) API는 "통로 인접 열" 좌석 일부를 구조적으로 누락시키는 버그가
// 있음을 확인했습니다 (2026-08-18, 이 행사의 38개 구역 전체를 브라우저에서 직접 열어 캔버스에
// 실제로 그려진 좌석(Konva Rect)을 세어 좌석배치도 API 응답과 대조 — 골드/플로어석W/C4/A1
// 구역 등 대부분에서 API 쪽이 실제보다 적게 나옴, 총 762석 차이). 이 버그는 API가 고쳐지지
// 않는 한 자동 탐지로는 절대 바로잡을 수 없으므로, 이렇게 수동으로 확인된 총원을 우선 적용하는
// 안전장치를 둡니다. 여기 없는 productMasterCode는 기존처럼 fetchSeatBreakdown() 자동 탐지를
// 그대로 씁니다 — 다른 행사에는 영향이 없습니다.
const VERIFIED_TOTAL_OVERRIDE = {
  // 비앤디 블랙컴뱃 4강: 일본 vs 미국 (2026-08-29)
  // 자동 탐지값(좌석배치도 API 합산)은 3,891석으로 실제보다 762석 적게 나왔던 것을 아래 값으로
  // 바로잡습니다. 등급별 세부 총원(totals)은 이 버그의 영향을 그대로 받을 수 있어 오버라이드하지
  // 않고 fetchSeatBreakdown()의 자동 탐지값을 참고용으로만 둡니다 — "총 N석 중 M석 판매"처럼
  // 전체 합계를 보여주는 부분(overallTotal/sellableTotal)만 바로잡는 것이 목적입니다.
  1246: {
    overallTotal: 4653,
    sellableTotal: 4653,
    noGradeTotal: 0,
    verifiedNote: '2026-08-18 38개 구역 전수 시각 확인(Konva 렌더링 좌석 수 집계)',
  },
};

function bail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

if (!ITEM_ID_29CM) bail('ITEM_ID_29CM 환경변수가 없습니다. (예: https://ticket.29cm.co.kr/catalog/3998565 → 3998565)');
if (!EVENT_KEY) bail('EVENT_KEY 환경변수가 없습니다.');
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) bail('SUPABASE_URL / SUPABASE_ANON_KEY 환경변수가 없습니다.');
if (!TICKET_BOT_SECRET) bail('TICKET_BOT_SECRET 환경변수가 없습니다.');

// "2026. 08. 29" / "2026-08-29" 같은 값을 NOL 쪽(ticket-watch.js)과 동일한 "2026.08.29"
// 형식으로 짧게 바꾼다. 상단 행사 정보 카드의 "📅" 줄에 쓰인다 — 예전엔 turnDateTimeKrViewList의
// 긴 문장("2026년 8월 29일 (토) 오후 07시 00분")을 그대로 썼지만, 로드FC(NOL) 쪽과 표기가
// 달라 보기 불편하다는 피드백에 맞춰 통일한다.
function formatDateShortKo(dateStr) {
  const m = String(dateStr || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}.${String(mo).padStart(2, '0')}.${String(d).padStart(2, '0')}`;
}

// 회차 이름을 ticket-watch.js(NOL)와 똑같은 "YYYY.MM.DD(요일) h:mm AM/PM" 형식으로 만든다.
// (round_label 형식이 서로 다르면 같은 회차를 기록해도 갈라져 보일 수 있어서 통일해둔다)
function formatRoundLabel(isoDateTime) {
  const m = String(isoDateTime || '').match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return String(isoDateTime || '');
  const [, y, mo, d, hh, mi] = m;
  const dow = ['일', '월', '화', '수', '목', '금', '토'][new Date(Number(y), Number(mo) - 1, Number(d)).getDay()];
  const h = parseInt(hh, 10);
  const ampm = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${y}.${mo}.${d}(${dow}) ${h12}:${mi} ${ampm}`;
}

async function getJSON(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`요청 실패 (${res.status}): ${url}`);
  const json = await res.json();
  if (json.resultCode !== '200') throw new Error(`API 응답 오류: ${json.resultMessage || JSON.stringify(json)}`);
  return json.data;
}

// 29CM API가 주는 등급명("VIP 티켓", "일반 티켓" 등)에서 뒤에 붙는 "티켓"을 떼어 사이트
// 표시용 등급명("VIP", "일반")으로 통일한다. grades/totals/gradePrices 세 곳 모두 이 이름을
// 키로 써야 index.html에서 서로 매칭되므로, 한 곳에서만 정의해서 어긋나지 않게 한다.
function gradeDisplayName(seatGradeName, seatGradeCode) {
  return String(seatGradeName || '').replace(/\s*티켓$/, '').trim() || seatGradeCode;
}

// 29CM 상품명(productName) 맨 앞에 판매자가 내부 구분용으로 붙여둔 "[개인결제창]" 같은
// 대괄호 태그가 그대로 섞여 오는 경우가 있어, 사이트에는 그 태그를 떼고 실제 행사명만
// 보여준다. 태그 표기는 행사마다 다를 수 있어("[사전예매]" 등) 특정 문구를 지우는 대신
// "맨 앞 대괄호 한 덩어리"를 통째로 떼는 규칙으로 처리한다.
function stripLeadingTag(name) {
  return String(name || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim();
}

// 좌석배치도(seatAssignUnits)를 세어서 다음 세 가지를 정확하게 구한다 (NOL 티켓을 판매
// 중간에 웹사이트 코드를 직접 뜯어서 "전체 좌석 수 vs 실제 판매 대상 좌석 수"를 구분했던 것과
// 같은 방식 — index.html이 이미 meta.overallTotal/sellableTotal/noGradeTotal 세 값을 받아
// "ⓘ 좌석 기준" 안내 박스를 그리도록 만들어져 있으므로, 그 형식 그대로 채워 넣는다):
//   - totals: 등급별 총원 (quantityList에 있는, 즉 공개 판매 대상인 등급만)
//   - overallTotal: 좌석배치도에 있는 좌석 전체 개수 (등급 배정 여부와 무관하게 전부)
//   - sellableTotal: 그중 공개 판매 대상 등급(quantityList에 있는 등급)에 속한 좌석 수
//   - noGradeTotal: overallTotal - sellableTotal (판매 대상이 아닌/등급 미배정 좌석 수)
// 실패하면(엔드포인트가 막히는 등) null을 반환하고, 그 경우 호출부가
// estimateTotalsIfFirstSnapshot()으로 대체한다(안전망 — 회귀 없음).
async function fetchSeatBreakdown(productMasterCode, turnSequence, placeId, quantityList) {
  if (!placeId) return null;
  try {
    const data = await getJSON(
      `${ORDER_API_BASE}/preempt/seat/info?productMasterCode=${productMasterCode}&turnSequence=${turnSequence}&placeId=${placeId}`
    );
    const units = data && data.seatAssignUnits;
    if (!Array.isArray(units) || units.length === 0) return null;
    const countByCode = {};
    for (const u of units) {
      const code = u.seatGradeCode;
      if (code == null) continue;
      countByCode[code] = (countByCode[code] || 0) + 1;
    }
    const totals = {};
    let sellableTotal = 0;
    for (const q of quantityList) {
      const gradeName = gradeDisplayName(q.seatGradeName, q.seatGradeCode);
      const count = countByCode[q.seatGradeCode];
      if (count != null) { totals[gradeName] = count; sellableTotal += count; }
    }
    if (!Object.keys(totals).length) return null;
    const overallTotal = units.length;
    return { totals, overallTotal, sellableTotal, noGradeTotal: Math.max(0, overallTotal - sellableTotal) };
  } catch (e) {
    console.log('ℹ️ 좌석배치도에서 총원을 세는 데 실패했습니다 (' + (e.message || e) + ') — 대체 방식으로 넘어갑니다.');
    return null;
  }
}

// 위 방식이 실패했을 때만 쓰는 예전 방식(안전망): ticket-watch.js(NOL)와 같은 방식으로, 이
// 회차를 통틀어 우리가 "처음으로" 기록하는 순간이면 그때의 잔여석 = 총원으로 추측한다.
async function fetchExistingSnapshotCount(roundLabel) {
  try {
    const params = new URLSearchParams({ event_key: `eq.${EVENT_KEY}`, select: 'id', limit: '1' });
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

async function estimateTotalsIfFirstSnapshot(grades, roundLabel) {
  const priorCount = await fetchExistingSnapshotCount(roundLabel);
  if (priorCount !== 0) return null;
  const totals = {};
  for (const g of Object.keys(grades)) totals[g] = grades[g].remain;
  return totals;
}

async function setCurrentTicketEvent() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/set_current_ticket_event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ p_secret: TICKET_BOT_SECRET, p_event_key: EVENT_KEY }),
    });
    if (!res.ok) console.log('ℹ️ "지금 event_key" 갱신에 실패했습니다(패치를 아직 안 돌렸다면 정상) — 계속 진행합니다.');
    else console.log(`🔗 사이트가 자동으로 볼 event_key를 "${EVENT_KEY}"로 갱신했습니다.`);
  } catch (_) {
    console.log('ℹ️ "지금 event_key" 갱신 중 오류 — 계속 진행합니다.');
  }
}

async function postSnapshot(grades, roundLabel, note, totals, meta) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_ticket_snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
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
  let recorded = 0;
  try {
    console.log('▶ 기록 대상 event_key:', EVENT_KEY, '/ 29CM itemId:', ITEM_ID_29CM);

    const productMasterCode = await getJSON(`${API_BASE}/item/code?itemId=${encodeURIComponent(ITEM_ID_29CM)}`);
    if (!productMasterCode) throw new Error('productMasterCode를 찾지 못했습니다 (itemId가 올바른지 확인하세요).');
    console.log('🔎 productMasterCode:', productMasterCode);

    const info = await getJSON(`${API_BASE}/info?productMasterCode=${productMasterCode}`);

    // 경기/공연일이 지났으면 자동으로 기록을 정지한다 (ticket-watch.js와 동일한 안전장치).
    const eventEndDate = (TARGET_DATE && /^\d{4}-\d{2}-\d{2}$/.test(TARGET_DATE))
      ? TARGET_DATE
      : String(info.productRunEndDate || '').replace(/\./g, '-').replace(/\s+/g, '');
    const kstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    if (eventEndDate && kstToday > eventEndDate) {
      console.log(`⏹️ ${EVENT_KEY}: 경기일(${eventEndDate})이 지나 티켓 판매가 종료되었습니다 — 기록을 정지합니다. (오늘: ${kstToday} KST)`);
      process.exit(0);
    }

    // "기간"에 해당하는 짧은 날짜 표기 — 로드FC(NOL) 쪽과 동일하게 "2026.08.29" 형식으로
    // 통일한다(시작일과 종료일이 다르면 "시작 ~ 종료"로). openText(티켓 오픈 안내)는 요청에 따라
    // 더 이상 채우지 않는다 — index.html은 이 값이 없으면 그 줄을 그냥 표시하지 않는다.
    const startShort = formatDateShortKo(info.productRunStartDate);
    const endShort = formatDateShortKo(info.productRunEndDate);
    const dateText = startShort && endShort && startShort !== endShort
      ? `${startShort} ~ ${endShort}`
      : (startShort || endShort || null);
    // 등급별 정가 — NOL(로드FC 등)은 이 값을 자동으로 못 구해서 북마클릿으로 수동 캡처했지만,
    // 29CM은 상품 정보 API(seatGradePriceList)가 이미 등급별 가격을 공개로 내려주므로 자동으로
    // 채운다. index.html의 잔여 좌석 카드는 meta.gradePrices가 있으면 등급명 옆에 가격을,
    // 없으면 그냥 가격 없이 보여준다(북마클릿 캡처가 있는 NOL 회차와 동일한 방식).
    // 등급별 공식 색상(seatGradeColorCode)도 가격과 같은 방식으로 자동으로 채운다 — 29CM 판매
    // 페이지가 실제로 쓰는 등급 색과 사이트 표시를 통일하기 위함(예: 안내 프리뷰/구역도 이미지의
    // 등급 색과 우리 사이트의 등급별 판매 비율 도넛 색을 맞춤).
    const gradePrices = {};
    const gradeColors = {};
    if (Array.isArray(info.seatGradePriceList)) {
      for (const g of info.seatGradePriceList) {
        const gradeName = gradeDisplayName(g.seatGradeName, g.seatGradeCode);
        if (g.seatGradePrice != null) gradePrices[gradeName] = g.seatGradePrice;
        if (g.seatGradeColorCode) gradeColors[gradeName] = g.seatGradeColorCode;
      }
    }
    const meta = {
      title: stripLeadingTag(info.productName) || info.productName || null,
      place: info.placeName || null,
      dateText,
      buyUrl: `https://ticket.29cm.co.kr/catalog/${ITEM_ID_29CM}`,
      platform: '29CM',
      api: { productMasterCode },
      gradePrices: Object.keys(gradePrices).length ? gradePrices : undefined,
      gradeColors: Object.keys(gradeColors).length ? gradeColors : undefined,
    };
    console.log('🔎 자동 추출된 행사 정보:', JSON.stringify(meta));

    if (SET_CURRENT) await setCurrentTicketEvent();
    else console.log('ℹ️ 보조 대회 기록 모드(SET_CURRENT=false) — 사이트 메인 표시는 건드리지 않고 데이터만 쌓습니다.');

    const turns = await getJSON(`${API_BASE}/turn/info?productMasterCode=${productMasterCode}`);
    if (!Array.isArray(turns) || turns.length === 0) {
      console.log('ℹ️ 등록된 회차가 없습니다 (아직 티켓 오픈 전이거나 판매 종료된 상태일 수 있습니다). 기록할 내용이 없어 정상 종료합니다.');
      process.exit(0);
    }
    console.log(`🔎 ${turns.length}개 회차 확인됨`);

    for (const turn of turns) {
      const detail = await getJSON(
        `${API_BASE}/turn/detail/seat/info?productMasterCode=${productMasterCode}&turnSequence=${turn.turnSequence}`
      );
      const row = Array.isArray(detail) ? detail.find((d) => d.turnSequence === turn.turnSequence) || detail[0] : null;
      const quantityList = row && row.quantityList;
      if (!Array.isArray(quantityList) || quantityList.length === 0) {
        console.log(`ℹ️ 회차(turnSequence=${turn.turnSequence})의 잔여석 정보를 찾지 못해 건너뜁니다.`);
        continue;
      }
      const grades = {};
      for (const q of quantityList) {
        const gradeName = gradeDisplayName(q.seatGradeName, q.seatGradeCode);
        // quantityList에는 실제로 판매하지 않는 "유령" 등급이 항상 잔여 0으로 섞여 나올 때가
        // 있습니다 (이 행사의 "시야방해석"이 그 예 — 실제 29CM 판매 페이지에는 뜨지도 않고
        // 가격 정보(seatGradePriceList)도 없는데, API의 quantityList에는 항상 잔여 0으로 잡혀
        // 사이트에 "매진"으로 잘못 표시됐습니다). 가격 정보가 없는 등급은 판매 대상이 아니라고
        // 보고 기록에서 제외합니다 (gradePrices 자체가 비어있으면 — 즉 이 API가 가격을 아예
        // 안 주는 다른 행사면 — 이 필터를 걸지 않고 예전처럼 전부 기록합니다, 안전망).
        if (Object.keys(gradePrices).length && gradePrices[gradeName] == null) {
          console.log(`ℹ️ "${gradeName}" 등급은 가격 정보가 없어(=실제 판매 대상 아님) 기록에서 제외합니다.`);
          continue;
        }
        grades[gradeName] = { remain: q.turnClassificationRemainingProductQuantity };
      }
      const roundLabel = formatRoundLabel(turn.turnDateTime);
      const placeId = turn.placeId || row.placeId;
      const breakdown = await fetchSeatBreakdown(productMasterCode, turn.turnSequence, placeId, quantityList);
      const verifiedOverride = VERIFIED_TOTAL_OVERRIDE[productMasterCode];
      let totals, note;
      let turnMeta = meta;
      if (verifiedOverride) {
        // 이 상품은 좌석배치도 API의 누락 버그가 확인되어, 자동 탐지 대신 수동 검증값을 씁니다
        // (등급별 세부는 여전히 버그 영향을 받을 수 있어 자동 탐지값을 참고용으로만 남겨둡니다).
        totals = breakdown ? breakdown.totals : undefined;
        note = `총원은 수동 검증값 사용(29CM 좌석배치도 API 누락 버그 확인됨, ${verifiedOverride.verifiedNote}) — 잔여석은 실시간 API`;
        turnMeta = { ...meta, overallTotal: verifiedOverride.overallTotal, sellableTotal: verifiedOverride.sellableTotal, noGradeTotal: verifiedOverride.noGradeTotal };
        console.log(
          `✅ [${roundLabel}] 수동 검증된 총원 오버라이드 적용: 총 ${verifiedOverride.overallTotal}석 (${verifiedOverride.verifiedNote})`
        );
      } else if (breakdown) {
        totals = breakdown.totals;
        note = '29CM 공개 API에서 직접 추출 (좌석배치도로 등급별 총원 확인)';
        turnMeta = { ...meta, overallTotal: breakdown.overallTotal, sellableTotal: breakdown.sellableTotal, noGradeTotal: breakdown.noGradeTotal };
        console.log(
          `🎯 [${roundLabel}] 좌석배치도에서 등급별 총원을 정확히 확인했습니다:`, JSON.stringify(totals),
          `(전체 ${breakdown.overallTotal}석 중 판매대상 ${breakdown.sellableTotal}석, 미배정 ${breakdown.noGradeTotal}석)`
        );
      } else {
        // 안전망: 좌석배치도 조회가 실패했을 때만, 이번이 첫 기록이면 잔여석을 총원으로 추측한다.
        // 이 경우 overallTotal/sellableTotal/noGradeTotal은 알 수 없으므로 지어내지 않고 생략한다.
        totals = await estimateTotalsIfFirstSnapshot(grades, roundLabel);
        note = '29CM 공개 API에서 직접 추출';
        if (totals) console.log(`🆕 [${roundLabel}] 첫 기록으로 보여, 지금 잔여석을 총원으로 기록합니다(추정치):`, JSON.stringify(totals));
      }
      await postSnapshot(grades, roundLabel, note, totals, turnMeta);
      console.log(`✅ [${roundLabel}] 기록 완료:`, JSON.stringify(grades));
      recorded++;
    }

    if (recorded === 0) throw new Error('파싱된 회차가 없어 기록하지 못했습니다.');
    console.log(`✅ 총 ${recorded}개 회차 기록 완료`);
  } catch (err) {
    console.error('❌ ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
  }
})();
