// 유튜브 조회수 주기적 스냅샷 스크립트 (GitHub Actions에서 주기적으로 실행)
//
// scripts/yt-sync.js(10분마다)는 "새 영상을 놓치지 않는 것"이 목적이라 최근 업로드
// 100개 정도만 훑는다. 조회수는 새 영상뿐 아니라 이미 DB에 있는 예전 영상들도
// 계속 바뀌기 때문에, "이미 등록된 영상 전체"를 돌면서 조회수를 다시 받아오는 이
// 스크립트가 따로 필요하다.
//
// "영상별 조회수 차트가 어떻게 변화하는지 보고 싶다(쇼츠는 빼고 동영상 기준)"는
// 요청 반영 — yt_bot_upsert_view_stats RPC가 yt_videos.view_count를 최신화함과
// 동시에, 쇼츠가 아닌 영상만 골라 이번 시각(시간 단위로 반올림) 스냅샷을
// yt_view_snapshots에 남긴다. 스냅샷을 얼마나 자주 남길지는 이 스크립트의 실행
// 주기(.github/workflows/yt-view-snapshot.yml의 cron)가 그대로 결정한다 — 기본은
// 6시간마다(하루 4개 포인트)로, 조회수 흐름을 보기엔 충분하면서 DB 용량도 아낀다.
// 더 촘촘한 추이가 필요하면 그 워크플로우의 cron만 바꾸면 된다.
//
// 필요한 환경변수는 scripts/yt-sync.js와 동일 (SUPABASE_URL, SUPABASE_ANON_KEY,
// YT_BOT_SECRET, YOUTUBE_API_KEY).
//
// 실패해도 사이트 자체는 멈추지 않는다 — 이번 실행만 건너뛰고 다음 스케줄에서 다시 시도한다.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const YT_BOT_SECRET = process.env.YT_BOT_SECRET;
const YT_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyBfFV0GO3ndECt8N7xBmKDsp_JOchzLi-Y';

// YouTube API 키는 사이트(블붕이.com)에서 쓰는 공개 키라 Google Cloud에서 "HTTP 리퍼러" 제한이 걸려 있다.
// GitHub Actions 같은 서버 환경은 Referer 헤더가 비어 있어 403(API_KEY_HTTP_REFERRER_BLOCKED)이 나므로,
// 허용된 사이트 주소를 Referer로 붙여 호출한다. (다른 주소를 허용 목록에 쓰면 YT_REFERER 변수로 덮어쓰기)
const YT_REFERER = process.env.YT_REFERER || 'https://xn--9r3b3ij2w.com/';
function ytFetch(url) {
  return fetch(url, { headers: { Referer: YT_REFERER, 'User-Agent': 'Mozilla/5.0 (compatible; blbungi-sync)' } });
}

function bail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) bail('SUPABASE_URL / SUPABASE_ANON_KEY 환경변수가 없습니다.');
if (!YT_BOT_SECRET) bail('YT_BOT_SECRET 환경변수가 없습니다. (scripts/yt-sync.js와 같은 값을 씁니다)');

async function rpc(name, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`${name} 호출 실패 (${res.status}): ${bodyText}`);
  }
  return res.json().catch(() => null);
}

// 배열을 n개씩 나눈다 — 유튜브 videos.list API가 id 파라미터에 한 번에 최대 50개까지만
// 받아준다.
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

(async () => {
  try {
    console.log('▶ DB에 등록된 영상 목록 조회 중...');
    const listRes = await rpc('yt_bot_list_video_ids', { p_secret: YT_BOT_SECRET });
    if (!listRes || listRes.ok === false) {
      bail('영상 목록 조회 실패: ' + JSON.stringify(listRes) + ' — 유튜브_3차보완_패치.sql이 Supabase에 적용됐는지 확인하세요.');
    }
    const videos = listRes.videos || [];
    console.log(`✅ 등록된 영상 ${videos.length}개`);
    if (!videos.length) { console.log('영상이 없어서 종료합니다.'); return; }

    const batches = chunk(videos, 50);
    let totalUpdated = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const ids = batch.map((v) => v.video_id).filter(Boolean);
      if (!ids.length) continue;
      const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.join(',')}&key=${YT_API_KEY}`;
      const vRes = await ytFetch(vUrl);
      const vJson = await vRes.json();
      if (!vRes.ok) { console.error(`❌ ${i + 1}/${batches.length} 배치 조회 실패:`, JSON.stringify(vJson)); continue; }

      const rows = (vJson.items || [])
        .filter((v) => v.statistics && v.statistics.viewCount != null)
        .map((v) => ({ video_id: v.id, view_count: Number(v.statistics.viewCount) }));

      if (rows.length) {
        const data = await rpc('yt_bot_upsert_view_stats', { p_secret: YT_BOT_SECRET, p_rows: rows });
        if (!data || data.ok === false) { console.error('❌ 저장 실패:', JSON.stringify(data)); continue; }
        totalUpdated += data.updated || 0;
        console.log(`   ${i + 1}/${batches.length} 배치: ${rows.length}개 조회수 갱신`);
      }
      // 유튜브 API 연속 호출 사이 살짝 텀을 둔다(과도한 연속 요청 방지).
      await new Promise((r) => setTimeout(r, 150));
    }

    console.log(`\n✅ 조회수 스냅샷 완료. 총 ${totalUpdated}개 영상 갱신 (${videos.length}개 중)`);
  } catch (err) {
    console.error('❌ ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
  }
})();
