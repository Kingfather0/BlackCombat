// "3,877석"이라는 총 좌석수가 API를 제대로 읽어서 나온 값이 맞는지 검증하기 위한 1회성
// 진단 스크립트입니다. (운영 스크립트인 ticket-watch-29cm.js와는 별개, 읽기 전용 —
// Supabase에는 아무것도 기록하지 않음)
//
// 확인하는 것 세 가지:
//   1. turn/detail/seat/info가 주는 quantityList 원본에 우리가 지금 안 쓰고 있는 "총원" 필드가
//      혹시 이미 들어있는지 (지금 코드는 seatGradeName/seatGradeCode/잔여수량 세 개만 읽고
//      나머지 필드는 전부 무시하고 있어서, 혹시 total 같은 필드가 있었는데 놓친 건 아닌지 확인)
//   2. turn/info가 회차를 정말 1개만 주는 게 맞는지 (혹시 다른 회차/placeId가 더 있는데
//      운영 스크립트가 놓치고 있는 건 아닌지)
//   3. preempt/seat/info(좌석 하나하나 세는 API)가 페이지네이션 없이 한 번에 전체를 다
//      주는 게 맞는지 (응답에 페이지/다음 페이지 관련 필드가 있는지, seatAssignUnits 외
//      다른 필드에 전체 좌석수를 알려주는 값이 있는지)
//
// 필요한 환경변수:
//   ITEM_ID_29CM   29CM 티켓 상품 번호 (예: https://ticket.29cm.co.kr/catalog/4149667 → 4149667)

const ITEM_ID_29CM = process.env.ITEM_ID_29CM;
const API_BASE = 'https://ticket.29cm.co.kr/api/public/product/ticket';
const ORDER_API_BASE = 'https://ticket.29cm.co.kr/api';

function bail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

if (!ITEM_ID_29CM) bail('ITEM_ID_29CM 환경변수가 없습니다.');

async function getJSON(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`요청 실패 (${res.status}): ${url}`);
  const json = await res.json();
  if (json.resultCode !== '200') throw new Error(`API 응답 오류: ${json.resultMessage || JSON.stringify(json)}`);
  return json.data;
}

(async () => {
  try {
    console.log('▶ 진단 대상 itemId:', ITEM_ID_29CM);

    const productMasterCode = await getJSON(`${API_BASE}/item/code?itemId=${encodeURIComponent(ITEM_ID_29CM)}`);
    console.log('🔎 productMasterCode:', productMasterCode);

    // ── ① 상품 정보 원본 — 혹시 명시적인 "총 좌석수/수용인원" 필드가 있는지 ──
    const info = await getJSON(`${API_BASE}/info?productMasterCode=${productMasterCode}`);
    console.log('\n===== ① 상품 정보(info) 원본 전체 =====');
    console.log(JSON.stringify(info, null, 2));

    // ── ② 회차 목록 원본 — 정말 1개뿐인지, placeId가 회차마다 다른지 ──
    const turns = await getJSON(`${API_BASE}/turn/info?productMasterCode=${productMasterCode}`);
    console.log(`\n===== ② 회차 목록(turn/info) — 총 ${Array.isArray(turns) ? turns.length : 0}개 =====`);
    console.log(JSON.stringify(turns, null, 2));

    if (!Array.isArray(turns) || turns.length === 0) bail('회차가 없습니다.');

    for (const turn of turns) {
      console.log(`\n\n########## 회차 turnSequence=${turn.turnSequence} ##########`);

      // ── ③ quantityList 원본 — 우리가 안 쓰는 필드 중에 "총원"이 있는지 ──
      const detail = await getJSON(
        `${API_BASE}/turn/detail/seat/info?productMasterCode=${productMasterCode}&turnSequence=${turn.turnSequence}`
      );
      const row = Array.isArray(detail) ? detail.find((d) => d.turnSequence === turn.turnSequence) || detail[0] : null;
      console.log('\n===== ③ turn/detail/seat/info 원본 (quantityList 포함 전체) =====');
      console.log(JSON.stringify(row, null, 2));

      const quantityList = row && row.quantityList;
      const placeId = turn.placeId || (row && row.placeId);
      if (!placeId) { console.log('ℹ️ placeId가 없어 ④ 좌석배치도 조회는 건너뜁니다.'); continue; }

      // ── ④ 좌석배치도(preempt/seat/info) — 페이지네이션 흔적이 있는지, 전체 개수가 맞는지 ──
      const data = await getJSON(
        `${ORDER_API_BASE}/preempt/seat/info?productMasterCode=${productMasterCode}&turnSequence=${turn.turnSequence}&placeId=${placeId}`
      );
      const units = data && data.seatAssignUnits;
      const { seatAssignUnits, ...rest } = data || {};
      console.log(`\n===== ④ preempt/seat/info — seatAssignUnits 개수: ${Array.isArray(units) ? units.length : 'N/A'} =====`);
      console.log('----- seatAssignUnits를 뺀 나머지 응답 필드 (페이지네이션/총개수 힌트 확인용) -----');
      console.log(JSON.stringify(rest, null, 2));

      if (Array.isArray(units) && units.length) {
        // 등급코드별 카운트 재계산 + quantityList와 대조
        const countByCode = {};
        for (const u of units) {
          const code = u.seatGradeCode;
          if (code == null) continue;
          countByCode[code] = (countByCode[code] || 0) + 1;
        }
        console.log('\n----- 좌석배치도에서 직접 센 등급코드별 개수 -----');
        console.log(JSON.stringify(countByCode, null, 2));
        console.log('전체 합계:', Object.values(countByCode).reduce((a, b) => a + b, 0), '/ units.length:', units.length);

        console.log('\n----- 앞 2개 / 뒤 2개 좌석 원본 (필드 구조 확인용) -----');
        units.slice(0, 2).forEach((u, i) => console.log(`[앞 ${i}]`, JSON.stringify(u)));
        units.slice(-2).forEach((u, i) => console.log(`[뒤 ${i}]`, JSON.stringify(u)));
      }
    }

    console.log('\n✅ 진단 완료.');
  } catch (e) {
    console.error('❌ 진단 중 오류:', e.message || e);
    process.exit(1);
  }
})();
