// 티켓 "구역별 실시간 좌석" 백업 스크립트 (GitHub Actions에서 주기적으로 실행)
//
// preview.html의 "구역별 실시간 좌석" 지도는 방문자 브라우저가 29CM 티켓 서버
// (ticket.29cm.co.kr)에 구역마다 직접 실시간으로 물어보는 방식이라, 서버 어디에도
// 백업이 남지 않는다. 그래서 행사가 끝나고 29CM이 그 회차의 조회를 막아버리면
// (실제로 2026.08.29 블랙컴뱃 경기에서 발생) 지도가 통째로 "불러오기 실패"로 바뀌고,
// 그 이전의 정상 상태는 영영 복구할 수 없었다.
//
// 이 스크립트는 그 문제를 막기 위해, 같은 29CM API를 서버(봇)에서 주기적으로 직접
// 조회해서 site_data 키 'tk_zone_snapshot'에 저장해둔다. preview.html은 실시간 조회가
// 실패하면 이 백업을 대신 보여준다("OO시 기준" 라벨과 함께) — 즉 29CM이 이 회차의
// 조회를 막기 "직전"까지 이 봇이 남긴 마지막 성공 데이터가 그대로 화면에 남는다.
//
// update-records.js와 같은 원칙: 이번 실행에서 실패한 구역은 지우지 않고 이전
// 성공 데이터를 그대로 유지한다(부분 갱신) — 한두 구역만 일시적으로 실패해도
// 전체 백업이 날아가지 않는다.
//
// 필요한 환경변수:
//   SUPABASE_URL         기존 사이트와 동일한 값
//   SUPABASE_ANON_KEY     기존 사이트와 동일한 값
//   ADMIN_PASS            관리자 페이지 로그인 비밀번호(admin_save_data 호출용)
//
// 이 봇은 실패해도 사이트를 멈추지 않는다 — 이번 실행만 건너뛰고 다음 스케줄에 다시 시도한다.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ADMIN_PASS = process.env.ADMIN_PASS;

function bail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) bail('SUPABASE_URL / SUPABASE_ANON_KEY 환경변수가 없습니다.');
if (!ADMIN_PASS) bail('ADMIN_PASS 환경변수가 없습니다. (관리자 페이지 비밀번호를 GitHub Actions Secret으로 등록하세요)');

// 이 행사가 끝난 지 너무 오래 지났으면(=29CM이 이미 오래전에 막았을 가능성이 매우 높고,
// 더 돌려봐야 의미 없는 실패만 쌓임) 조용히 스킵한다. preview.html에 새 행사가 이 지도를
// 쓰도록 연결될 때 이 값과 아래 ZONES/좌표를 그 행사 기준으로 새로 맞춰야 한다.
const EVENT_DATE = '2026-08-29';
const EVENT_ENDED_SKIP_AFTER_DAYS = 60;
const daysSinceEvent = (Date.now() - new Date(EVENT_DATE + 'T00:00:00+09:00').getTime()) / 86400000;
if (daysSinceEvent > EVENT_ENDED_SKIP_AFTER_DAYS) {
  console.log(`⏹️ 행사일(${EVENT_DATE})로부터 ${EVENT_ENDED_SKIP_AFTER_DAYS}일이 지나 백업 조회를 정지합니다. (지금까지 모은 백업은 그대로 site_data에 남아 preview.html이 계속 사용합니다)`);
  process.exit(0);
}

