// 선수별 개인 전적 페이지(fighters/*.html) 자동 생성 — "{닉네임} 전적" 조합 검색 SEO용.
// fighters.json(랭킹/전적 요약)과 records.json(경기별 상세 기록)을 읽어 정적 HTML을 만든다.
// GitHub Actions(update-fighter-pages.yml)에서 records.json 자동 갱신 뒤 이어서 실행되며,
// 로컬에서도 `node scripts/generate-fighter-pages.js`로 바로 재생성할 수 있다.
// index.html/preview.html의 실제 화면은 건드리지 않는다 — 별도 정적 페이지만 생성.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOMAIN = 'https://xn--9r3b3ij2w.com';
const OUT_DIR = path.join(ROOT, 'fighters');
const SITEMAP = path.join(ROOT, 'sitemap.xml');

const fighters = JSON.parse(fs.readFileSync(path.join(ROOT, 'fighters.json'), 'utf-8'));
let records = null;
try { records = JSON.parse(fs.readFileSync(path.join(ROOT, 'records.json'), 'utf-8')); } catch (e) { records = null; }

const nickToId = {};
if (records && records.nicks) {
  for (const [id, nick] of Object.entries(records.nicks)) nickToId[nick] = id;
}

const RH_SUB_WORDS = ['choke', 'armbar', 'keylock', 'kimura', 'guillotine', 'triangle', 'lock', 'hook', 'crank', 'submission', 'americana', 'slicer'];
function classify(method) {
  const s = String(method || '').toLowerCase();
  if (/\btko\b|\bko\b/.test(s)) return 'KO';
  if (RH_SUB_WORDS.some(w => s.includes(w))) return 'SUB';
  if (s.includes('decision') || String(method || '').includes('판정')) return 'DEC';
  return 'ETC';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function slugify(nick) {
  return String(nick).normalize('NFC').replace(/\s+/g, '').replace(/[^\p{L}\p{N}_-]/gu, '');
}

const COUNTRY_NAME = {
  kr: '대한민국', krd: '대한민국', jp: '일본', br: '브라질', mn: '몽골', us: '미국',
  ru: '러시아', kz: '카자흐스탄', uz: '우즈베키스탄', kg: '키르기스스탄', tj: '타지키스탄',
  ua: '우크라이나', eg: '이집트', pe: '페루', bh: '바레인',
};

const today = new Date().toISOString().slice(0, 10);

const STYLE = `
    :root{
      --bg:#f3f3f6; --card:#ffffff; --ink:#111111; --text:#111111; --muted:#5f5f66; --dim:#8e8e93;
      --hair:#e3e3e8; --bg2:#e9e9ee; --amber:#f2b32a; --amber-text:#9a5f06; --amber-tint:rgba(242,179,42,.14);
      --red:#d0021b; --green:#1f7a3f;
    }
    *{box-sizing:border-box}
    body{
      margin:0; background:var(--bg); color:var(--text);
      font-family:'Pretendard Variable',Pretendard,-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Noto Sans KR','Segoe UI',sans-serif;
      line-height:1.7; -webkit-font-smoothing:antialiased; letter-spacing:-.012em;
    }
    a{color:inherit; text-decoration:none}
    .wrap{max-width:640px; margin:0 auto; padding:28px 20px 60px}
    header.top{padding:2px 0 22px}
    .brand{display:flex; align-items:center; gap:8px; font-weight:800; font-size:15px; color:var(--ink)}
    .brand .dot{width:7px; height:7px; border-radius:50%; background:var(--amber); display:inline-block}
    .brand small{font-weight:500; color:var(--dim); font-size:12.5px}
    .eyebrow{font-size:11px; font-weight:700; letter-spacing:.12em; color:var(--dim); text-transform:uppercase; margin:0 0 8px}
    h1{
      font-size:26px; line-height:1.35; margin:0 0 14px; letter-spacing:-.03em; font-weight:800;
      padding-bottom:16px; border-bottom:1px solid var(--ink);
    }
    .lead{color:var(--muted); font-size:14.5px; margin:0 0 26px}
    .tiles{display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--hair); border:1px solid var(--hair); border-radius:8px; overflow:hidden; margin:0 0 30px}
    .tiles .t{background:#fff; padding:14px 6px; text-align:center}
    .tiles .t .v{font-size:19px; font-weight:800; letter-spacing:-.02em}
    .tiles .t .k{font-size:11px; color:var(--muted); margin-top:2px}
    .sec{margin:0 0 30px}
    .sec h2{
      font-size:17px; font-weight:800; margin:0; padding:0 0 10px; border-bottom:1px solid var(--ink);
      letter-spacing:-.02em; display:flex; justify-content:space-between; align-items:baseline; gap:8px;
    }
    .sec h2 .note{font-weight:500; font-size:11.5px; color:var(--dim); letter-spacing:0; white-space:nowrap}
    .sec ul.plain{margin:0; padding:0; list-style:none}
    .sec ul.plain li{
      margin:0; padding:13px 0; font-size:14.5px; color:var(--text); border-bottom:1px solid var(--hair);
    }
    .sec ul.plain li:last-child{border-bottom:none}
    .mrow{display:flex; justify-content:space-between; align-items:baseline; gap:10px}
    .mrow .res{font-weight:800; font-size:12.5px; padding:2px 7px; border-radius:4px; flex:none}
    .mrow .res.W{background:var(--amber-tint); color:var(--amber-text)}
    .mrow .res.L{background:var(--bg2); color:var(--muted)}
    .mrow .res.D{background:var(--bg2); color:var(--muted)}
    .mrow .op{font-weight:700; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
    .mrow .ev{font-size:12px; color:var(--dim); margin-top:3px}
    .cta{
      display:block; text-align:center; background:var(--ink); color:#fff !important;
      font-weight:700; font-size:15.5px; padding:15px 18px; border-radius:8px;
      margin:26px 0 8px;
    }
    .cta.alt{background:#fff; color:var(--text) !important; border:1px solid var(--hair)}
    .rel{margin-top:34px; padding-top:22px; border-top:1px solid var(--hair)}
    .rel h3{font-size:11px; color:var(--dim); margin:0 0 12px; font-weight:700; letter-spacing:.1em; text-transform:uppercase}
    .rel-links{display:flex; flex-wrap:wrap; gap:8px}
    .rel-links a{
      display:inline-block; font-size:13px; padding:8px 12px; border-radius:6px;
      background:var(--bg2); color:var(--text); font-weight:500;
    }
    footer.bottom{margin-top:30px; padding-top:20px; border-top:1px solid var(--hair); color:var(--dim); font-size:12px; text-align:center}
    footer.bottom a{color:var(--dim); text-decoration:underline}
    .src{font-size:11.5px; color:var(--dim); margin-top:-18px; margin-bottom:26px}
    .src a{text-decoration:underline}
`;

function rankLabel(rank) {
  if (String(rank).toUpperCase() === 'C') return '👑 챔피언';
  const n = Number(rank);
  return Number.isFinite(n) && n > 0 ? `${n}위` : '';
}

// ── 체급별 선수 목록 평탄화 (공석 등 실제 선수가 아닌 빈 슬롯은 제외) ──
// 같은 선수가 두 체급에 동시 랭크된 경우(예: 언더그라운드 + 정규 체급)가 실제로 있어서,
// 닉네임+실명이 같으면 같은 사람으로 보고 페이지 하나로 합친다(중복 페이지 방지).
const byPerson = new Map(); // key: "닉네임::실명" -> 병합된 선수 객체
for (const d of (fighters.divisions || [])) {
  d.list.forEach((row, idx) => {
    const [rank, nick, real, w, l, dr, cc] = row;
    if (!nick || nick === '공석' || !real) return;
    const key = `${nick}::${real}`;
    const divInfo = { div: d.div, rank };
    if (byPerson.has(key)) {
      byPerson.get(key).divs.push(divInfo);
    } else {
      byPerson.set(key, {
        div: d.div, rank, nick, real, w: w || 0, l: l || 0, dr: dr || 0, cc: cc || '', idxInDiv: idx,
        divs: [divInfo],
      });
    }
  });
}
const flat = Array.from(byPerson.values());

const usedSlugs = new Set();
function uniqueSlug(nick) {
  let base = slugify(nick) || 'fighter';
  let slug = base, i = 2;
  while (usedSlugs.has(slug)) { slug = base + '-' + i; i++; }
  usedSlugs.add(slug);
  return slug;
}
flat.forEach(f => { f.slug = uniqueSlug(f.nick); });

// ── 기존 guide/*.html 페이지(사이트맵·상호링크용) ──
const guideDir = path.join(ROOT, 'guide');
const guideFiles = fs.existsSync(guideDir)
  ? fs.readdirSync(guideDir).filter(f => f.endsWith('.html')).sort()
  : [];

function renderFighter(f, allInDiv) {
  const id = nickToId[f.nick];
  const matches = (id && records && records.records && records.records[id]) ? records.records[id] : null;
  const sherdog = (id && records && records.sherdog && records.sherdog[id]) ? records.sherdog[id] : null;
  const url = `${DOMAIN}/fighters/${f.slug}.html`;

  let ko = 0, sub = 0, dec = 0;
  if (matches) {
    matches.forEach(m => {
      if (m.res !== 'W') return;
      const c = classify(m.m);
      if (c === 'KO') ko++; else if (c === 'SUB') sub++; else if (c === 'DEC') dec++;
    });
  }

  const rl = rankLabel(f.rank);
  const nation = COUNTRY_NAME[f.cc] || '';
  const multiDiv = f.divs.length > 1;
  const divNames = f.divs.map(d => d.div).join(' · ');
  const divRankPairs = f.divs.map(d => `${d.div}${rankLabel(d.rank) ? ' ' + rankLabel(d.rank) : ''}`).join(' · ');
  const title = `${f.nick} 전적 — 블랙컴뱃 ${f.div}${rl ? ' ' + rl : ''} | 블붕이`;
  const desc = `블랙컴뱃(Black Combat) ${divNames} 소속 ${f.nick}(${f.real}) 선수의 통산 전적은 ${f.w}승 ${f.l}패${f.dr ? ` ${f.dr}무` : ''}입니다. 최근 경기 기록과 승리 방식(KO/서브미션/판정)을 블붕이에서 확인하세요.`;

  const leadParts = [];
  if (multiDiv) {
    leadParts.push(`${f.nick}(${f.real})${nation ? `(${nation})` : ''}는 블랙컴뱃 ${divNames}에 랭크된 선수로, 통산 ${f.w}승 ${f.l}패${f.dr ? ` ${f.dr}무` : ''}의 전적을 보유하고 있습니다.`);
    leadParts.push(`현재 랭킹은 ${divRankPairs}입니다.`);
  } else {
    leadParts.push(`${f.nick}(${f.real})${nation ? `(${nation})` : ''}는 블랙컴뱃 ${f.div} 소속 선수로, 통산 ${f.w}승 ${f.l}패${f.dr ? ` ${f.dr}무` : ''}의 전적을 보유하고 있습니다.`);
    if (rl) leadParts.push(`현재 ${f.div} 랭킹은 ${rl}입니다.`);
  }
  const lead = leadParts.join(' ');

  const recentHtml = matches && matches.length ? `
      <div class="sec">
        <h2>최근 경기 기록 <span class="note">${Math.min(matches.length, 8)}경기</span></h2>
        <ul class="plain">
${matches.slice(0, 8).map(m => {
    const oppIsA = String(m.b && m.b[0]) === String(id);
    const opp = oppIsA ? (m.a ? m.a[1] : '') : (m.b ? m.b[1] : '');
    const resKo = m.res === 'W' ? '승' : m.res === 'L' ? '패' : m.res === 'D' ? '무' : m.res || '';
    return `          <li>
            <div class="mrow"><span class="op">vs ${esc(opp)}</span><span class="res ${esc(m.res || '')}">${esc(resKo)}</span></div>
            <div class="ev">${esc(m.ev || '')}${m.m ? ' · ' + esc(m.m) : ''}</div>
          </li>`;
  }).join('\n')}
        </ul>
      </div>` : '';

  const shown = matches ? Math.min(matches.length, 8) : 0;
  const finishHtml = (ko + sub + dec) > 0 ? `
      <div class="sec">
        <h2>승리 방식 <span class="note">최근 ${shown}경기 기준</span></h2>
        <ul class="plain">
          <li><div class="mrow"><span class="op">KO/TKO</span><span>${ko}회</span></div></li>
          <li><div class="mrow"><span class="op">서브미션</span><span>${sub}회</span></div></li>
          <li><div class="mrow"><span class="op">판정</span><span>${dec}회</span></div></li>
        </ul>
      </div>` : '';

  const others = allInDiv.filter(x => x.slug !== f.slug).slice(0, 4);
  const relLinks = others.map(o => `          <a href="${DOMAIN}/fighters/${o.slug}.html">${esc(o.nick)} 전적</a>`).join('\n');

  const personLd = {
    '@type': 'Person',
    name: f.nick,
    alternateName: f.real,
    ...(nation ? { nationality: nation } : {}),
  };
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    name: title,
    description: desc,
    url,
    inLanguage: 'ko',
    mainEntity: personLd,
    isPartOf: { '@type': 'WebSite', name: '블붕이', alternateName: ['블붕이.com', '블랙컴뱃 블붕이'], url: DOMAIN + '/' },
  };

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta property="og:site_name" content="블붕이">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${DOMAIN}/og.jpg?v=6">
<meta property="og:type" content="profile">
<meta property="og:url" content="${url}">
<meta property="og:locale" content="ko_KR">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${DOMAIN}/icon-192.png">
<script type="application/ld+json">
${JSON.stringify(ld)}
</script>
<style>${STYLE}</style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      <div class="brand"><span class="dot"></span> <a href="${DOMAIN}/">블붕이</a> <small>· 블랙컴뱃 팬 커뮤니티</small></div>
    </header>

    <p class="eyebrow">Fighter Record · ${esc(f.div)}</p>
    <h1>${esc(f.nick)} 전적</h1>
    <p class="lead">${esc(lead)}</p>

    <div class="tiles">
      <div class="t"><div class="v">${f.w}</div><div class="k">승</div></div>
      <div class="t"><div class="v">${f.l}</div><div class="k">패</div></div>
      <div class="t"><div class="v">${f.dr}</div><div class="k">무</div></div>
      <div class="t"><div class="v">${rl || '-'}</div><div class="k">${f.div} 랭킹</div></div>
    </div>
${recentHtml}
${finishHtml}
    <div class="sec">
      <h2>선수 정보</h2>
      <ul class="plain">
        <li><div class="mrow"><span class="op">실명</span><span>${esc(f.real)}</span></div></li>
        <li><div class="mrow"><span class="op">체급</span><span>${esc(multiDiv ? divRankPairs : f.div)}</span></div></li>
        ${nation ? `<li><div class="mrow"><span class="op">국적</span><span>${esc(nation)}</span></div></li>` : ''}
      </ul>
    </div>
    ${sherdog ? `<p class="src">공식 기록 출처: <a href="${esc(sherdog)}" target="_blank" rel="noopener nofollow">Sherdog 프로필 ↗</a></p>` : ''}

    <a class="cta" href="/#/records">블붕이 전적 허브에서 더 보기</a>
    <a class="cta alt" href="${DOMAIN}/">블붕이 홈으로 가기</a>

    <div class="rel">
      <h3>같은 체급(${esc(f.div)}) 다른 선수</h3>
      <div class="rel-links">
${relLinks}
      </div>
    </div>

    <footer class="bottom">
      블붕이는 블랙컴뱃 공식 사이트가 아닌 팬 커뮤니티입니다. 전적은 공식 사이트 데이터를 매일 자동 수집해 정리합니다.<br>
      <a href="${DOMAIN}/">xn--9r3b3ij2w.com (블붕이.com)</a>
    </footer>
  </div>
</body>
</html>
`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 이전 실행분 정리(은퇴/개명 등으로 사라진 선수 페이지 제거) 후 재생성
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith('.html')) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  const byDiv = {};
  flat.forEach(f => { (byDiv[f.div] = byDiv[f.div] || []).push(f); });

  let count = 0;
  for (const f of flat) {
    const html = renderFighter(f, byDiv[f.div]);
    fs.writeFileSync(path.join(OUT_DIR, `${f.slug}.html`), html, 'utf-8');
    count++;
  }
  console.log(`생성 완료: 선수 페이지 ${count}개`);

  // ── sitemap.xml 재생성: 홈 + guide/* + fighters/* ──
  const urls = [];
  urls.push(`  <url><loc>${DOMAIN}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`);
  for (const gf of guideFiles) {
    urls.push(`  <url><loc>${DOMAIN}/guide/${gf}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`);
  }
  for (const f of flat) {
    urls.push(`  <url><loc>${DOMAIN}/fighters/${f.slug}.html</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`);
  }
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  fs.writeFileSync(SITEMAP, sitemap, 'utf-8');
  console.log(`sitemap.xml 갱신 완료 (총 ${urls.length}개 URL)`);
}

main();
