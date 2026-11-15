// 디시 블랙컴뱃 갤러리 접속 테스트 (1회성 진단) — GitHub Actions 서버에서 막히는지 확인한다.
// 글 내용은 저장하지 않고, 접속 결과와 파싱 가능 여부만 로그로 남긴다.
const URL = 'https://m.dcinside.com/board/blackcombat';
(async () => {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      redirect: 'follow',
    });
  } catch (e) {
    console.log('접속 실패:', e.message); process.exit(1);
  }
  const html = await res.text();
  console.log('상태코드:', res.status, '/ 걸린 시간(ms):', Date.now() - t0, '/ 크기(byte):', html.length);
  console.log('server:', res.headers.get('server'), '/ content-type:', res.headers.get('content-type'));
  const rows = (html.match(/gall-detail-lnktb/g) || []).length;
  const subs = [...html.matchAll(/<span class="subjectin">([^<]*)<\/span>/g)].map(m => m[1].trim());
  console.log('글 목록 행 수:', rows, '/ 제목 추출 수:', subs.length);
  console.log('제목 샘플(앞 5개):', subs.slice(0, 5));
  const blocked = /captcha|robot|접근이 제한|차단|Access Denied|Just a moment/i.test(html);
  console.log('차단/캡차 문구 감지:', blocked);
  if (!subs.length) console.log('--- 응답 앞부분 ---\n' + html.slice(0, 600));
  console.log(res.status === 200 && subs.length ? '결과: 수집 가능' : '결과: 수집 불가 또는 구조 확인 필요');
})();
