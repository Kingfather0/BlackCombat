// 로그인된 29CM 페이지 안에서 실행되는 구역 수집 함수 (ticket-zone-bc17-local.js / -cloud.js 공용)
// page.evaluate(collectInPage, {...}) 로 호출하므로 바깥 변수를 쓰지 않는 독립 함수여야 한다.
async function collectInPage({ SB, SB_KEY, PASS, needLayout, fast }) {
  const PMC = 1322, TURN = 12626, ROOT = 529;
  const j = async (u, opt) => { const r = await fetch(u, opt); if (r.status === 401) throw new Error('401'); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
  function buildRows(c) {
    const seats = (c.blocks || []).flatMap(b => b.seats || []).filter(s => s.sts === 1);
    if (!seats.length) return [];
    const minX = Math.min(...seats.map(s => s.x)), byRow = {};
    seats.forEach(s => { (byRow[s.row] = byRow[s.row] || []).push(s); });
    const rl = Object.keys(byRow).map(k => { const a = byRow[k]; const y = a.reduce((m, s) => m + s.y, 0) / a.length; a.sort((p, q) => p.x - q.x || String(p.col).localeCompare(String(q.col))); return { k, y, a }; }).sort((p, q) => p.y - q.y);
    const minY = rl[0].y;
    return rl.map(r => r.k + ';' + Math.round((r.y - minY) / 22) + ';' + r.a.map(s => s.col + '@' + Math.round((s.x - minX) / 11)).join(','));
  }
  const parseCols = rows => rows.map(l => { const i1 = l.indexOf(';'), i2 = l.indexOf(';', i1 + 1); return { k: l.slice(0, i1), cols: l.slice(i2 + 1).split(',').map(t => t.slice(0, t.lastIndexOf('@'))) }; });
  const colKeys = col => { const ks = [String(col)]; String(col).replace(/\(.*?\)/g, '').split('-').forEach(p => { if (/^\d+$/.test(p) && !ks.includes(p)) ks.push(p); }); return ks; };
  function mapState(rows, units, missing) {
    const api = new Map();
    units.forEach(u => { const st = u.seatSaleStatusCode === '1' ? '1' : (u.seatPreemptStatusCode === '1' || u.seatHoldStatusCode === '1') ? 'h' : '0'; api.set(u.seatrow + '|' + parseInt(u.num, 10), st); api.set(u.seatrow + '|' + u.num, st); });
    let out = '';
    parseCols(rows).forEach(r => r.cols.forEach(col => {
      let st = null;
      for (const k of colKeys(col)) { const v = api.get(r.k + '|' + k); if (v != null) { if (st == null || v === '1') st = v; if (st === '1') break; } }
      out += st == null ? missing : st;
    }));
    return out;
  }
  async function save(key, value) {
    const r = await fetch(SB + '/rest/v1/rpc/admin_save_data', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }, body: JSON.stringify({ p_pass: PASS, p_key: key, p_value: value }) });
    if (!r.ok) throw new Error('저장 실패 ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120));
  }
  async function pool(items, n, fn) { let c = 0; await Promise.all(Array.from({ length: n }, async () => { while (c < items.length) await fn(items[c++]); })); }

  const zr = await j(`/api/order/unit/zones/remains?productMasterCode=${PMC}&zonePlaceId=${ROOT}&turnSequence=${TURN}`, { credentials: 'include' });
  const list = zr.data.zoneRemains;
  const layoutZones = [];
  if (needLayout) {
    await pool(list, 5, async z => {
      const c = await j('/api/order/unit/charts?placeId=' + z.placeId, { credentials: 'include' });
      const ch = await j(c.data.seatChartJsonUrl, { credentials: 'omit' });
      layoutZones.push({ id: z.placeId, n: z.name, g: [...new Set((z.grades || []).map(g => g.seatGradeCode))], rows: buildRows(ch) });
    });
    layoutZones.sort((a, b) => a.id - b.id);
    await save('tk_layout_bc17', { v: 1, at: new Date().toISOString(), zones: layoutZones });
  }
  let zones = needLayout ? layoutZones : window.__z17Layout;
  if (!zones) { // 페이지를 새로고침하면 기억해 둔 배치가 사라지므로 Supabase에 저장된 배치를 다시 읽는다
    const lr = await fetch(SB + '/rest/v1/site_data?key=eq.tk_layout_bc17&select=value', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
    const rows = lr.ok ? await lr.json() : [];
    zones = rows[0] && rows[0].value && rows[0].value.zones;
    if (!zones || !zones.length) throw new Error('배치 데이터가 없습니다');
  }
  window.__z17Layout = zones;
  // fast=true: 잔여/선택 중 좌석이 있는 구역만 다시 읽고(나머지는 직전 값 유지) 빠르게 갱신한다. 전체 읽기는 주기적으로 별도 실행.
  let state = {}, targets = zones;
  if (fast) {
    let prev = window.__z17State;
    if (!prev) { const sr = await fetch(SB + '/rest/v1/site_data?key=eq.tk_state_bc17&select=value', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } }); const rr = sr.ok ? await sr.json() : []; prev = rr[0] && rr[0].value && rr[0].value.z; }
    if (prev && Object.keys(prev).length >= zones.length) { state = Object.assign({}, prev); targets = zones.filter(z => /[0h]/.test(prev[z.id] || '0')); }
  }
  let free = 0, fail = 0;
  await pool(targets, 5, async z => {
    try {
      const a = await j(`/api/preempt/seat/info?productMasterCode=${PMC}&turnSequence=${TURN}&placeId=${z.id}`, { credentials: 'include' });
      const u = (a.data && a.data.seatAssignUnits) || [];
      state[z.id] = mapState(z.rows, u, u.length ? '1' : '-');
    } catch (e) { if (String(e.message) === '401') throw e; fail++; }
  });
  zones.forEach(z => { free += ((state[z.id] || '').match(/0/g) || []).length; });
  window.__z17State = state;
  await save('tk_state_bc17', { at: new Date().toISOString(), z: state });
  return { zones: zones.length, free, fail, polled: targets.length };
}

module.exports = { collectInPage };
