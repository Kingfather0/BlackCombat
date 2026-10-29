// 프리미어 중 영상 길이 확보 가능 여부 진단 (workflow_dispatch로 영상 ID를 넣어 실행)
// 3가지 경로를 각각 시도하고 마지막에 판정 요약을 출력한다.
const VID = (process.env.VIDEO_ID || '').trim().replace(/^.*[?&]v=/, '').replace(/^https?:\/\/youtu\.be\//, '').slice(0, 11);
const KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyBfFV0GO3ndECt8N7xBmKDsp_JOchzLi-Y';
const REFERER = process.env.YT_REFERER || 'https://xn--9r3b3ij2w.com/';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const result = {};

async function searchMode() {
  // 영상 ID가 없으면 API로 "예정/진행 중" 영상을 찾아 목록으로 진단한다(검색 쿼터 100 소모/회).
  // 주의: search.list의 eventType은 원래 라이브 방송용이라 프리미어가 항상 잡힌다는 보장은 없다.
  const ids = new Set();
  for (const ev of ['upcoming', 'live']) {
    const u = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&eventType=${ev}&regionCode=KR&relevanceLanguage=ko&maxResults=15&key=${KEY}`;
    const r = await fetch(u, { headers: { Referer: REFERER } });
    const j = await r.json();
    if (!r.ok) { console.log(`[검색 ${ev}] 실패`, r.status, JSON.stringify(j).slice(0, 300)); continue; }
    (j.items || []).forEach((it) => ids.add(it.id.videoId));
    console.log(`[검색 ${ev}] ${(j.items || []).length}개`);
  }
  if (!ids.size) { console.log('검색으로 찾은 영상이 없습니다.'); return; }
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet,liveStreamingDetails&id=${[...ids].join(',')}&key=${KEY}`, { headers: { Referer: REFERER } });
  const j = await r.json();
  console.log('\n상태 | duration(API) | 예정시작 | 실제시작 | 채널 | 제목 | ID');
  for (const v of j.items || []) {
    const l = v.liveStreamingDetails || {};
    console.log([v.snippet.liveBroadcastContent, JSON.stringify(v.contentDetails.duration), l.scheduledStartTime || '-', l.actualStartTime || '-', v.snippet.channelTitle, v.snippet.title.slice(0, 40), v.id].join(' | '));
  }
  console.log('\n→ duration이 PT0S/P0D가 아니라 실제 값이면 API로 프리미어 중 길이 확보 가능. 이 표에서 마음에 드는 ID로 VIDEO_ID 입력해 3경로 상세 진단도 가능.');
}

(async () => {
  if (!VID) { await searchMode(); return; }
  console.log('대상 영상:', VID, '\n');

  // [1] 공식 API
  try {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet,liveStreamingDetails,status&id=${VID}&key=${KEY}`, { headers: { Referer: REFERER } });
    const j = await r.json();
    const v = (j.items || [])[0];
    if (!v) console.log('[1] API: 영상을 못 찾음', r.status, JSON.stringify(j).slice(0, 300));
    else {
      console.log('[1] API liveBroadcastContent =', v.snippet.liveBroadcastContent);
      console.log('[1] API contentDetails.duration =', JSON.stringify(v.contentDetails.duration));
      console.log('[1] API liveStreamingDetails =', JSON.stringify(v.liveStreamingDetails || null));
      const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(v.contentDetails.duration || '');
      const sec = m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
      result.api = sec > 0 ? sec : null;
      result.state = v.snippet.liveBroadcastContent;
    }
  } catch (e) { console.log('[1] API 실패:', e.message); }

  // [2] 시청 페이지 HTML
  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${VID}&hl=ko`, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' } });
    const html = await r.text();
    const m = /"lengthSeconds":"(\d+)"/.exec(html);
    console.log(`\n[2] 시청페이지 HTTP ${r.status}, 본문 ${html.length}자, 동의/봇확인 화면 의심=${/consent\.youtube|unusual traffic|recaptcha/i.test(html)}`);
    console.log('[2] lengthSeconds =', m ? m[1] : '없음');
    const isPrem = /"isUpcoming":true|"isLiveContent":true/.test(html);
    console.log('[2] 페이지가 프리미어/라이브로 인식됨 =', isPrem);
    result.page = m && +m[1] > 0 ? +m[1] : null;
  } catch (e) { console.log('[2] 시청페이지 실패:', e.message); }

  // [3] 내부 player API (웹 클라이언트)
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: 'https://www.youtube.com' },
      body: JSON.stringify({ videoId: VID, context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'ko', gl: 'KR' } } }),
    });
    const j = await r.json().catch(() => ({}));
    const ls = j.videoDetails && j.videoDetails.lengthSeconds;
    console.log(`\n[3] player API HTTP ${r.status}, playability = ${j.playabilityStatus && j.playabilityStatus.status} / ${j.playabilityStatus && j.playabilityStatus.reason || ''}`);
    console.log('[3] videoDetails.lengthSeconds =', ls || '없음');
    result.player = ls && +ls > 0 ? +ls : null;
  } catch (e) { console.log('[3] player API 실패:', e.message); }

  console.log('\n========== 판정 ==========');
  console.log('영상 상태:', result.state || '(확인 못함)', '← upcoming/live 이어야 "프리미어 중" 테스트로 유효');
  for (const [k, n] of [['공식 API', result.api], ['시청 페이지', result.page], ['player API', result.player]]) {
    console.log(`${k}: ${n ? '✅ ' + n + '초 (' + Math.floor(n / 60) + '분 ' + (n % 60) + '초)' : '❌ 길이 못 얻음'}`);
  }
  const ok = result.api || result.page || result.player;
  console.log(ok ? '\n→ 최소 한 경로로 프리미어 중 길이 확보 가능' : '\n→ 이 영상/환경에서는 프리미어 중 길이 확보 불가');
})();
