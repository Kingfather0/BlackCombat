#!/usr/bin/env node
/**
 * 블랙 퀴즈 — 문제 생성/검증 엔진
 *
 *   블랙컴뱃 원천 데이터(fighters.json / records.json / rankhist.json)
 *     → 정규화 → 템플릿 전개 → 오답 생성 → 10종 검증 → Daily Pool
 *
 * 핵심 원칙: 정답은 언제나 "원천 데이터"에서 나온다. 이 스크립트는 사실을 창작하지 않는다.
 *
 * 사용법
 *   node scripts/quiz-generate.js                 # 생성 + 검증만 (quiz-preview.json 출력)
 *   node scripts/quiz-generate.js --push          # Supabase 에 업로드까지
 *   node scripts/quiz-generate.js --stats         # 난이도/카테고리 분포만 출력
 *
 * 환경변수 (--push 일 때 필요)
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const PUSH = ARGS.includes('--push');
const STATS_ONLY = ARGS.includes('--stats');

/* ══════════════════════════════════════════════════════════════════════
   0. 결정론적 난수 — 같은 데이터면 같은 문제가 나오도록(재현 가능성)
   ══════════════════════════════════════════════════════════════════════ */
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function rngFrom(seed) {
  let a = hash32(String(seed));
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* 한국어 조사 자동 선택 — 해설 문장의 "'블랙맘바'은" 같은 어색함 방지 */
function hasJong(w) {
  const s = String(w).trim();
  if (!s) return false;
  const c = s.charCodeAt(s.length - 1);
  if (c < 0xAC00 || c > 0xD7A3) return false;   // 영문·숫자로 끝나면 받침 없음으로 취급
  return (c - 0xAC00) % 28 !== 0;
}
function jongType(w) {
  const s = String(w).trim();
  const c = s.charCodeAt(s.length - 1);
  if (c < 0xAC00 || c > 0xD7A3) return 0;
  return (c - 0xAC00) % 28;                      // 8 = ㄹ 받침
}
const J = {
  eun: w => hasJong(w) ? '은' : '는',
  i:   w => hasJong(w) ? '이' : '가',
  eul: w => hasJong(w) ? '을' : '를',
  ro:  w => { const t = jongType(w); return (t === 0 || t === 8) ? '로' : '으로'; },
  wa:  w => hasJong(w) ? '과' : '와',
};

function pickN(arr, n, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/* ══════════════════════════════════════════════════════════════════════
   1. 원천 데이터 로드
   ══════════════════════════════════════════════════════════════════════ */
function loadJson(name) {
  const p = path.join(ROOT, name);
  if (!fs.existsSync(p)) { console.error(`[!] ${name} 없음`); return null; }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
const FIGHTERS = loadJson('fighters.json');
const RECORDS = loadJson('records.json');
const RANKHIST = loadJson('rankhist.json');
if (!FIGHTERS || !RECORDS) { console.error('원천 데이터가 없어 중단합니다.'); process.exit(1); }

const SOURCE_UPDATED = {
  fighters: FIGHTERS.updated_at || null,
  records: RECORDS.updated_at || null,
  rankhist: RANKHIST ? RANKHIST.updated_at : null,
};

/* ══════════════════════════════════════════════════════════════════════
   2. 정규화 — 여기가 "정답이 2개인 문제"를 막는 가장 중요한 단계
   ══════════════════════════════════════════════════════════════════════ */

// 2-1. 국가 코드 → 한글 국가명
const COUNTRY = {
  kr: '대한민국', jp: '일본', br: '브라질', mn: '몽골', us: '미국',
  kz: '카자흐스탄', kg: '키르기스스탄', ru: '러시아', pe: '페루',
  ua: '우크라이나', eg: '이집트', uz: '우즈베키스탄', tj: '타지키스탄',
  cn: '중국', th: '태국', ph: '필리핀', vn: '베트남', gb: '영국',
  fr: '프랑스', ge: '조지아', am: '아르메니아', az: '아제르바이잔',
};

// 2-2. 승리 방식 정규화
//   원천 데이터에 'Rear Naked Choke'/'리어 네이키드 초크', 'Unanimous Decision'/'판정'/
//   '만장일치 판정승', 오타 'Unanimous Decison' 등이 섞여 있다. 이걸 그대로 보기로 쓰면
//   "정답이 2개"인 문제가 대량 생성되므로, 반드시 4개 버킷으로 수렴시킨다.
const METHOD_BUCKETS = ['KO', 'TKO', '판정', '서브미션'];
function normalizeMethod(raw) {
  if (!raw) return null;
  // 앞의 라운드/시간 표기 제거: "3R 1:20 " / "2R "
  let m = String(raw).replace(/^\s*\d+\s*R\s*/i, '').replace(/^\s*[\d]+:[\d]+\s*/, '').trim();
  const low = m.toLowerCase();
  if (!m) return null;
  if (/no\s*contest|무효|nc\b/i.test(m)) return null;
  if (/draw|무승부/i.test(m)) return null;
  if (/\btko\b/i.test(m)) return 'TKO';
  if (/\bko\b/i.test(m) && !/tko/i.test(m)) return 'KO';
  if (/knockout/i.test(low) && !/technical/i.test(low)) return 'KO';
  if (/technical\s*knockout|doctor\s*stoppage|corner\s*stoppage|의사\s*중단/i.test(low)) return 'TKO';
  if (/decision|판정|판정승|디시전/i.test(low)) return '판정';
  if (/choke|초크|armbar|arm\s*bar|암바|triangle|트라이앵글|kimura|기무라|americana|아메리카나|heel\s*hook|힐훅|kneebar|니바|submission|서브미션|서브미숀|guillotine|길로틴|anaconda|아나콘다|darce|다스|삼각|리어\s*네이키드|rnc/i.test(low)) return '서브미션';
  if (/tap|탭아웃/i.test(low)) return '서브미션';
  return null; // 정규화 실패 → 문제 생성에서 제외 (검증 6번)
}

// 2-3. 제외 대상
//   · '공석' 챔피언 3석
//   · 랭킹 내 중복 닉네임 8건 (조커/매드카우/스톤골렘/킹콩/코리안 갱스터/엄지장군/세비지 등)
//     → "○○의 체급은?" 같은 문제의 정답이 2개가 되므로 해당 템플릿에서 제외
const EXCLUDE_NAMES = new Set(['공석', '미정', 'TBD', '', '-']);

/* ── 선수 인덱스 구축 ── */
const divisions = FIGHTERS.divisions.map(d => ({
  div: d.div,
  list: d.list.map(r => ({
    rank: r[0], nick: r[1], real: r[2],
    w: +r[3] || 0, l: +r[4] || 0, d: +r[5] || 0,
    country: r[6] || '', badge: r[7] || '', delta: r[8],
  })).filter(f => f.nick && !EXCLUDE_NAMES.has(f.nick)),
}));

const nickCount = {};
divisions.forEach(d => d.list.forEach(f => { nickCount[f.nick] = (nickCount[f.nick] || 0) + 1; }));
const DUP_NICKS = new Set(Object.keys(nickCount).filter(k => nickCount[k] > 1));

const RANKED = [];   // 중복 닉네임 제외한 "안전한" 랭커
const ALL_RANKED = [];
divisions.forEach(d => d.list.forEach(f => {
  const o = Object.assign({ division: d.div }, f);
  ALL_RANKED.push(o);
  if (!DUP_NICKS.has(f.nick)) RANKED.push(o);
}));

const DIV_NAMES = divisions.map(d => d.div);
const nickToFighter = {};
RANKED.forEach(f => { nickToFighter[f.nick] = f; });

/* ── 전적 인덱스 구축 ── */
const NICKS = RECORDS.nicks || {};
const REALS = RECORDS.reals || {};
const REC = RECORDS.records || {};

const recNickCount = {};
Object.values(NICKS).forEach(n => { recNickCount[n] = (recNickCount[n] || 0) + 1; });
const REC_DUP = new Set(Object.keys(recNickCount).filter(k => recNickCount[k] > 1));

// 고유 경기 목록 (한 경기가 양쪽 선수에 중복 기록되어 있으므로 dedupe)
const BOUTS = [];
const boutSeen = new Set();
for (const fid of Object.keys(REC)) {
  for (const b of REC[fid] || []) {
    if (!b || !b.a || !b.b) continue;
    const aId = String(b.a[0]), bId = String(b.b[0]);
    const key = [b.ev, ...[aId, bId].sort()].join('|');
    if (boutSeen.has(key)) continue;
    boutSeen.add(key);
    let winner = null, loser = null;
    if (b.res === 'W') { winner = fid; loser = (fid === aId ? bId : aId); }
    else if (b.res === 'L') { loser = fid; winner = (fid === aId ? bId : aId); }
    BOUTS.push({
      key, ev: b.ev || '', aId, bId, winner, loser,
      method: normalizeMethod(b.m), rawMethod: b.m || '',
    });
  }
}

function recNick(id) { return NICKS[String(id)] || null; }
function recReal(id) { return REALS[String(id)] || null; }
function safeRecNick(id) {
  const n = recNick(id);
  if (!n || EXCLUDE_NAMES.has(n) || REC_DUP.has(n)) return null;
  return n;
}

// 선수별 상대 목록 (맞대결 문제용)
const OPPONENTS = {};
BOUTS.forEach(b => {
  (OPPONENTS[b.aId] = OPPONENTS[b.aId] || new Set()).add(b.bId);
  (OPPONENTS[b.bId] = OPPONENTS[b.bId] || new Set()).add(b.aId);
});

// 이벤트별 출전 선수
const EVENT_FIGHTERS = {};
BOUTS.forEach(b => {
  if (!b.ev) return;
  (EVENT_FIGHTERS[b.ev] = EVENT_FIGHTERS[b.ev] || new Set()).add(b.aId);
  EVENT_FIGHTERS[b.ev].add(b.bId);
});

/* ══════════════════════════════════════════════════════════════════════
   3. 문제 빌더
   ══════════════════════════════════════════════════════════════════════ */
const questions = [];
const rejects = {};
function reject(reason) { rejects[reason] = (rejects[reason] || 0) + 1; }

/**
 * @param o.question  문항 본문
 * @param o.answer    정답 문자열
 * @param o.wrong     오답 후보 배열 (3개 이상 필요, 앞에서부터 사용)
 * @param o.sourceKey 원천 식별자 (같은 소재의 유사 문제 중복 방지)
 */
function addQuestion(o) {
  const { question, answer, category, template_id, difficulty, sourceKey } = o;
  const seed = template_id + '|' + sourceKey;
  const rnd = rngFrom(seed);

  // ── 검증 1: 정답 존재
  if (!answer || !String(answer).trim()) { reject('1_정답없음'); return; }
  // ── 검증 5: 문항 문장
  if (!question || question.length > 95 || /\{|\}|undefined|null/.test(question)) {
    reject('5_문항오류'); return;
  }

  // ── 검증 3·4·10: 오답이 정답과 같거나(=정답 2개), 서로 중복되면 제거
  const norm = s => String(s).replace(/\s+/g, '').toLowerCase();
  const used = new Set([norm(answer)]);
  const wrong = [];
  for (const w of (o.wrong || [])) {
    if (!w || !String(w).trim()) continue;
    const k = norm(w);
    if (used.has(k)) continue;
    used.add(k); wrong.push(String(w));
    if (wrong.length === 3) break;
  }
  if (wrong.length < 3) { reject('3_오답부족'); return; }

  // 정답 위치는 균등 분포 (서버에서 한 번 더 셔플하지만, 저장 단계에서도 치우치지 않게)
  const slot = Math.floor(rnd() * 4);
  const choices = wrong.slice();
  choices.splice(slot, 0, String(answer));

  questions.push({
    question,
    category,
    template_id,
    difficulty,
    answer_a: choices[0], answer_b: choices[1], answer_c: choices[2], answer_d: choices[3],
    correct_answer: 'ABCD'[slot],
    explanation: o.explanation || null,
    source_key: sourceKey,
    source_data: o.sourceData || {},
    source_updated_at: o.sourceUpdatedAt || SOURCE_UPDATED.fighters,
    tags: o.tags || [],
    state: 'ACTIVE',
  });
}

/* ── 템플릿 1. 체급 챔피언 (EASY) ─────────────────────────────── */
divisions.forEach(d => {
  const champ = d.list.find(f => f.rank === 'C' || f.rank === 'c');
  if (!champ || EXCLUDE_NAMES.has(champ.nick)) return;   // '공석' 3체급 자동 제외
  const others = d.list.filter(f => f.nick !== champ.nick).map(f => f.nick);
  const pool = others.length >= 3 ? others
    : RANKED.filter(f => f.division !== d.div).map(f => f.nick);
  addQuestion({
    question: `현재 블랙컴뱃 ${d.div} 챔피언은 누구일까요?`,
    answer: champ.nick,
    wrong: pickN(pool, 6, rngFrom('champ' + d.div)),
    category: 'DIVISION', template_id: 'tpl_champion', difficulty: 'EASY',
    sourceKey: `div:${d.div}:champion`,
    sourceData: { division: d.div, champion: champ.nick },
    tags: [d.div, '챔피언'],
    explanation: `${d.div} 챔피언은 ${champ.nick}(${champ.real}) 선수입니다.`,
  });
});

/* ── 템플릿 1-b. 국적으로 선수 고르기 (EASY) — EASY 유형 다양화용 ── */
(function () {
  const byCountry = {};
  RANKED.forEach(f => { if (COUNTRY[f.country]) (byCountry[f.country] = byCountry[f.country] || []).push(f.nick); });
  Object.keys(byCountry).forEach(cc => {
    const mine = byCountry[cc], others = RANKED.filter(f => f.country !== cc).map(f => f.nick);
    if (mine.length < 1 || others.length < 3) return;
    const rnd = rngFrom('cpick' + cc);
    // 국가당 최대 3문항 — 같은 국가로 문제가 쏠리지 않게
    pickN(mine, Math.min(3, mine.length), rnd).forEach((nick, k) => {
      addQuestion({
        question: `다음 중 ${COUNTRY[cc]} 국적의 블랙컴뱃 선수는 누구일까요?`,
        answer: nick,
        wrong: pickN(others, 6, rngFrom('cpick' + cc + k)),
        category: 'FIGHTER', template_id: 'tpl_country_pick',
        difficulty: cc === 'kr' ? 'NORMAL' : 'EASY',
        sourceKey: `country:${cc}:pick${k}`,
        sourceData: { country: cc, nick },
        tags: [COUNTRY[cc]],
        explanation: `${nick} 선수${J.eun(nick)} ${COUNTRY[cc]} 국적입니다.`,
      });
    });
  });
})();

/* ── 템플릿 2. 선수의 체급 (상위 랭커 EASY / 나머지 NORMAL) ──── */
RANKED.forEach(f => {
  const rankNum = (f.rank === 'C') ? 0 : +f.rank;
  const wrongDivs = DIV_NAMES.filter(d => d !== f.division);
  addQuestion({
    question: `${f.nick} 선수가 속한 체급은 어디일까요?`,
    answer: f.division,
    wrong: pickN(wrongDivs, 5, rngFrom('div' + f.nick)),
    category: 'DIVISION', template_id: 'tpl_fighter_division',
    difficulty: (rankNum <= 5) ? 'EASY' : 'NORMAL',
    sourceKey: `fighter:${f.nick}:division`,
    sourceData: { nick: f.nick, division: f.division, rank: f.rank },
    tags: [f.division],
    explanation: `${f.nick} 선수${J.eun(f.nick)} ${f.division} 랭킹 ${f.rank === 'C' ? '챔피언' : f.rank + '위'}입니다.`,
  });
});

/* ── 템플릿 3. 본명 맞히기 (NORMAL) ───────────────────────────── */
Object.keys(NICKS).forEach(id => {
  const nick = safeRecNick(id), real = recReal(id);
  if (!nick || !real || EXCLUDE_NAMES.has(real)) return;
  // 한글 본명만 (외국 선수는 표기 흔들림이 커서 오답 판정이 애매해짐)
  if (!/^[가-힣]{2,5}$/.test(real)) return;
  const pool = Object.keys(REALS).map(k => REALS[k])
    .filter(r => r && r !== real && /^[가-힣]{2,5}$/.test(r));
  addQuestion({
    question: `블랙컴뱃 선수 '${nick}'의 본명은 무엇일까요?`,
    answer: real,
    wrong: pickN(pool, 6, rngFrom('real' + id)),
    category: 'FIGHTER', template_id: 'tpl_real_name',
    difficulty: nickToFighter[nick] ? 'NORMAL' : 'HARD',
    sourceKey: `fighter:${id}:realname`,
    sourceData: { id, nick, real },
    tags: ['본명'],
    sourceUpdatedAt: SOURCE_UPDATED.records,
    explanation: `'${nick}'${J.eun(nick)} ${real} 선수의 링네임입니다.`,
  });
});

/* ── 템플릿 4. 국적 (NORMAL) ──────────────────────────────────
   '정답은 대체로 한국'이라는 메타 공략을 막기 위해 한국인 선수는 일부만 출제한다. */
let krQuota = 0;
RANKED.forEach(f => {
  const ko = COUNTRY[f.country];
  if (!ko) return;
  if (f.country === 'kr') { krQuota++; if (krQuota % 4 !== 0) return; }
  const pool = Object.values(COUNTRY).filter(c => c !== ko);
  addQuestion({
    question: `${f.nick} 선수의 국적은 어디일까요?`,
    answer: ko,
    wrong: pickN(pool, 6, rngFrom('ctry' + f.nick)),
    category: 'FIGHTER', template_id: 'tpl_country',
    difficulty: f.country === 'kr' ? 'EASY' : 'NORMAL',
    sourceKey: `fighter:${f.nick}:country`,
    sourceData: { nick: f.nick, country: f.country },
    tags: [ko],
    explanation: `${f.nick} 선수${J.eun(f.nick)} ${ko} 국적입니다.`,
  });
});

/* ── 템플릿 5. 초성 퀴즈 (NORMAL) ─────────────────────────────── */
const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
function chosung(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0xAC00 && c <= 0xD7A3) out += CHO[Math.floor((c - 0xAC00) / 588)];
    else if (ch === ' ') out += ' ';
    else return null;   // 한글 아닌 글자가 섞이면 초성 퀴즈 부적합
  }
  return out;
}
RANKED.forEach(f => {
  const cho = chosung(f.nick);
  if (!cho || f.nick.replace(/\s/g, '').length < 2) return;
  const pool = RANKED.filter(x => x.nick !== f.nick && chosung(x.nick)
    && chosung(x.nick).replace(/\s/g, '').length === cho.replace(/\s/g, '').length)
    .map(x => x.nick);
  const fallback = RANKED.filter(x => x.nick !== f.nick).map(x => x.nick);
  addQuestion({
    question: `초성 힌트 「${cho}」 — 이 블랙컴뱃 선수는 누구일까요?`,
    answer: f.nick,
    wrong: pickN(pool.length >= 3 ? pool : fallback, 6, rngFrom('cho' + f.nick)),
    category: 'CHOSUNG', template_id: 'tpl_chosung',
    difficulty: f.nick.replace(/\s/g, '').length <= 3 ? 'NORMAL' : 'HARD',
    sourceKey: `fighter:${f.nick}:chosung`,
    sourceData: { nick: f.nick, chosung: cho },
    tags: ['초성'],
    explanation: `정답은 ${f.division} ${f.rank === 'C' ? '챔피언' : f.rank + '위'} ${f.nick} 선수입니다.`,
  });
});

/* ── 템플릿 6. 그 체급 랭커가 아닌 선수 (NORMAL) ──────────────── */
divisions.forEach(d => {
  const inDiv = d.list.filter(f => !DUP_NICKS.has(f.nick)).map(f => f.nick);
  if (inDiv.length < 3) return;
  const outside = RANKED.filter(f => f.division !== d.div).map(f => f.nick);
  const rnd = rngFrom('notin' + d.div);
  const three = pickN(inDiv, 3, rnd);
  const answer = pickN(outside, 1, rnd)[0];
  if (!answer) return;
  addQuestion({
    question: `다음 중 블랙컴뱃 ${d.div} 랭커가 아닌 선수는 누구일까요?`,
    answer,
    wrong: three,
    category: 'RANKING', template_id: 'tpl_not_in_division', difficulty: 'NORMAL',
    sourceKey: `div:${d.div}:notin`,
    sourceData: { division: d.div, outsider: answer, insiders: three },
    tags: [d.div],
    explanation: `${answer} 선수${J.eun(answer)} ${(nickToFighter[answer] || {}).division || '다른 체급'} 소속입니다.`,
  });
});

/* ── 템플릿 7. 랭킹 순위 (HARD) ───────────────────────────────── */
RANKED.forEach(f => {
  if (f.rank === 'C') return;
  const n = +f.rank; if (!n || n > 15) return;
  const cand = [];
  for (let k = 1; k <= 15; k++) if (k !== n) cand.push(`${k}위`);
  addQuestion({
    question: `${f.nick} 선수의 현재 ${f.division} 랭킹은 몇 위일까요?`,
    answer: `${n}위`,
    wrong: pickN(cand.filter(c => Math.abs(parseInt(c) - n) <= 4), 6, rngFrom('rk' + f.nick)),
    category: 'RANKING', template_id: 'tpl_rank_number',
    difficulty: n <= 5 ? 'HARD' : 'HELL',
    sourceKey: `fighter:${f.nick}:rank`,
    sourceData: { nick: f.nick, division: f.division, rank: n },
    tags: [f.division, '랭킹'],
    explanation: `${f.nick} 선수${J.eun(f.nick)} 현재 ${f.division} ${n}위입니다. (랭킹은 매일 갱신됩니다)`,
  });
});

/* ── 템플릿 8. 통산 전적 (HARD) ───────────────────────────────── */
RANKED.forEach(f => {
  if (f.w + f.l < 5) return;
  const ans = `${f.w}승 ${f.l}패`;
  const rnd = rngFrom('rec' + f.nick);
  const cand = [];
  for (const dw of [-2, -1, 1, 2, 3]) for (const dl of [-2, -1, 0, 1, 2]) {
    const w = f.w + dw, l = f.l + dl;
    if (w < 0 || l < 0 || (dw === 0 && dl === 0)) continue;
    cand.push(`${w}승 ${l}패`);
  }
  addQuestion({
    question: `${f.nick} 선수의 통산 전적은 몇 승 몇 패일까요?`,
    answer: ans,
    wrong: pickN(cand, 8, rnd),
    category: 'RECORD', template_id: 'tpl_record_wl',
    difficulty: (f.rank === 'C' || +f.rank <= 8) ? 'HARD' : 'HELL',
    sourceKey: `fighter:${f.nick}:record`,
    sourceData: { nick: f.nick, w: f.w, l: f.l, d: f.d },
    tags: [f.division, '전적'],
    explanation: `${f.nick} 선수의 통산 전적은 ${f.w}승 ${f.l}패${f.d ? ` ${f.d}무` : ''}입니다.`,
  });
});

/* ── 템플릿 9. 이 선수를 꺾은 선수 (HARD) ─────────────────────── */
BOUTS.forEach(b => {
  if (!b.winner || !b.loser) return;
  const wn = safeRecNick(b.winner), ln = safeRecNick(b.loser);
  if (!wn || !ln || !b.ev) return;
  const pool = Object.keys(NICKS)
    .filter(id => id !== b.winner && id !== b.loser
      && !(OPPONENTS[b.loser] || new Set()).has(id))
    .map(id => safeRecNick(id)).filter(Boolean);
  if (pool.length < 3) return;
  addQuestion({
    question: `${ln} 선수를 꺾은 상대는 누구일까요?`,
    answer: wn,
    wrong: pickN(pool, 6, rngFrom('beat' + b.key)),
    category: 'BOUT', template_id: 'tpl_who_beat',
    difficulty: nickToFighter[wn] ? 'HARD' : 'HELL',
    sourceKey: `bout:${b.key}:winner`,
    sourceData: { event: b.ev, winner: wn, loser: ln },
    tags: [b.ev],
    sourceUpdatedAt: SOURCE_UPDATED.records,
    explanation: `${wn} 선수가 ${ln} 선수에게 승리했습니다.`,
  });
});

/* ── 템플릿 10. 승리 방식 (HARD) ──────────────────────────────── */
BOUTS.forEach(b => {
  if (!b.winner || !b.loser || !b.method) return;   // 정규화 실패 건은 제외
  const wn = safeRecNick(b.winner), ln = safeRecNick(b.loser);
  if (!wn || !ln || !b.ev) return;
  addQuestion({
    question: `${wn} 선수가 ${ln} 선수를 꺾은 방식은?`,
    answer: b.method,
    wrong: METHOD_BUCKETS.filter(m => m !== b.method),
    category: 'METHOD', template_id: 'tpl_method',
    difficulty: nickToFighter[wn] ? 'HARD' : 'HELL',
    sourceKey: `bout:${b.key}:method`,
    sourceData: { event: b.ev, winner: wn, loser: ln, method: b.method, raw: b.rawMethod },
    tags: [b.ev, b.method],
    sourceUpdatedAt: SOURCE_UPDATED.records,
    explanation: `해당 경기는 ${b.method} 승리로 종료되었습니다. (공식 기록: ${b.rawMethod})`,
  });
});

/* ── 템플릿 11. 실제 맞대결 경험 (HELL) ───────────────────────── */
Object.keys(OPPONENTS).forEach(id => {
  const me = safeRecNick(id);
  if (!me) return;
  const opps = [...OPPONENTS[id]];
  const rnd = rngFrom('vs' + id);
  const oppNick = pickN(opps.map(safeRecNick).filter(Boolean), 1, rnd)[0];
  if (!oppNick) return;
  const myDiv = (nickToFighter[me] || {}).division || null;
  const neverAll = Object.keys(NICKS)
    .filter(x => x !== id && !OPPONENTS[id].has(x))
    .map(safeRecNick).filter(Boolean);
  // 같은 체급 선수는 (데이터에 없더라도) 실제로 맞붙었을 가능성이 있어 오답으로 부적합
  const neverFar = myDiv
    ? neverAll.filter(n => ((nickToFighter[n] || {}).division || '') !== myDiv)
    : neverAll;
  const never = neverFar.length >= 3 ? neverFar : neverAll;
  if (never.length < 3) return;
  addQuestion({
    question: `다음 중 ${me} 선수와 실제로 맞붙은 적이 있는 선수는?`,
    answer: oppNick,
    wrong: pickN(never, 6, rnd),
    category: 'MATCHUP', template_id: 'tpl_faced', difficulty: 'HELL',
    sourceKey: `fighter:${id}:faced`,
    sourceData: { nick: me, opponent: oppNick, opponents: opps.length },
    tags: ['맞대결'],
    sourceUpdatedAt: SOURCE_UPDATED.records,
    explanation: `${me} 선수${J.wa(me)} ${oppNick} 선수는 실제로 맞대결한 기록이 있습니다.`,
  });
});

/* ── 템플릿 12. 이벤트 출전 선수 (NORMAL) ─────────────────────── */
// 'C.L 01 - #3'처럼 정식 명칭이 아닌 내부 코드로 기록된 이벤트는 문제 문장에
// 그대로 노출하면 사용자가 알아볼 수 없으므로(예: "C.L 02- #11"), 이 템플릿에서는 제외한다.
Object.keys(EVENT_FIGHTERS).forEach(ev => {
  if (/^C\.L\b/i.test(ev)) return;
  const ids = [...EVENT_FIGHTERS[ev]];
  if (ids.length < 4) return;
  const rnd = rngFrom('ev' + ev);
  const ans = pickN(ids.map(safeRecNick).filter(Boolean), 1, rnd)[0];
  if (!ans) return;
  const notIn = Object.keys(NICKS).filter(x => !EVENT_FIGHTERS[ev].has(x))
    .map(safeRecNick).filter(Boolean);
  if (notIn.length < 3) return;
  addQuestion({
    question: `다음 중 '${ev}' 대회에 출전한 선수는 누구일까요?`,
    answer: ans,
    wrong: pickN(notIn, 6, rnd),
    category: 'EVENT', template_id: 'tpl_event_roster',
    difficulty: ids.length >= 8 ? 'NORMAL' : 'HARD',
    sourceKey: `event:${ev}:roster`,
    sourceData: { event: ev, fighter: ans, size: ids.length },
    tags: [ev],
    sourceUpdatedAt: SOURCE_UPDATED.records,
    explanation: `${ans} 선수${J.eun(ans)} '${ev}'에 출전했습니다.`,
  });
});

/* ── 템플릿 13. 최다 기록 (HELL) ──────────────────────────────── */
(function () {
  const cnt = {};   // id → {w, ko, sub, bouts}
  BOUTS.forEach(b => {
    for (const id of [b.aId, b.bId]) cnt[id] = cnt[id] || { w: 0, ko: 0, sub: 0, bouts: 0 };
    cnt[b.aId].bouts++; cnt[b.bId].bouts++;
    if (b.winner) {
      cnt[b.winner].w++;
      if (b.method === 'KO' || b.method === 'TKO') cnt[b.winner].ko++;
      if (b.method === '서브미션') cnt[b.winner].sub++;
    }
  });
  const metrics = [
    { k: 'w', label: '공식 전적 기록 기준, 가장 많은 승리를 거둔 선수는?', tpl: 'tpl_most_wins', unit: '승' },
    { k: 'ko', label: '공식 전적 기록 기준, KO·TKO 승리가 가장 많은 선수는?', tpl: 'tpl_most_ko', unit: '번의 KO·TKO 승' },
    { k: 'sub', label: '공식 전적 기록 기준, 서브미션 승리가 가장 많은 선수는?', tpl: 'tpl_most_sub', unit: '번의 서브미션 승' },
    { k: 'bouts', label: '공식 전적 기록 기준, 가장 많은 경기에 출전한 선수는?', tpl: 'tpl_most_bouts', unit: '경기' },
  ];
  metrics.forEach(m => {
    const ranked = Object.keys(cnt)
      .filter(id => safeRecNick(id))
      .sort((a, b2) => cnt[b2][m.k] - cnt[a][m.k]);
    if (ranked.length < 6) return;
    const top = ranked[0];
    // 1위가 공동이면 정답이 2개가 되므로 제외 (검증 10번)
    if (cnt[ranked[1]][m.k] === cnt[top][m.k]) { reject('10_공동1위'); return; }
    addQuestion({
      question: m.label,
      answer: safeRecNick(top),
      wrong: ranked.slice(1, 9).map(safeRecNick).filter(Boolean),
      category: 'RECORD', template_id: m.tpl, difficulty: 'HELL',
      sourceKey: `agg:${m.k}:top`,
      sourceData: { metric: m.k, top: safeRecNick(top), value: cnt[top][m.k] },
      tags: ['기록'],
      sourceUpdatedAt: SOURCE_UPDATED.records,
      explanation: `${safeRecNick(top)} 선수가 ${cnt[top][m.k]}${m.unit}${J.ro(m.unit)} 1위입니다.`,
    });
  });
})();

/* ── 템플릿 14. 순위 변동 (HELL) — 지금까지 아무데서도 안 쓰이던 rankhist.json 활용 ── */
if (RANKHIST && RANKHIST.dates && RANKHIST.fighters) {
  const dates = RANKHIST.dates;
  const iNow = dates.length - 1;
  const iPast = Math.max(0, dates.length - 15);
  if (iNow > iPast) {
    const byDiv = {};
    Object.keys(RANKHIST.fighters).forEach(nick => {
      const f = RANKHIST.fighters[nick];
      if (!f || !f.ranks || DUP_NICKS.has(nick) || EXCLUDE_NAMES.has(nick)) return;
      const now = f.ranks[iNow], past = f.ranks[iPast];
      if (typeof now !== 'number' || typeof past !== 'number') return;
      if (now <= 0 || past <= 0) return;              // 0 = 챔피언, 변동 개념이 다름
      (byDiv[f.div] = byDiv[f.div] || []).push({ nick, delta: past - now });
    });
    Object.keys(byDiv).forEach(div => {
      const arr = byDiv[div].sort((a, b) => b.delta - a.delta);
      if (arr.length < 5 || arr[0].delta <= 0) return;
      if (arr[1].delta === arr[0].delta) { reject('10_공동1위'); return; }
      addQuestion({
        question: `최근 ${dates.length - iPast}일간 ${div}에서 순위가 가장 많이 오른 선수는?`,
        answer: arr[0].nick,
        wrong: arr.slice(1, 9).map(x => x.nick),
        category: 'RANKING', template_id: 'tpl_rank_riser', difficulty: 'HELL',
        sourceKey: `div:${div}:riser`,
        sourceData: { division: div, top: arr[0].nick, delta: arr[0].delta, from: dates[iPast], to: dates[iNow] },
        tags: [div, '랭킹변동'],
        sourceUpdatedAt: SOURCE_UPDATED.rankhist,
        explanation: `${arr[0].nick} 선수가 ${arr[0].delta}계단 상승해 가장 큰 상승폭을 기록했습니다.`,
      });
    });
  }
}

/* ══════════════════════════════════════════════════════════════════════
   4. 최종 검증 — 중복 제거 및 품질 필터
   ══════════════════════════════════════════════════════════════════════ */
const finalQs = [];
const seenKey = new Set();
const seenText = new Set();
for (const q of questions) {
  const k = q.source_key + '|' + q.template_id;
  if (seenKey.has(k)) { reject('7_중복'); continue; }          // 검증 7
  const t = q.question.replace(/\s+/g, '');
  if (seenText.has(t)) { reject('8_유사문항'); continue; }      // 검증 8
  const set = new Set([q.answer_a, q.answer_b, q.answer_c, q.answer_d]
    .map(s => String(s).replace(/\s+/g, '').toLowerCase()));
  if (set.size !== 4) { reject('4_보기중복'); continue; }       // 검증 4
  if (!['EASY', 'NORMAL', 'HARD', 'HELL'].includes(q.difficulty)) { reject('9_난이도'); continue; }
  seenKey.add(k); seenText.add(t);
  finalQs.push(q);
}

/* ══════════════════════════════════════════════════════════════════════
   5. 리포트
   ══════════════════════════════════════════════════════════════════════ */
const byDiff = {}, byCat = {}, byTpl = {};
finalQs.forEach(q => {
  byDiff[q.difficulty] = (byDiff[q.difficulty] || 0) + 1;
  byCat[q.category] = (byCat[q.category] || 0) + 1;
  byTpl[q.template_id] = (byTpl[q.template_id] || 0) + 1;
});

console.log('─'.repeat(58));
console.log('🦁 블랙 퀴즈 — 문제 생성 결과');
console.log('─'.repeat(58));
console.log('원천 갱신:', JSON.stringify(SOURCE_UPDATED));
console.log(`중복 닉네임 제외: ${DUP_NICKS.size}건 [${[...DUP_NICKS].join(', ')}]`);
console.log(`고유 경기: ${BOUTS.length} / 이벤트: ${Object.keys(EVENT_FIGHTERS).length} / 랭커: ${ALL_RANKED.length}`);
console.log('');
console.log('난이도별:', JSON.stringify(byDiff));
console.log('카테고리별:', JSON.stringify(byCat));
console.log('템플릿별:', JSON.stringify(byTpl, null, 0));
console.log('검증 탈락:', JSON.stringify(rejects));
console.log(`\n✅ 최종 ${finalQs.length}문항`);

const MIN = { EASY: 12, NORMAL: 24, HARD: 24, HELL: 16 };
let warn = false;
for (const d of Object.keys(MIN)) {
  if ((byDiff[d] || 0) < MIN[d]) { console.error(`⚠️  ${d} 부족: ${byDiff[d] || 0} < ${MIN[d]}`); warn = true; }
}

fs.writeFileSync(path.join(ROOT, 'quiz-preview.json'),
  JSON.stringify({ generated_at: new Date().toISOString(), source: SOURCE_UPDATED,
    stats: { byDiff, byCat, byTpl, rejects }, questions: finalQs }, null, 1));
console.log('→ quiz-preview.json 저장');

if (STATS_ONLY) process.exit(warn ? 1 : 0);

/* ══════════════════════════════════════════════════════════════════════
   6. Supabase 업로드
   ══════════════════════════════════════════════════════════════════════ */
async function rpc(fn, body) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn} 실패 ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch (e) { return text; }
}

