// 블랙컴뱃 공식 "선수별 전적(LATEST MATCHES)" 자동 수집 스크립트 (GitHub Actions에서 매일 실행)
// 1) 랭킹 페이지에서 선수별 상세 페이지 번호(seq)와 닉네임을 수집하고
// 2) 각 선수의 상세 페이지(https://www.blackcombat-official.com/fighter/<seq>)에서
//    경기 이력(대회명 · 승/패 · 상대 · 마무리 방법)을 긁어 records.json으로 저장한다.
// 실패한 선수는 이전 records.json의 데이터를 그대로 유지하며(부분 갱신),
// 랭킹 파싱 자체가 비정상이면 아무것도 쓰지 않고 종료 코드 1로 끝난다.
const fs = require('fs');

const BASE = 'https://www.blackcombat-official.com';
const RANKING = BASE + '/ranking.php?type=fighter';
const OUT = 'records.json';

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
}
function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (records-bot)' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.slice(0, 2048).toString('latin1');
  const cs = (head.match(/charset\s*=\s*["']?([\w-]+)/i) || [])[1] || 'utf-8';
  return new TextDecoder(/euc[-_]?kr|ks_c/i.test(cs) ? 'euc-kr' : 'utf-8').decode(buf);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 랭킹 페이지에서 [ {seq, nick, real} ] 목록 추출
function parseRoster(html) {
  const roster = [];
  const seen = new Set();
  const re = /fighter\/(\d+)/g;
  const hits = [];
  let m;
  while ((m = re.exec(html)) !== null) hits.push({ seq: m[1], idx: m.index });
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].idx : Math.min(html.length, hits[i].idx + 4000);
    const frag = html.slice(hits[i].idx, end);
    const nick = (frag.match(/fighter_name"[^>]*>([^<]+)</) || [])[1];
    const real = (frag.match(/ring_name"[^>]*>([^<]*)</) || [])[1] || '';
    if (nick && !seen.has(hits[i].seq)) {
      seen.add(hits[i].seq);
      roster.push({ seq: hits[i].seq, nick: stripTags(nick), real: stripTags(real) });
    }
  }
  return roster;
}

// 선수 상세 페이지에서 경기 이력 추출 → [{ev, res, a:[seq,name], b:[seq,name], m}]
function parseMatches(html) {
  const start = html.indexOf('class="match_list"');
  if (start < 0) return [];
  const endIdx = html.indexOf('</ul>', start);
  const section = html.slice(start, endIdx > 0 ? endIdx : start + 60000);
  const out = [];
  const blocks = section.split(/<li\b/).slice(1);
  for (const b of blocks) {
    const infoIdx = b.indexOf('match_info');
    if (infoIdx < 0) continue;
    const gameFrag = b.slice(0, infoIdx);
    const infoFrag = b.slice(infoIdx);
    // 대회명: game_name 안의 첫 텍스트
    const ev = stripTags((gameFrag.match(/<span[^>]*>([\s\S]*?)<\/span>/) || [, ''])[1]);
    // 승/패 배지 — 이 페이지 "주인공 선수" 기준의 결과다.
    // 노 컨테스트(무효 경기)는 배지가 아예 없고 본문에 "No Contest"라고만 적혀 있으므로
    // 별도 결과값 'N'으로 저장한다 (무승부 'D'와는 다른 값).
    const badge = (infoFrag.match(/>\s*(Win|Loss|Draw)\s*</i) || [])[1];
    let res = badge ? badge[0].toUpperCase() : ''; // W / L / D / N
    if (!res && /no\s*contest/i.test(infoFrag)) res = 'N';
    // 양쪽 선수: fighter/<seq> 링크 순서대로 (왼쪽 → 오른쪽)
    const fighters = [];
    const aRe = /<a[^>]*fighter\/(\d+)[^>]*>([\s\S]*?)<\/a>/g;
    let am, lastEnd = infoIdx;
    while ((am = aRe.exec(infoFrag)) !== null && fighters.length < 2) {
      fighters.push([am[1], stripTags(am[2])]);
      lastEnd = am.index + am[0].length;
    }
    if (fighters.length < 2) {
      // 링크가 없는 쪽(비공개/삭제된 선수)은 텍스트로라도 이름을 확보한다
      const lines = stripTags(infoFrag).split(/\s+vs\s+/i);
      if (fighters.length === 0 && lines.length >= 2) {
        const left = lines[0].replace(/^(Win|Loss|Draw)\s*/i, '').trim();
        const right = lines[1].replace(/\s*\d*R?\s*[\d:]*\s*[A-Za-z].*$/, '').trim();
        fighters.push(['', left], ['', right]);
      } else if (fighters.length === 1) continue; // 한쪽만 있으면 신뢰 불가 — 건너뜀
    }
    // 마무리 방법: 마지막 선수 링크 뒤의 텍스트 (예: "2R 3:49 Rear Naked Choke")
    const method = stripTags(infoFrag.slice(lastEnd)).replace(/^vs\s+/i, '').trim();
    if (ev && res && fighters.length === 2) out.push({ ev, res, a: fighters[0], b: fighters[1], m: method });
  }
  return out;
}

(async () => {
  try {
    const html = await fetchHtml(RANKING);
    const roster = parseRoster(html);
    console.log(`랭킹에서 선수 ${roster.length}명 발견`);
    if (roster.length < 40) throw new Error('랭킹 파싱 결과가 비정상적입니다 (' + roster.length + '명). 기존 데이터를 유지합니다.');

    // 이전 데이터 (부분 실패 시 이어받기)
    let prev = { nicks: {}, reals: {}, records: {} };
    try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { }

    const nicks = { ...(prev.nicks || {}) };
    const reals = { ...(prev.reals || {}) };
    const records = { ...(prev.records || {}) };
    const sherdog = { ...(prev.sherdog || {}) }; // seq → 셔독(전체 전적 사이트) 프로필 링크
    roster.forEach(f => { nicks[f.seq] = f.nick; reals[f.seq] = f.real; });

    let ok = 0, fail = 0;
    for (const f of roster) {
      try {
        const page = await fetchHtml(BASE + '/fighter/' + f.seq);
        const matches = parseMatches(page);
        records[f.seq] = matches;
        // 상세 페이지의 "CERTIFIED BY SHERDOG" 링크 (없는 선수도 있으므로 있을 때만 저장)
        const sd = (page.match(/href="(https?:\/\/(?:www\.)?sherdog\.com\/fighter\/[^"]+)"/i) || [])[1];
        if (sd) sherdog[f.seq] = sd;
        ok++;
      } catch (e) {
        fail++;
        console.error(`  실패: ${f.nick} (${f.seq}) - ${e.message}`);
      }
      await sleep(250); // 공식 서버에 부담 주지 않도록 간격을 둔다
    }
    console.log(`전적 수집 완료: 성공 ${ok}명 · 실패 ${fail}명 · 셔독 링크 ${Object.keys(sherdog).length}명`);
    if (ok < 30) throw new Error('수집 성공 수가 너무 적습니다 (' + ok + '명). 기존 데이터를 유지합니다.');

    fs.writeFileSync(OUT, JSON.stringify({ updated_at: new Date().toISOString(), nicks, reals, records, sherdog }, null, 1));
    console.log('records.json 갱신 완료');
  } catch (e) {
    console.error('갱신 실패:', e.message);
    process.exit(1);
  }
})();
