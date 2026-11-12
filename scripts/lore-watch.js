// 세계관 새 영상 감지 스크립트 (GitHub Actions에서 주기적으로 실행)
//
// 하는 일
//  1) 채널 업로드 재생목록의 최근 영상을 가져온다 (yt-sync.js와 같은 방식/같은 API 키).
//  2) lore-updates.json의 watch_since 이후에 올라왔고, lore.json의 videos에 아직 없는
//     일반 영상(쇼츠·예정 영상 제외)을 찾는다.
//  3) 찾은 영상을 lore.json의 videos에 자동 등록하고(제목·분), lore-updates.json의
//     pending(반영 대기 영상)에 추가한다.
//
// 하지 않는 일
//  - 최신 흐름, 연대기, 선수 정보 같은 서술은 건드리지 않는다. 서술은 사람이 확인하며 고치고,
//    그때 lore-updates.json의 items에 갱신 내역을 추가한다 (items가 늘어야 세계관의 빨간 점이 켜진다).
//  - lore.meta.updated(갱신일)도 건드리지 않는다.
//
// 환경변수
//   YOUTUBE_API_KEY   없으면 yt-sync.js와 같은 공개 키 사용
//   YT_CHANNEL_HANDLE 기본값 blackcombat
//   YT_REFERER        기본값 https://xn--9r3b3ij2w.com/ (API 키의 리퍼러 제한 때문)
//   LORE_WATCH_MOCK   테스트용: JSON 파일 경로. 지정하면 네트워크 없이 이 파일의 영상 목록을 사용한다.
//                     형식: [{id,title,publishedAt,durationSec,live}]
// 실패해도 사이트는 멈추지 않는다 — 이번 실행만 건너뛰고 다음 스케줄에서 다시 시도한다.

const fs = require('fs');
const path = require('path');

const ROOT = process.env.LORE_ROOT || path.join(__dirname, '..');
const LORE = path.join(ROOT, 'lore.json');
const UPD = path.join(ROOT, 'lore-updates.json');
const YT_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyBfFV0GO3ndECt8N7xBmKDsp_JOchzLi-Y';
const HANDLE = process.env.YT_CHANNEL_HANDLE || 'blackcombat';
const REFERER = process.env.YT_REFERER || 'https://xn--9r3b3ij2w.com/';
const MAX_PENDING = 30;
const PENDING_DAYS = 30;

function ytFetch(url) {
  return fetch(url, { headers: { Referer: REFERER, 'User-Agent': 'Mozilla/5.0 (compatible; blbungi-lore-watch)' } });
}
function parseDur(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return null;
  const t = (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  return t > 0 ? t : null;
}
// yt-sync.js의 classify()와 같은 기준 — 알림 패널에서 영상 종류를 보여주는 데만 쓴다.
function classify(title) {
  const t = title || '';
  if (/trailer/i.test(t) || t.includes('트레일러')) return '트레일러';
  if (t.includes('계체')) return '계체량';
  if (t.includes('티켓') || t.includes('직관')) return '티켓 프로모';
  if (/미디어\s*데이/.test(t) || /media\s*day/i.test(t)) return '미디어데이';
  if (/vs/i.test(t)) return '경기';
  return '콘텐츠';
}

async function fetchRecent() {
  if (process.env.LORE_WATCH_MOCK) return JSON.parse(fs.readFileSync(process.env.LORE_WATCH_MOCK, 'utf8'));
  const ch = await (await ytFetch(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(HANDLE)}&key=${YT_API_KEY}`)).json();
  const up = ch && ch.items && ch.items[0] && ch.items[0].contentDetails.relatedPlaylists.uploads;
  if (!up) throw new Error('업로드 재생목록을 찾지 못했습니다: ' + JSON.stringify(ch).slice(0, 200));
  const pl = await (await ytFetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${up}&maxResults=50&key=${YT_API_KEY}`)).json();
  const items = (pl.items || []).filter(i => i.contentDetails && i.contentDetails.videoId);
  const ids = items.map(i => i.contentDetails.videoId);
  if (!ids.length) return [];
  const vs = await (await ytFetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${ids.join(',')}&key=${YT_API_KEY}`)).json();
  return (vs.items || []).map(v => ({
    id: v.id,
    title: v.snippet.title,
    publishedAt: v.snippet.publishedAt,
    durationSec: parseDur(v.contentDetails.duration),
    live: v.snippet.liveBroadcastContent || 'none'
  }));
}

function save(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 1) + '\n'); }

(async () => {
  const lore = JSON.parse(fs.readFileSync(LORE, 'utf8'));
  const upd = fs.existsSync(UPD) ? JSON.parse(fs.readFileSync(UPD, 'utf8')) : { schema: 1, items: [], pending: [] };
  upd.items = upd.items || []; upd.pending = upd.pending || [];
  if (!upd.watch_since) upd.watch_since = new Date().toISOString();
  lore.videos = lore.videos || {};
  const since = new Date(upd.watch_since).getTime();
  let changed = false;

  // lore.json이 예전 파일로 덮어써져 자동 등록분이 사라졌다면 pending 기록으로 복구한다.
  upd.pending.forEach(p => { if (!lore.videos[p.id]) { lore.videos[p.id] = { t: p.title, m: p.min }; changed = true; console.log('복구:', p.id, p.title); } });

  let recent;
  try { recent = await fetchRecent(); } catch (e) { console.error('가져오기 실패, 이번 실행은 건너뜁니다:', e.message); process.exit(0); }

  const known = new Set(Object.keys(lore.videos).concat(upd.pending.map(p => p.id)));
  const fresh = recent
    .filter(v => v && v.id && !known.has(v.id))
    .filter(v => new Date(v.publishedAt).getTime() > since)
    .filter(v => !v.live || v.live === 'none')               // 예정/진행 중 프리미어는 공개된 뒤에 처리
    .filter(v => v.durationSec != null && v.durationSec > 180) // 길이를 모르면 다음 실행에, 3분 이하는 쇼츠
    .filter(v => !/#shorts/i.test(v.title || ''))
    .sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));

  fresh.forEach(v => {
    const min = Math.max(1, Math.round(v.durationSec / 60));
    lore.videos[v.id] = { t: v.title, m: min };
    upd.pending.unshift({ id: v.id, title: v.title, published: v.publishedAt, min, cat: classify(v.title) });
    console.log('새 영상:', v.id, v.title);
    changed = true;
  });

  const cutoff = Date.now() - PENDING_DAYS * 864e5;
  const before = upd.pending.length;
  upd.pending = upd.pending.filter(p => new Date(p.published).getTime() >= cutoff).slice(0, MAX_PENDING);
  if (upd.pending.length !== before) changed = true;

  if (changed) { save(LORE, lore); save(UPD, upd); console.log('저장 완료. 반영 대기 영상', upd.pending.length, '개'); }
  else if (!fs.existsSync(UPD) || JSON.stringify(JSON.parse(fs.readFileSync(UPD, 'utf8'))) !== JSON.stringify(upd)) { save(UPD, upd); console.log('감시 시작 시각 기록'); }
  else console.log('변경 없음');
})();
