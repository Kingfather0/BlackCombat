// 선수 랭킹 "변동 이력" 생성 스크립트 (GitHub Actions에서 랭킹 갱신 직후 실행)
// 랭킹 봇이 매일 커밋해 온 fighters.json의 git 이력을 거슬러 올라가
// 날짜별 순위 스냅샷을 rankhist.json 하나로 압축해 저장한다.
// 매 실행마다 이력 전체를 다시 만들기 때문에(결정적) 병합 버그가 없고,
// 오래된 데이터는 MAX_DAYS 이전 것을 잘라 파일 크기를 관리한다.
const fs = require('fs');
const { execSync } = require('child_process');

const OUT = 'rankhist.json';
const MAX_DAYS = 190; // 이 날짜 수를 넘는 과거 스냅샷은 버린다

function kstDate(iso) {
  // 커밋 시각(UTC) → 한국 날짜 문자열 YYYY-MM-DD
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

try {
  // fighters.json을 건드린 커밋 목록 (오래된 것 → 최신 순)
  const log = execSync(`git log --reverse --since=${MAX_DAYS}.days --format="%H|%aI" -- fighters.json`, { encoding: 'utf8' }).trim();
  if (!log) throw new Error('fighters.json 커밋 이력이 없습니다.');
  const commits = log.split('\n').map(l => { const [h, t] = l.split('|'); return { h, t }; });

  // 같은 날짜에 커밋이 여러 개면 마지막(가장 늦은) 것만 사용
  const byDate = new Map();
  for (const c of commits) byDate.set(kstDate(c.t), c);

  const dates = [...byDate.keys()].sort();
  const fighters = {}; // nick → { div, ranks: [] (dates와 정렬 맞춤; 'C'=0, 랭킹 밖=null) }

  dates.forEach((date, di) => {
    let json;
    try { json = JSON.parse(execSync(`git show ${byDate.get(date).h}:fighters.json`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })); }
    catch (e) { json = null; }
    // 이 날짜 열을 일단 전부 null로 채우고, 스냅샷에 있는 선수만 값을 넣는다
    Object.values(fighters).forEach(f => f.ranks.push(null));
    if (!json || !Array.isArray(json.divisions)) return;
    json.divisions.forEach(d => (d.list || []).forEach(f => {
      const nick = f[1];
      if (!nick || nick === '공석') return;
      const rank = f[0] === 'C' ? 0 : f[0];
      if (!fighters[nick]) fighters[nick] = { div: d.div, ranks: new Array(di + 1).fill(null) };
      fighters[nick].div = d.div; // 체급이 바뀌면 최신 체급으로
      fighters[nick].ranks[di] = rank;
    }));
  });

  // 데이터가 2개 미만인 선수는 그래프를 그릴 수 없으므로 제외하지 않고 그대로 둔다
  // (프론트에서 알아서 생략) — 다만 모든 값이 null인 선수는 제거
  Object.keys(fighters).forEach(n => {
    if (!fighters[n].ranks.some(r => r !== null)) delete fighters[n];
  });

  fs.writeFileSync(OUT, JSON.stringify({ updated_at: new Date().toISOString(), dates, fighters }));
  console.log(`rankhist.json 갱신 완료: ${dates.length}일치 · 선수 ${Object.keys(fighters).length}명`);
} catch (e) {
  console.error('랭킹 이력 생성 실패:', e.message);
  process.exit(1);
}
