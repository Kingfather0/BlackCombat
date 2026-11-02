// 블랙컴뱃 17 구역별 좌석 — GitHub Actions에서 사람 없이 도는 수집기
//
// 로그인된 29CM 세션(Secret Z17_SESSION: ticket-zone-bc17-login.js로 만든 파일 내용)으로 헤드리스 크롬을 띄워
// 1분마다 구역 좌석을 읽어 Supabase(tk_layout_bc17 / tk_state_bc17)에 저장한다.
// 로그인 토큰은 사용할 때마다 갱신될 수 있어서, 갱신된 세션은 암호화(AES-256-GCM, 키=Secret Z17_ENC_KEY)해
// site_data 'z17_session_enc'에 보관하고 다음 실행 때 그걸 우선 사용한다. (site_data는 누구나 읽을 수 있어
// 암호화 없이는 절대 저장하지 않는다.) 세션이 끝내 만료되면 로그에 안내하고 종료 → login 스크립트로 다시 만들어 Secret 교체.
//
// 환경변수: SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_PASS, Z17_SESSION, Z17_ENC_KEY, (선택) Z17_EVERY_SEC, Z17_RUN_MIN

const { chromium } = require('playwright');
const crypto = require('crypto');
const zlib = require('zlib');
const { collectInPage } = require('./z17-page-collect');

const SB = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_ANON_KEY, PASS = process.env.ADMIN_PASS;
const ENC = process.env.Z17_ENC_KEY, INIT = process.env.Z17_SESSION;
const EVERY_MS = (parseInt(process.env.Z17_EVERY_SEC, 10) || 15) * 1000; // 빠른 갱신 주기(잔여가 있는 구역만)
const FULL_EVERY = parseInt(process.env.Z17_FULL_EVERY, 10) || 4; // N번에 한 번은 전 구역 읽기(약 1분)
const RUN_MS = (parseInt(process.env.Z17_RUN_MIN, 10) || 340) * 60000;
const PAGE_URL = 'https://ticket.29cm.co.kr/catalog/4347803';
const EVENT_END = new Date('2026-11-22T00:00:00+09:00').getTime();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bail = m => { console.error('❌ ' + m); process.exit(1); };

if (!SB || !SB_KEY || !PASS) bail('SUPABASE_URL / SUPABASE_ANON_KEY / ADMIN_PASS 환경변수가 없습니다.');
if (!ENC) bail('Z17_ENC_KEY(Secret)가 없습니다.');
if (Date.now() > EVENT_END) { console.log('행사 기간이 끝나 종료합니다.'); process.exit(0); }

const key = crypto.scryptSync(ENC, 'z17-session-salt', 32);
function encrypt(text) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const d = Buffer.concat([c.update(text, 'utf8'), c.final()]); return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: d.toString('base64') }; }
function decrypt(o) { const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'base64')); d.setAuthTag(Buffer.from(o.tag, 'base64')); return Buffer.concat([d.update(Buffer.from(o.data, 'base64')), d.final()]).toString('utf8'); }

async function sbGet(k) {
  try {
    const r = await fetch(`${SB}/rest/v1/site_data?${new URLSearchParams({ key: 'eq.' + k, select: 'value' })}`, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
    if (!r.ok) return null; const rows = await r.json(); return (rows[0] && rows[0].value) || null;
  } catch (e) { return null; }
}
async function sbSave(k, v) {
  const r = await fetch(`${SB}/rest/v1/rpc/admin_save_data`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }, body: JSON.stringify({ p_pass: PASS, p_key: k, p_value: v }) });
  if (!r.ok) throw new Error('저장 실패 ' + r.status);
}

async function loadSession() {
  const stored = await sbGet('z17_session_enc');
  if (stored && stored.data) { try { const s = JSON.parse(decrypt(stored)); console.log('저장된(갱신된) 세션을 사용합니다.'); return s; } catch (e) { console.log('저장된 세션을 풀지 못해 Secret 값을 사용합니다.'); } }
  if (!INIT) bail('Z17_SESSION(Secret)이 없습니다. ticket-zone-bc17-login.js로 만들어 등록해 주세요.');
  try { return JSON.parse(INIT.startsWith('gz:') ? zlib.gunzipSync(Buffer.from(INIT.slice(3), 'base64')).toString('utf8') : INIT); } catch (e) { bail('Z17_SESSION 형식이 올바르지 않습니다.'); }
}

(async () => {
  let session = await loadSession();
  const browser = await chromium.launch({ headless: true });
  let ctx = await browser.newContext({ storageState: session, viewport: { width: 1280, height: 900 } });
  let page = await ctx.newPage();
  const deadline = Math.min(Date.now() + RUN_MS, EVENT_END);
  let layoutDone = false, runs = 0, lastSave = 0, fails = 0, lastGoto = 0, retried401 = false;
  while (Date.now() < deadline) {
    try {
      if (!lastGoto || Date.now() - lastGoto > 5 * 60000) { // 페이지는 5분마다 다시 열어 로그인 토큰을 갱신(토큰은 페이지를 열 때 갱신됨)
        await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(2500); lastGoto = Date.now();
      }
      const full = !layoutDone || runs % FULL_EVERY === 0;
      const r = await page.evaluate(collectInPage, { SB, SB_KEY, PASS, needLayout: !layoutDone, fast: !full });
      layoutDone = true; fails = 0; if (retried401) lastSave = 0; /* 토큰이 갱신됐으니 바로 보관 */ retried401 = false; runs++;
      console.log(`✅ [${new Date().toISOString()}] ${runs}회째(${full ? '전체' : '빠른'}) · 읽은 구역 ${r.polled}/${r.zones}개 · 잔여 ${r.free}석 · 실패 ${r.fail}개`);
      if (Date.now() - lastSave > 10 * 60000) { // 갱신된 세션을 10분마다 암호화해 보관
        await sbSave('z17_session_enc', encrypt(JSON.stringify(await ctx.storageState()))); lastSave = Date.now();
      }
      await sleep(EVERY_MS);
    } catch (e) {
      const m = String(e.message || e).split('\n')[0];
      fails++; lastGoto = 0;
      if (/401/.test(m) && !retried401) { // 토큰이 만료된 것일 수 있어 페이지를 다시 열어(토큰 갱신) 한 번 더 시도
        retried401 = true; lastGoto = 0; console.log('🔄 인증이 거절되어 페이지를 다시 열어 토큰을 갱신한 뒤 재시도합니다.'); fails--; continue;
      }
      if (/401/.test(m)) { console.error('🔑 29CM 로그인 세션이 만료되었습니다. ticket-zone-bc17-login.js로 다시 만들어 Secret Z17_SESSION을 교체하고, z17_session_enc는 자동으로 덮어쓰이게 둡니다.'); try { await sbSave('z17_session_enc', {}); } catch (x) {} await browser.close(); process.exit(2); }
      if (/저장 실패/.test(m)) { console.error('❌ ' + m + ' — 관리자 비밀번호(ADMIN_PASS)를 확인하세요.'); await browser.close(); process.exit(1); }
      console.error(`⚠️ 이번 회차 실패: ${m}`);
      if (fails >= 8) { console.error('연속 실패가 많아 종료합니다.'); await browser.close(); process.exit(1); }
      await sleep(60000);
    }
  }
  try { await sbSave('z17_session_enc', encrypt(JSON.stringify(await ctx.storageState()))); } catch (e) {}
  await browser.close();
  console.log('이번 실행 시간이 끝났습니다(다음 스케줄이 이어서 실행).');
})();
