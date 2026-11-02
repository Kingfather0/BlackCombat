// 블랙컴뱃 17 : VANTABLACK — "구역별 실시간 좌석" 수집 봇 (GitHub Actions에서 10분마다)
//
// 사이트(브라우저)에서 29CM API를 직접 부르면 막히기 때문에(CORS), 이 봇이 서버에서 대신 읽어
// Supabase site_data 에 저장하고 사이트는 그 저장본으로 지도·좌석찾기를 그린다.
//
//  - tk_layout_bc17 : 구역별 좌석 배치(행/열/위치) — 정적 도면이라 한 번만 만들어 저장한다
//                     (LAYOUT_REFRESH=1 로 실행하면 다시 만든다)
//  - tk_state_bc17  : 구역별 좌석 상태 문자열 — 배치 순서(행 위→아래, 행 안에서 왼→오)대로
//                     '1'=판매 '0'=판매중 'h'=다른 사람이 선택 중 '-'=판매 대상 아님/미확인
//
// 필요한 환경변수: SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_PASS(관리자 비밀번호 — Secret)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ADMIN_PASS = process.env.ADMIN_PASS;
const PRODUCT_MASTER_CODE = 1322;
const TURN_SEQUENCE = 12626;
const ROOT_PLACE_ID = 529;
const EVENT_DATE = '2026-11-21';
const SKIP_AFTER_DAYS = 14;
const BASE = 'https://ticket.29cm.co.kr';
const UA = { 'User-Agent': 'Mozilla/5.0 (ticket-zone-bc17-bot)' };

function bail(m) { console.error('❌ ' + m); process.exit(1); }

// ── 순수 함수(브라우저에서도 그대로 붙여 검증할 수 있게 fetch/환경 의존 없음) ─────────────
// 차트 JSON → 구역 배치. rows: 'A;0;20@0,19@2,...' (행이름;세로순번;열@가로위치)
function buildRows(chartJson) {
  const seats = (chartJson.blocks || []).flatMap(b => b.seats || []).filter(s => s.sts === 1);
  if (!seats.length) return [];
  const minX = Math.min(...seats.map(s => s.x));
  const byRow = {};
  seats.forEach(s => { (byRow[s.row] = byRow[s.row] || []).push(s); });
  const rl = Object.keys(byRow).map(k => {
    const a = byRow[k];
    const y = a.reduce((m, s) => m + s.y, 0) / a.length;
    a.sort((p, q) => p.x - q.x || String(p.col).localeCompare(String(q.col)));
    return { k, y, a };
  }).sort((p, q) => p.y - q.y);
  const minY = rl[0].y;
  return rl.map(r => r.k + ';' + Math.round((r.y - minY) / 22) + ';' + r.a.map(s => s.col + '@' + Math.round((s.x - minX) / 11)).join(','));
}
function parseRows(rows) {
  return rows.map(line => {
    const i1 = line.indexOf(';'), i2 = line.indexOf(';', i1 + 1);
    return { k: line.slice(0, i1), y: +line.slice(i1 + 1, i2), s: line.slice(i2 + 1).split(',').map(t => { const at = t.lastIndexOf('@'); return [t.slice(0, at), +t.slice(at + 1)]; }) };
  });
}
// 좌석(열 문자열) → API 번호 후보. '13-14' → ['13-14','13','14'], '13-14(2)' → ['13-14(2)','13','14']
function colKeys(col) {
  const keys = [String(col)];
  String(col).replace(/\(.*?\)/g, '').split('-').forEach(p => { if (/^\d+$/.test(p) && !keys.includes(p)) keys.push(p); });
  return keys;
}
// 배치 + API 응답 → 상태 문자열
// missingChar: API가 주지 않은 좌석을 어떻게 볼지 — 판매 구역(API 응답이 있는 구역)에서 빠진 좌석은
// 사전 판매·판매 완료로 집계하므로 '1', 응답이 아예 없는 구역(다이아·스카이박스 등)은 '-'
function mapState(rows, units, missingChar) {
  const api = new Map();
  (units || []).forEach(u => {
    const st = u.seatSaleStatusCode === '1' ? '1' : (u.seatPreemptStatusCode === '1' || u.seatHoldStatusCode === '1') ? 'h' : '0';
    api.set(String(u.seatrow) + '|' + String(parseInt(u.num, 10)), st);
    api.set(String(u.seatrow) + '|' + String(u.num), st);
  });
  let out = '', miss = 0;
  parseRows(rows).forEach(r => r.s.forEach(([col]) => {
    let st = null;
    for (const k of colKeys(col)) { const v = api.get(r.k + '|' + k); if (v != null) { if (st == null || v === '1') st = v; if (st === '1') break; } }
    if (st == null) { st = missingChar || '-'; miss++; }
    out += st;
  }));
  return { str: out, miss };
}
if (typeof module !== 'undefined') module.exports = { buildRows, parseRows, colKeys, mapState };

