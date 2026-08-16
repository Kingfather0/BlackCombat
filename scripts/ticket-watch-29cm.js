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

function bail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

if (!ITEM_ID_29CM) bail('ITEM_ID_29CM 환경변수가 없습니다. (예: https://ticket.29cm.co.kr/catalog/3998565 → 3998565)');
if (!EVENT_KEY) bail('EVENT_KEY 환경변수가 없습니다.');
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) bail('SUPABASE_URL / SUPABASE_ANON_KEY 환경변수가 없습니다.');
if (!TICKET_BOT_SECRET) bail('TICKET_BOT_SECRET 환경변수가 없습니다.');

// "2026-05-27 20:00:00" 같은 값을 "5월 27일 오후 8시 00분" 형식의 자연스러운 한글로 바꾼다.
// (Node 실행 환경에 따라 toLocaleString('ko-KR')이 오전/오후 대신 AM/PM을 돌려주는 경우가 있어
//  직접 포맷한다 — 사이트의 다른 openText 표기들과 톤을 맞추기 위함)
function formatOpenTextKo(dateTimeStr) {
  const m = String(dateTimeStr || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, , mo, d, hh, mi] = m;
  const h = parseInt(hh, 10);
  const ampm = h < 12 ? '오전' : '오후';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${parseInt(mo, 10)}월 ${parseInt(d, 10)}일 ${ampm} ${h12}시${mi === '00' ? '' : ' ' + parseInt(mi, 10) + '분'} 티켓오픈`;
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

// 등급별 "총 좌석수"를 좌석배치도(seatAssignUnits)를 세어서 정확하게 구한다. quantityList에
// 나온 등급(seatGradeCode)만 대상으로 하고, 공개 판매 대상이 아닌 등급(예: 스탭/기타석)은
// 자연스럽게 제외된다. 실패하면(엔드포인트가 막히는 등) null을 반환하고, 그 경우 호출부가
// estimateTotalsIfFirstSnapshot()으로 대체한다(안전망 — 회귀 없음).
async function fetchExactGradeTotals(productMasterCode, turnSequence, placeId, quantityList) {
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
    for (const q of quantityList) {
      const gradeName = String(q.seatGradeName || '').replace(/\s*티켓$/, '').trim() || q.seatGradeCode;
      const count = countByCode[q.seatGradeCode];
      if (count != null) totals[gradeName] = count;
    }
    return Object.keys(totals).length ? totals : null;
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

    const meta = {
      title: info.productName || null,
      place: info.placeName || null,
      dateText: (info.turnDateTimeKrViewList && info.turnDateTimeKrViewList[0]) || null,
      openText: formatOpenTextKo(info.productOnlineSaleStartDateTime),
      buyUrl: `https://ticket.29cm.co.kr/catalog/${ITEM_ID_29CM}`,
      platform: '29CM',
      api: { productMasterCode },
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
        const gradeName = String(q.seatGradeName || '').replace(/\s*티켓$/, '').trim() || q.seatGradeCode;
        grades[gradeName] = { remain: q.turnClassificationRemainingProductQuantity };
      }
      const roundLabel = formatRoundLabel(turn.turnDateTime);
      const placeId = turn.placeId || row.placeId;
      let totals = await fetchExactGradeTotals(productMasterCode, turn.turnSequence, placeId, quantityList);
      let note = '29CM 공개 API에서 직접 추출 (좌석배치도로 등급별 총원 확인)';
      if (totals) {
        console.log(`🎯 [${roundLabel}] 좌석배치도에서 등급별 총원을 정확히 확인했습니다:`, JSON.stringify(totals));
      } else {
        // 안전망: 좌석배치도 조회가 실패했을 때만, 이번이 첫 기록이면 잔여석을 총원으로 추측한다.
        totals = await estimateTotalsIfFirstSnapshot(grades, roundLabel);
        note = '29CM 공개 API에서 직접 추출';
        if (totals) console.log(`🆕 [${roundLabel}] 첫 기록으로 보여, 지금 잔여석을 총원으로 기록합니다(추정치):`, JSON.stringify(totals));
      }
      await postSnapshot(grades, roundLabel, note, totals, meta);
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
