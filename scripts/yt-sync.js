// 유튜브 업로드 자동 동기화 스크립트 (GitHub Actions에서 주기적으로 실행)
//
// 지금까지 유튜브 새 영상을 DB(yt_videos)에 반영하는 방법은 관리자 화면(#/admin/yttest)의
// "📥 전체 이력 동기화" 버튼을 사람이 직접 눌러주는 것뿐이었다 — 그래서 영상이 올라와도
// 관리자가 버튼을 누르기 전까지는 캘린더/예측에 전혀 반영되지 않았다. 이 스크립트는 그
// 수동 과정을 대체해서, 채널 업로드 재생목록의 "최근" 영상들을 주기적으로 가져와 자동으로
// DB에 채워 넣는다.
//
// 인증은 사람이 로그인할 때 쓰는 관리자 비밀번호(admin_check)를 CI에 넣는 대신,
// 이 저장소의 ticket-watch.js와 동일한 방식으로 봇 전용 비밀키(TICKET_BOT_SECRET과
// 같은 성격의 YT_BOT_SECRET)를 따로 두고, yt_bot_check()로만 확인하는
// yt_bot_upsert_videos()를 호출한다. (유튜브_업로드예측_패치.sql 참고)
//
// 분류 로직(카테고리/Shorts 판별)은 index.html의 ytClassify()/isShort 판정과 반드시
// 동일하게 맞춰야 한다 — 안 그러면 관리자가 수동 동기화했을 때와 자동 동기화가 서로 다른
// 카테고리를 매길 수 있다. (한쪽만 고치는 일이 없도록 여기 주석에도 명시해둔다)
//
// 필요한 환경변수:
//   SUPABASE_URL       기존 사이트와 동일한 값 (저장소 Variables)
//   SUPABASE_ANON_KEY  기존 사이트와 동일한 값 (저장소 Variables)
//   YT_BOT_SECRET      유튜브_업로드예측_패치.sql에서 설정한 "봇 전용 비밀키" (저장소 Secrets)
//   YOUTUBE_API_KEY    YouTube Data API v3 키 (저장소 Variables — 없으면 index.html에 있는
//                       공개용 키를 기본값으로 사용)
//   YT_CHANNEL_HANDLE  채널 핸들(@ 제외), 기본값 'blackcombat'
//   YT_SYNC_PAGES      한 번에 몇 페이지(각 50개)까지 가져올지, 기본값 2 (최신 100개 정도면
//                       평소 몇 분~몇 시간 간격 동기화에 충분하고, API 쿼터도 아낄 수 있다)
//
// 실패해도 사이트 자체는 멈추지 않는다 — 이번 실행만 건너뛰고 다음 스케줄에서 다시 시도한다.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const YT_BOT_SECRET = process.env.YT_BOT_SECRET;
// index.html의 YT_API_KEY와 동일한 공개용 키를 기본값으로 둔다 — 별도 키를 안 만들어도
// 바로 동작하게 하기 위함. 쿼터를 따로 관리하고 싶으면 저장소 Variables에 YOUTUBE_API_KEY를
// 채워서 덮어쓰면 된다.
const YT_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyBfFV0GO3ndECt8N7xBmKDsp_JOchzLi-Y';
const YT_CHANNEL_HANDLE = process.env.YT_CHANNEL_HANDLE || 'blackcombat';
const MAX_PAGES = Math.max(1, parseInt(process.env.YT_SYNC_PAGES || '2', 10) || 2);

function bail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) bail('SUPABASE_URL / SUPABASE_ANON_KEY 환경변수가 없습니다.');
if (!YT_BOT_SECRET) bail('YT_BOT_SECRET 환경변수가 없습니다. (유튜브_업로드예측_패치.sql의 안내를 참고해 site_data에 yt_bot_secret을 설정하고, 같은 값을 저장소 Secret YT_BOT_SECRET으로 등록하세요)');

// ISO8601 재생시간("PT1M30S")을 초로 변환 — index.html의 ytParseISODuration()과 동일
function parseISODuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return null;
  const h = +(m[1] || 0), mi = +(m[2] || 0), s = +(m[3] || 0);
  return h * 3600 + mi * 60 + s;
}