(async () => {
  if (!PUSH) { console.log('(--push 없이 실행 — 업로드 생략)'); return; }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY 환경변수가 필요합니다.');
    process.exit(1);
  }
  let ins = 0, upd = 0;
  const CHUNK = 200;
  for (let i = 0; i < finalQs.length; i += CHUNK) {
    const r = await rpc('quiz_batch_upsert_questions', { p_items: finalQs.slice(i, i + CHUNK) });
    ins += (r && r.inserted) || 0; upd += (r && r.updated) || 0;
    process.stdout.write(`\r  업로드 ${Math.min(i + CHUNK, finalQs.length)}/${finalQs.length}`);
  }
  console.log('');

  // 이번 회차에 생성되지 않은 자동 생성 문제는 원천에서 사라진 것 → 비활성화
  const alive = [...new Set(finalQs.map(q => q.source_key))];
  const pool = await rpc('quiz_batch_build_pool', { p_date: null });
  const cal = await rpc('quiz_batch_calibrate_difficulty', {});
  await rpc('quiz_batch_cleanup', {});
  await rpc('quiz_batch_log_run', {
    p_payload: {
      source_updated_at: SOURCE_UPDATED,
      generated: questions.length, approved: finalQs.length,
      rejected: questions.length - finalQs.length,
      reject_breakdown: rejects,
      pool_by_difficulty: (pool && pool.pool) || byDiff,
      status: warn ? 'WARN' : 'OK',
      message: `신규 ${ins} / 갱신 ${upd} / 난이도보정 ${(cal && cal.moved) || 0} / 유효 source_key ${alive.length}`,
    },
  });
  console.log(`✅ 업로드 완료 — 신규 ${ins} 갱신 ${upd}`);
  console.log('   Pool:', JSON.stringify((pool && pool.pool) || {}));
  if (warn) process.exit(1);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