// preview.html의 TK_LIVE_ZONES와 정확히 동일한 목록(이름·placeId) — 자세한 값의 출처는
// 그쪽 주석 참고. 여기서는 등급/좌석수 없이 조회에 필요한 placeId만 있으면 된다.
const ZONES = [
  { name: 'D1', placeId: 208 }, { name: 'C8', placeId: 209 }, { name: 'D2', placeId: 210 },
  { name: 'D3', placeId: 211 }, { name: 'D4', placeId: 212 }, { name: 'D5', placeId: 213 },
  { name: 'D6', placeId: 214 }, { name: 'D7', placeId: 215 }, { name: 'D8', placeId: 216 },
  { name: 'A1', placeId: 217 }, { name: 'A2', placeId: 218 }, { name: 'A3', placeId: 219 },
  { name: 'A4', placeId: 220 }, { name: 'A5', placeId: 221 }, { name: 'A6', placeId: 222 },
  { name: 'A7', placeId: 223 }, { name: 'A8', placeId: 224 }, { name: 'B1', placeId: 225 },
  { name: 'B2', placeId: 226 }, { name: 'B3', placeId: 227 }, { name: 'B4', placeId: 228 },
  { name: 'B5', placeId: 229 }, { name: 'B6', placeId: 230 }, { name: 'B7', placeId: 231 },
  { name: 'B8', placeId: 232 }, { name: 'C1', placeId: 233 }, { name: 'C2', placeId: 234 },
  { name: 'C3', placeId: 235 }, { name: 'C4', placeId: 236 }, { name: 'C5', placeId: 237 },
  { name: 'C6', placeId: 238 }, { name: 'C7', placeId: 239 },
  { name: '선수입장로 W', placeId: 240 }, { name: '골드', placeId: 241 },
  { name: '블랙티넘', placeId: 242 }, { name: '선수입장로 B', placeId: 243 },
  { name: '플로어석 B', placeId: 244 }, { name: '플로어석 W', placeId: 245 },
];
const API_URL = 'https://ticket.29cm.co.kr/api/preempt/seat/info';
const PRODUCT_MASTER_CODE = 1246;
const TURN_SEQUENCE = 11667;

async function fetchZone(zone) {
  const url = `${API_URL}?productMasterCode=${PRODUCT_MASTER_CODE}&turnSequence=${TURN_SEQUENCE}&placeId=${zone.placeId}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (ticket-zone-snapshot-bot)' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const units = json.data && json.data.seatAssignUnits;
  if (!Array.isArray(units)) throw new Error('no seatAssignUnits');
  const seats = units.map(u => ({ row: parseInt(u.seatrow, 10) || 0, num: parseInt(u.num, 10) || 0, block: u.blockId, sold: u.seatSaleStatusCode === '1' }));
  const remain = seats.filter(s => !s.sold).length;
  return { apiTotal: seats.length, remain, sold: seats.length - remain, seats };
}

async function loadPrevSnapshot() {
  try {
    const params = new URLSearchParams({ key: 'eq.tk_zone_snapshot', select: 'value' });
    const res = await fetch(`${SUPABASE_URL}/rest/v1/site_data?${params.toString()}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!res.ok) return { zones: {} };
    const rows = await res.json().catch(() => null);
    const value = Array.isArray(rows) && rows[0] && rows[0].value;
    return (value && value.zones) ? value : { zones: {} };
  } catch (e) {
    return { zones: {} };
  }
}

async function saveSnapshot(value) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_save_data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ p_pass: ADMIN_PASS, p_key: 'tk_zone_snapshot', p_value: value }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Supabase 저장 실패 (${res.status}): ${bodyText}`);
  }
}

(async () => {
  const prev = await loadPrevSnapshot();
  const zones = Object.assign({}, prev.zones || {});
  const nowIso = new Date().toISOString();
  let ok = 0, fail = 0;
  for (const z of ZONES) {
    try {
      const r = await fetchZone(z);
      zones[z.placeId] = Object.assign({ name: z.name, capturedAt: nowIso }, r);
      ok++;
    } catch (e) {
      fail++;
      console.error(`  실패: ${z.name} (placeId ${z.placeId}) - ${e.message}`);
      // 실패한 구역은 zones[z.placeId]를 그대로 두어(이전 성공 데이터 보존) 건드리지 않는다.
    }
  }
  console.log(`구역 조회 완료: 성공 ${ok}개 · 실패 ${fail}개 (총 ${ZONES.length}개)`);

  if (ok === 0 && !Object.keys(prev.zones || {}).length) {
    // 첫 실행부터 전부 실패했고 백업할 기존 데이터도 없으면 — 저장할 의미가 없다.
    // (29CM이 이미 완전히 막혀 있을 가능성. 조용히 종료하되 실패로 표시는 해둔다)
    bail('모든 구역 조회에 실패했고 기존 백업도 없습니다 — 이번 실행은 저장하지 않고 종료합니다.');
  }

  try {
    await saveSnapshot({ at: nowIso, zones });
    console.log('✅ tk_zone_snapshot 저장 완료');
  } catch (e) {
    bail(e.message);
  }
})();