// ── 실행부 ──────────────────────────────────────────────────────────────────
async function getJson(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
  }
  throw last;
}
async function pool(items, n, fn) {
  let cur = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (cur < items.length) { const it = items[cur++]; await fn(it); } }));
}
async function sbGet(key) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/site_data?${new URLSearchParams({ key: 'eq.' + key, select: 'value' })}`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
    if (!res.ok) return null;
    const rows = await res.json();
    return (Array.isArray(rows) && rows[0] && rows[0].value) || null;
  } catch (e) { return null; }
}
async function sbSave(key, value) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_save_data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ p_pass: ADMIN_PASS, p_key: key, p_value: value }),
  });
  if (!res.ok) throw new Error(`Supabase 저장 실패(${key}) ${res.status}: ${await res.text().catch(() => '')}`);
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) bail('SUPABASE_URL / SUPABASE_ANON_KEY 환경변수가 없습니다.');
  if (!ADMIN_PASS) bail('ADMIN_PASS 환경변수(GitHub Secret)가 없습니다.');
  const days = (Date.now() - new Date(EVENT_DATE + 'T00:00:00+09:00').getTime()) / 86400000;
  if (days > SKIP_AFTER_DAYS) { console.log('⏹️ 행사 종료 후 기간이 지나 조회를 멈춥니다.'); return; }

  const zr = await getJson(`${BASE}/api/order/unit/zones/remains?productMasterCode=${PRODUCT_MASTER_CODE}&zonePlaceId=${ROOT_PLACE_ID}&turnSequence=${TURN_SEQUENCE}`);
  const zoneList = (zr.data && zr.data.zoneRemains) || [];
  if (!zoneList.length) bail('구역 목록을 받지 못했습니다.');
  console.log(`구역 ${zoneList.length}개`);

  // 1) 배치(한 번만)
  let layout = process.env.LAYOUT_REFRESH === '1' ? null : await sbGet('tk_layout_bc17');
  if (!layout || !Array.isArray(layout.zones) || layout.zones.length < zoneList.length) {
    console.log('배치 데이터를 새로 만듭니다…');
    const zones = [];
    await pool(zoneList, 5, async z => {
      try {
        const c = await getJson(`${BASE}/api/order/unit/charts?placeId=${z.placeId}`);
        const j = await getJson(c.data.seatChartJsonUrl);
        const gset = [...new Set((z.grades || []).map(g => g.seatGradeCode))];
        zones.push({ id: z.placeId, n: z.name, g: gset, rows: buildRows(j) });
      } catch (e) { console.error(`  배치 실패 ${z.name}: ${e.message}`); }
    });
    if (zones.length < zoneList.length) bail(`배치 ${zoneList.length - zones.length}개 구역 실패 — 저장하지 않고 종료`);
    zones.sort((a, b) => a.id - b.id);
    layout = { v: 1, at: new Date().toISOString(), zones };
    await sbSave('tk_layout_bc17', layout);
    console.log(`✅ tk_layout_bc17 저장 (좌석 ${zones.reduce((s, z) => s + parseRows(z.rows).reduce((t, r) => t + r.s.length, 0), 0)}석)`);
  }

  // 2) 상태
  const prev = await sbGet('tk_state_bc17');
  const state = Object.assign({}, (prev && prev.z) || {});
  let ok = 0, fail = 0, missTotal = 0;
  await pool(layout.zones, 5, async z => {
    try {
      const j = await getJson(`${BASE}/api/preempt/seat/info?productMasterCode=${PRODUCT_MASTER_CODE}&turnSequence=${TURN_SEQUENCE}&placeId=${z.id}`);
      const units = j.data && j.data.seatAssignUnits;
      if (!Array.isArray(units)) throw new Error('no seatAssignUnits');
      const r = mapState(z.rows, units, units.length ? '1' : '-');
      state[z.id] = r.str; missTotal += units.length ? r.miss : 0; ok++;
    } catch (e) { fail++; console.error(`  상태 실패 ${z.n}: ${e.message}`); }
  });
  console.log(`상태 조회: 성공 ${ok} · 실패 ${fail} · API에 없는 좌석 ${missTotal}석`);
  if (!ok) bail('모든 구역 조회 실패 — 저장하지 않음');
  await sbSave('tk_state_bc17', { at: new Date().toISOString(), z: state });
  console.log('✅ tk_state_bc17 저장');
}
if (require.main === module) main().catch(e => bail(e.message));
