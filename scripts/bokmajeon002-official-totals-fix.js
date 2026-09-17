// 복마전 002 — 야차클럽 공식 유튜브 게시글에 공개된 좌석수로 사이트의 등급별 "총원"을
// 보정하는 1회성 콘솔 스크립트입니다.
//
// ⚠️ 이 파일도 (다른 1회성 스니펫들처럼) 재사용 가능성이 있어 유실 방지 차원에서 파일로
// 저장해둔 것입니다 — 매번 실행하는 스크립트가 아니라, 2026-09-17에 발견된 "총원 추정치가
// 실제 정원과 많이 다르다"는 문제를 딱 한 번 바로잡기 위한 용도입니다.
//
// ── 왜 필요한가 ──────────────────────────────────────────────────────────────
// 오픈 초기 자동 봇은 "첫 기록 시점의 잔여석 = 총원"이라고 가정한 추정치를 저장합니다.
// 북마클릿(scripts/nol-seatmap-bookmarklet.js)으로 실제 좌석맵을 세어 이 추정치를 정확한
// 값으로 덮어쓰는 경로가 이미 구현되어 있는데, 2026-09-17 복마전 지정석에서 이 실측이
// 조용히 실패(또는 DOM 카운트로 대체)해서 추정치가 그대로 남아있었던 것으로 보입니다
// (예: R1 총원이 7석으로 표시 — 실제로는 30석).
//
// ── 무엇을 하는가 ──────────────────────────────────────────────────────────
// 1. Supabase에서 이 행사의 가장 최근 기록(잔여석 등)을 그대로 읽어온다 (안 건드림).
// 2. 등급별 총원(meta.gradeTotals)만 아래 OFFICIAL_TOTALS(공식 발표 수치)로 교체해서
//    다시 저장한다. 사이트는 이 필드가 있으면 잔여석 기반 추정치보다 우선해서 보여준다.
//
// ── 사용 방법 ──────────────────────────────────────────────────────────────
// 블붕이 사이트(블붕이.com 등)를 브라우저에서 열고 F12 → Console 탭에 이 코드 전체를
// 붙여넣고 Enter. "✅ 공식 좌석수로 총원 보정 완료!" alert이 뜨면 성공.
//
// ── 다른 행사에 다시 쓸 때 ──────────────────────────────────────────────────
// EVENT_KEY / OFFICIAL_TOTALS 값만 그 행사에 맞게 바꾸면 재사용 가능합니다.
// p_secret 값("0729")은 사이트 봇 전용 비밀키 — 유출 주의.

(async function () {
  const SB_URL = 'https://dbtzakbmyfmqudjiycoj.supabase.co';
  const ANON = 'sb_publishable_xtTqzRYwBZBUQyeqHhHVcA_CG2e-1fA';
  const EVENT_KEY = 'yachaclub_bokmajeon002_2026_1011';

  // 2026-09-17 야차클럽 공식 유튜브 게시글 캡처 기준 (등급 → 좌석수)
  // 단차석은 원 게시글에서 B-1(1260)+B-2(1260)로 나뉘어 있지만, 사이트는 "단차" 한 등급으로
  // 합쳐서 기록하므로 여기서도 2520으로 합산. 휠체어석은 원 게시글에 안 보여서 그대로 둠(미포함).
  const OFFICIAL_TOTALS = {
    VVIP: 60,
    VIP: 64,
    R1: 30,
    R2: 92,
    S1: 72,
    S2: 74,
    A1: 30,
    A2: 92,
    '단차': 2520,
    '야차스탠딩': 750,
    '피버존': 600,
  };

  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/ticket_snapshots?event_key=eq.${encodeURIComponent(EVENT_KEY)}&order=captured_at.desc&limit=1`,
      { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } }
    );
    if (!res.ok) return void alert('❌ 기존 기록 조회 실패 (' + res.status + ')');
    const rows = await res.json();
    if (!rows.length) return void alert('❌ 이 event_key로 저장된 기록을 찾지 못했습니다: ' + EVENT_KEY);
    const row = rows[0];
    const grades = row.grades || {};

    const sellableTotal = Object.values(OFFICIAL_TOTALS).reduce((a, b) => a + b, 0);
    const meta = Object.assign({}, row.meta || {}, {
      gradeTotals: OFFICIAL_TOTALS,
      overallTotal: sellableTotal,
      sellableTotal,
      source: '야차클럽 공식 유튜브 게시글 좌석수 (2026-09-17 보정)',
    });

    const body = {
      p_secret: '0729',
      p_event_key: EVENT_KEY,
      p_round_label: row.round_label,
      p_grades: grades, // 잔여석은 기존 기록 그대로 유지 (건드리지 않음)
      p_totals: null,
      p_meta: meta,
    };

    const saveRes = await fetch(`${SB_URL}/rest/v1/rpc/record_ticket_snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}` },
      body: JSON.stringify(body),
    });
    if (!saveRes.ok) {
      const t = await saveRes.text().catch(() => '');
      return void alert('❌ 저장 실패 (' + saveRes.status + ')\n' + t.slice(0, 300));
    }
    alert(
      '✅ 공식 좌석수로 총원 보정 완료!\n\n' +
      Object.keys(OFFICIAL_TOTALS).map(k => k + ': ' + OFFICIAL_TOTALS[k] + '석').join('\n') +
      '\n\n합계: ' + sellableTotal.toLocaleString() + '석'
    );
  } catch (e) {
    alert('❌ 스크립트 실행 중 오류: ' + (e && e.message ? e.message : String(e)));
  }
})();