// 제목 키워드 기반 1차 자동분류 — index.html의 ytClassify()와 반드시 동일하게 유지
function classify(title, isShort) {
  if (isShort) return 'shorts';
  const t = title || '';
  if (/trailer/i.test(t) || t.includes('트레일러')) return 'trailer';
  if (t.includes('계체')) return 'weigh-in';
  if (t.includes('티켓') || t.includes('직관')) return 'ticket-promo';
  if (t.includes('미디어데이')) return 'media-day';
  if (/vs/i.test(t)) return 'matchup';
  return 'talk';
}

async function upsertRows(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/yt_bot_upsert_videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ p_secret: YT_BOT_SECRET, p_rows: rows }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Supabase 저장 실패 (${res.status}): ${bodyText}`);
  }
  return res.json().catch(() => null);
}

(async () => {
  try {
    console.log(`▶ 채널 정보 조회 중... (@${YT_CHANNEL_HANDLE})`);
    const chUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(YT_CHANNEL_HANDLE)}&key=${YT_API_KEY}`;
    const chRes = await fetch(chUrl);
    const chJson = await chRes.json();
    if (!chRes.ok) bail('채널 조회 실패: ' + JSON.stringify(chJson));
    const uploadsId = chJson.items && chJson.items[0] && chJson.items[0].contentDetails.relatedPlaylists.uploads;
    if (!uploadsId) bail('업로드 재생목록을 찾을 수 없습니다.');
    console.log('✅ 업로드 재생목록:', uploadsId);

    let pageToken = '';
    let totalFetched = 0;
    let totalUpserted = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const plUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${uploadsId}&maxResults=50&key=${YT_API_KEY}` + (pageToken ? `&pageToken=${pageToken}` : '');
      const plRes = await fetch(plUrl);
      const plJson = await plRes.json();
      if (!plRes.ok) { console.error(`❌ ${page}페이지 조회 실패:`, JSON.stringify(plJson)); break; }
      const items = plJson.items || [];
      totalFetched += items.length;
      console.log(`▶ ${page}페이지: ${items.length}개 (누적 조회 ${totalFetched}개)`);

      const ids = items.map((it) => it.contentDetails && it.contentDetails.videoId).filter(Boolean);
      let durMap = {};
      if (ids.length) {
        const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids.join(',')}&key=${YT_API_KEY}`;
        const vRes = await fetch(vUrl);
        const vJson = await vRes.json();
        if (vRes.ok) (vJson.items || []).forEach((v) => { durMap[v.id] = parseISODuration(v.contentDetails.duration); });
      }

      const rows = items.map((it) => {
        const sn = it.snippet || {};
        const vid = it.contentDetails && it.contentDetails.videoId;
        const dur = durMap[vid];
        const isShort = (dur != null && dur <= 60) || /#shorts/i.test(sn.title || '');
        const thumbs = sn.thumbnails || {};
        return {
          video_id: vid,
          title: sn.title || '',
          published_at: (it.contentDetails && it.contentDetails.videoPublishedAt) || sn.publishedAt,
          thumbnail_url: (thumbs.medium || thumbs.default || {}).url || '',
          duration_sec: dur,
          is_short: isShort,
          category: classify(sn.title || '', isShort),
          description: sn.description || '',
        };
      }).filter((r) => r.video_id && r.published_at);

      if (rows.length) {
        const data = await upsertRows(rows);
        if (!data || data.ok === false) { console.error('❌ 저장 실패:', JSON.stringify(data)); break; }
        totalUpserted = data.total;
        console.log(`   저장 완료 — DB 누적 ${totalUpserted}건`);
      }

      pageToken = plJson.nextPageToken;
      if (!pageToken) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    console.log(`\n✅ 동기화 완료. 이번 실행 조회 ${totalFetched}개 / DB 누적 저장 ${totalUpserted}건`);
  } catch (err) {
    console.error('❌ ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
  }
})();
