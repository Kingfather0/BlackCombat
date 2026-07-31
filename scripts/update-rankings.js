// 블랙컴뱃 공식 랭킹 자동 수집 스크립트 (GitHub Actions에서 매일 실행)
// 실패 시 기존 fighters.json을 건드리지 않고 종료 코드 1로 끝납니다.
const fs = require('fs');

const TARGET = 'https://www.blackcombat-official.com/ranking.php?type=fighter';
const OUT = 'fighters.json';
const DIVS = ['플라이급','벤텀급','페더급','라이트급','웰터급','미들급','헤비급','언더그라운드','여성부'];

function decodeEntities(s){
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#0?39;/g,"'").replace(/&nbsp;/g,' ');
}

function htmlToLines(html){
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi,'\n')
    .replace(/<style[\s\S]*?<\/style>/gi,'\n')
    .replace(/<[^>]+>/g,'\n');
  return decodeEntities(cleaned).split(/\n+/).map(s=>s.trim()).filter(Boolean);
}

function parse(lines, flagOf){
  const recRe = /^(\d{1,3})\s*\/\s*(\d{1,3})\s*\/\s*(\d{1,3})$/;
  const out = [];
  let cur = null, pend = [], pendRank = null;
  for(const ln of lines){
    const dHit = DIVS.find(d => ln === d || (ln.startsWith(d) && ln.length <= d.length + 12));
    if(dHit){ cur = {div:dHit, list:[]}; out.push(cur); pend=[]; pendRank=null; continue; }
    if(!cur) continue;
    if(/^CHAMPION$/i.test(ln)) continue;
    if(/^\d{1,2}$/.test(ln)){ pendRank = parseInt(ln,10); pend=[]; continue; }
    const m = ln.match(recRe);
    if(m){
      if(pend.length){
        const nick = pend[0], real = pend[1] || '';
        const rank = pendRank != null ? pendRank : 'C';
        cur.list.push([rank, nick, real, +m[1], +m[2], +m[3], flagOf(nick)]);
      }
      pend=[]; pendRank=null; continue;
    }
    if(ln.length <= 30 && !/RANKING|MEDIA|CHAMPION|인스타|instagram|http|블랙컴뱃|BLACK ?COMBAT/i.test(ln)){
      pend.push(ln);
      if(pend.length > 2) pend = pend.slice(-2);
    }
  }
  out.forEach(d=>{
    d.list.sort((a,b)=>{ const ra=a[0]==='C'?0:a[0], rb=b[0]==='C'?0:b[0]; return ra-rb; });
    if(d.list.length && d.list[0][0] !== 'C') d.list.unshift(['C','공석','',0,0,0,'']);
  });
  return out.filter(d=>d.list.filter(f=>f[1]!=='공석').length >= 2);
}

(async ()=>{
  try{
    // 기존 데이터 (국기 유지용)
    let prevFlags = {};
    try{
      const prev = JSON.parse(fs.readFileSync(OUT,'utf8'));
      (prev.divisions||[]).forEach(d=>d.list.forEach(f=>{
        if(f[1] && f[1] !== '공석') prevFlags[String(f[1]).trim().toLowerCase()] = f[6] || 'kr';
      }));
    }catch(e){}
    const flagOf = n => prevFlags[String(n).trim().toLowerCase()] || 'kr';

    // 페이지 가져오기 (테스트 시 TEST_HTML 파일 사용 가능)
    let html;
    if(process.env.TEST_HTML){
      html = fs.readFileSync(process.env.TEST_HTML, 'utf8');
    }else{
      const res = await fetch(TARGET, {headers:{'User-Agent':'Mozilla/5.0 (ranking-bot)'}});
      if(!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      // 인코딩 감지 (euc-kr 대비)
      const head = buf.slice(0, 2048).toString('latin1');
      const cs = (head.match(/charset\s*=\s*["']?([\w-]+)/i)||[])[1] || 'utf-8';
      html = new TextDecoder(/euc[-_]?kr|ks_c/i.test(cs) ? 'euc-kr' : 'utf-8').decode(buf);
    }

    const parsed = parse(htmlToLines(html), flagOf);
    const total = parsed.reduce((n,d)=>n+d.list.filter(f=>f[1]!=='공석').length, 0);
    console.log(`파싱 결과: ${parsed.length}개 체급, ${total}명`);
    if(parsed.length < 5 || total < 40){
      throw new Error('파싱 결과가 비정상적입니다 (체급 '+parsed.length+', 선수 '+total+'명). 기존 데이터를 유지합니다.');
    }
    fs.writeFileSync(OUT, JSON.stringify({updated_at:new Date().toISOString(), divisions:parsed}, null, 1));
    console.log('fighters.json 갱신 완료');
  }catch(e){
    console.error('갱신 실패:', e.message);
    process.exit(1);
  }
})();
