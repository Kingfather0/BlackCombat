// 공식 홈페이지(blackcombat-official.com) 경기 목록 자동 수집 스크립트 (GitHub Actions에서 주기적으로 실행)
//
// "내가 링크 하나하나 다 설정해야 하냐?"는 지적 반영 — 예전엔 관리자가 공식 홈페이지에
// 들어가서 경기마다 eventDetail.php?eventSeq=N 번호를 직접 찾아 타이핑해야 했다. 이
// 스크립트는 공식 홈페이지의 경기 목록 페이지(event.php?eventCategory=...)를 정기적으로
// 긁어와 DB(yt_official_matches)에 저장해두고, 관리자 화면(#/admin/yttest → "🔗 경기
// 공식 링크 관리")이 날짜가 같은 경기를 자동으로 찾아 제안해주게 만든다. 최종 확인·저장은
// 여전히 사람이 버튼 한 번으로 한다 — 날짜만 보고 완전 자동으로 링크를 붙이면 엉뚱한
// 경기가 잘못 연결될 수 있어서다.
//
// 사이트 구조(2026-08-26 기준, 실제 확인):
//   - event.php?eventCategory=BC/N/R/C/E — 5개 카테고리(블랙컵/넘버링/라이즈/챔피언스리그/기타)
//     각각 전체 목록을 한 페이지에(페이지네이션 없이) 서버 렌더링 HTML로 내려준다.
//     JS 실행이 필요 없다 — 이 스크립트의 plain fetch()로도 동일한 HTML을 받는다.
//   - 경기 하나가 <li> 하나로, 그 안에 제목(<b>...</b>), 날짜("YYYY년 MM월 DD일" 텍스트),
//     장소(그다음 <div>), 그리고 상세보기 버튼의 onclick="location.href='/eventDetail.php
//     ?eventSeq=N'"에 번호가 박혀 있다. <a href>가 아니라 버튼 onclick이라 앵커 태그로는
//     못 찾고 정규식으로 eventSeq=\d+를 직접 뽑아야 한다.
//   - eventSeq는 전체 카테고리에 걸친 하나의 전역 카운터라, 카테고리 하나만 훑으면
//     번호가 듬성듬성 비어 보인다 — 5개 카테고리를 전부 훑어야 전체 목록이 된다.
//
// 인증은 scripts/yt-sync.js와 동일한 패턴 — 이미 등록해둔 YT_BOT_SECRET을 그대로
// 재사용한다(새 시크릿을 따로 등록할 필요 없음).
//
// 필요한 환경변수:
//   SUPABASE_URL / SUPABASE_ANON_KEY / YT_BOT_SECRET — scripts/yt-sync.js와 동일한 값.
//
// 실패해도 사이트 자체는 멈추지 않는다 — 이번 실행만 건너뛰고 다음 스케줄에서 다시 시도한다.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const YT_BOT_SECRET = process.env.YT_BOT_SECRET;

const OFFICIAL_BASE = 'https://www.blackcombat-official.com';
const CATEGORIES = [
  { code: 'BC', label: '블랙컵' },
  { code: 'N', label: '넘버링' },
  { code: 'R', label: '라이즈' },
  { code: 'C', label: '챔피언스리그' },
  { code: 'E', label: '기타' },
];

function bail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) bail('SUPABASE_URL / SUPABASE_ANON_KEY 환경변수가 없습니다.');
if (!YT_BOT_SECRET) bail('YT_BOT_SECRET 환경변수가 없습니다. (scripts/yt-sync.js와 같은 값을 씁니다)');

// 하나의 <li> 블록 안에서 eventSeq/제목/날짜/장소를 뽑는다. 실제 목록엔 경기가 아닌
// 다른 <li>(내비게이션/필터 등)도 섞여 있어서, eventSeq/제목/날짜가 전부 매칭돼야만
// "경기"로 인정한다(하나라도 없으면 조용히 건너뜀).
function parseListItem(itemHTML) {
  const seqM = /eventSeq=(\d+)/.exec(itemHTML);
  const titleM = /<b>\s*([\s\S]*?)\s*<\/b>/.exec(itemHTML);
  const dateVenueM = /<div[^>]*>\s*(\d{4})년\s*(\d{2})월\s*(\d{2})일\s*<\/div>\s*<div>\s*([\s\S]*?)\s*<\/div>/.exec(itemHTML);
  if (!seqM || !titleM || !dateVenueM) return null;
  const [, y, mo, d, venueRaw] = dateVenueM;
  return {
    event_seq: Number(seqM[1]),
    title: titleM[1].replace(/\s+/g, ' ').trim(),
    match_date: `${y}-${mo}-${d}`,
    venue: (venueRaw || '').replace(/\s+/g, ' ').trim() || null,
  };
}

async function fetchCategory(cat) {
  const url = `${OFFICIAL_BASE}/event.php?eventCategory=${encodeURIComponent(cat.code)}`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`❌ [${cat.label}] 목록 조회 실패 (${res.status})`); return []; }
  const html = await res.text();
  const items = html.match(/<li[^>]*>[\s\S]*?<\/li>/g) || [];
  const rows = items
    .map((li) => {
      const row = parseListItem(li);
      return row ? { ...row, category: cat.code } : null;
    })
    .filter(Boolean);
  console.log(`   [${cat.label}] ${items.length}개 <li> 중 경기 ${rows.length}개 인식`);
  return rows;
}

async function upsertRows(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/yt_bot_upsert_official_matches`, {
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
    console.log('▶ 공식 홈페이지 경기 목록 수집 중...');
    const byEventSeq = new Map();
    for (const cat of CATEGORIES) {
      const rows = await fetchCategory(cat);
      rows.forEach((r) => byEventSeq.set(r.event_seq, r)); // 카테고리 간 중복 방지
      await new Promise((r) => setTimeout(r, 200));
    }
    const allRows = [...byEventSeq.values()];
    console.log(`✅ 총 ${allRows.length}개 경기 인식 (5개 카테고리 합산, 중복 제거)`);
    if (!allRows.length) {
      bail('경기를 하나도 못 찾았습니다 — 사이트 구조가 바뀌었을 수 있어요. 이 스크립트 상단 주석의 정규식을 실제 페이지와 다시 맞춰봐야 합니다.');
    }

    // Supabase RPC 요청 하나에 너무 많은 행을 한 번에 보내지 않도록 50개씩 나눠서 저장.
    const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
    let totalUpserted = 0;
    for (const batch of chunk(allRows, 50)) {
      const data = await upsertRows(batch);
      if (!data || data.ok === false) {
        bail('저장 실패: ' + JSON.stringify(data) + ' — 유튜브_캘린더_4차보완_패치.sql이 Supabase에 적용됐는지 확인하세요.');
      }
      totalUpserted += data.upserted || 0;
    }
    console.log(`\n✅ 동기화 완료. 이번 실행 ${totalUpserted}건 갱신 (DB 누적 ${allRows.length}건 대상)`);
  } catch (err) {
    console.error('❌ ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
  }
})();
