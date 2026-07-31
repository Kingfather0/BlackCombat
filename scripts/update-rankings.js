// 블랙컴뱃 공식 랭킹 자동 수집 스크립트 (GitHub Actions에서 매일 실행)
// 실패 시 기존 fighters.json을 건드리지 않고 종료 코드 1로 끝납니다.
const fs = require('fs');

const TARGET = 'https://www.blackcombat-official.com/ranking.php?type=fighter';
const OUT = 'fighters.json';
const DIVS = ['플라이급','벤텀급','페더급','라이트급','웰터급','미들급','헤비급','언더그라운드','여성부'];
const BADGES = /^(HOT|NEW|UP|DOWN|LIVE|[▲▼]\s*\d*)$/i;  // 사이트의 배지 텍스트는 이름이 아님
const DEFAULT_FLAGS = {"탱크": "jp", "인디언킹": "br", "보로클": "mn", "크로커다일": "br", "아마존 키드": "br", "부기맨": "br", "스나이퍼": "us", "스탠 바키": "kz", "핏불": "br", "닌자": "jp", "메탈 리": "jp", "백구": "mn", "펜리르": "kg", "무사": "jp", "백사자": "ru", "골든보이": "br", "쿠르드 이글": "ru", "보오르추": "mn", "피카츄": "jp", "아이언 홀스": "br", "구아라": "br", "스컬": "kz", "잉카": "pe", "lg": "us", "몽크": "br", "도미네이터": "ua", "스패로우": "br", "카우보이": "br", "싸이코": "br", "울프킹": "kg", "락스톤": "br", "데드샷": "ru", "불곰": "ru", "젤메": "mn", "trg": "br", "모카": "br", "머큐리": "br", "the man": "us", "토르": "jp", "아이언 힙": "jp", "수부타이": "mn", "다게르": "ru", "lion king": "us", "글래디에이터": "br", "그리즐리": "jp", "파라오": "eg", "빅프린스": "br", "칠라운": "mn", "코만도": "uz", "헌츠맨": "ru", "레오파드": "br", "사무라이": "br", "바이킹": "br", "젠틀맨": "br", "너드": "br", "쿠빌라이": "mn", "니카": "br", "오니": "jp", "로꼬": "br", "타노스": "br", "모모": "jp", "예티": "br", "피닉스": "br", "알라딘": "uz", "디멘터": "us", "제베": "mn", "보스베이비": "us", "잭팟": "us", "무칼리": "mn", "히로시마": "jp", "스콜피온": "tj", "바비": "jp"};

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
    if(dHit){
      if(out.some(o=>o.div===dHit)){ cur = null; continue; }  // 중복 섹션(미디어랭킹 등) 무시
      cur = {div:dHit, list:[]}; out.push(cur); pend=[]; pendRank=null; continue;
    }
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
    if(BADGES.test(ln)) continue;  // HOT/NEW 등 배지는 건너뜀
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
        if(f[1] && f[1] !== '공석' && f[6] && f[6] !== 'kr') prevFlags[String(f[1]).trim().toLowerCase()] = f[6];
      }));
    }catch(e){}
    const flagOf = n => prevFlags[String(n).trim().toLowerCase()] || DEFAULT_FLAGS[String(n).trim().toLowerCase()] || 'kr';

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
