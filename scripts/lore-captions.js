// 세계관 새 영상 자막 수집 스크립트 (lore-watch.js 다음에 GitHub Actions에서 실행)
//
// 왜 필요한가
//  - 서술을 고치는 Claude 예약 작업은 클라우드 프록시 때문에 YouTube에 직접 접속하지 못한다.
//  - GitHub Actions는 인터넷에 자유롭게 나갈 수 있으므로 여기서 자막을 받아 저장소에 텍스트로 남기고,
//    예약 작업은 저장소의 captions/<영상ID>.txt 만 읽으면 된다.
//
// 하는 일
//  1) lore-updates.json의 pending 영상마다 yt-dlp로 한국어 자막(자동 생성 포함)을 받는다.
//  2) 시간 표시와 중복을 지운 순수 텍스트를 captions/<id>.txt 로 저장하고, pending 항목에 cap:"ok"를 적는다.
//  3) 실패하면 capTry를 1 올리고 넘어간다 (최대 3번까지만 시도). YouTube가 차단하면 그냥 건너뛴다.
//  4) pending에서 빠진 영상(반영 완료)의 자막 파일은 지운다.
//
// 환경변수
//   LORE_ROOT            저장소 루트 (테스트용)
//   LORE_CAPTIONS_MOCK   테스트용: 폴더 경로. <id>.vtt 파일이 있으면 yt-dlp 대신 사용한다.
// 실패해도 워크플로는 멈추지 않는다 (항상 종료코드 0).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.env.LORE_ROOT || path.join(__dirname, '..');
const UPD = path.join(ROOT, 'lore-updates.json');
const CAP_DIR = path.join(ROOT, 'captions');
const MAX_TRY = 3;

function vttToText(vtt) {
  const out = [];
  let prev = '';
  for (let line of String(vtt).split(/\r?\n/)) {
    line = line.trim();
    if (!line || line === 'WEBVTT' || /^(Kind|Language|NOTE|STYLE)\b/.test(line) || /-->/.test(line) || /^\d+$/.test(line)) continue;
    line = line.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    if (!line || line === prev) continue;
    if (prev && line.startsWith(prev)) { out[out.length - 1] = line; prev = line; continue; } // 자동 자막의 누적 반복
    out.push(line); prev = line;
  }
  return out.join('\n');
}

function fetchVtt(id) {
  const mock = process.env.LORE_CAPTIONS_MOCK;
  if (mock) {
    const f = path.join(mock, id + '.vtt');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  try {
    execFileSync('yt-dlp', ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'ko.*,ko', '--sub-format', 'vtt',
      '--no-warnings', '--socket-timeout', '30', '-o', path.join(tmp, '%(id)s.%(ext)s'), 'https://www.youtube.com/watch?v=' + id],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  } catch (e) {
    console.log('yt-dlp 실패:', id, String((e.stderr || e.message || '')).split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300));
  }
  const f = fs.readdirSync(tmp).find(n => n.endsWith('.vtt'));
  const txt = f ? fs.readFileSync(path.join(tmp, f), 'utf8') : null;
  fs.rmSync(tmp, { recursive: true, force: true });
  return txt;
}

(function main() {
  try {
    if (!fs.existsSync(UPD)) { console.log('lore-updates.json 없음 - 종료'); return; }
    const upd = JSON.parse(fs.readFileSync(UPD, 'utf8'));
    const pending = upd.pending || [];
    let changed = false;
    fs.mkdirSync(CAP_DIR, { recursive: true });

    for (const p of pending) {
      const file = path.join(CAP_DIR, p.id + '.txt');
      if (fs.existsSync(file)) { if (p.cap !== 'ok') { p.cap = 'ok'; changed = true; } continue; }
      if ((p.capTry || 0) >= MAX_TRY) continue;
      const vtt = fetchVtt(p.id);
      const text = vtt ? vttToText(vtt) : '';
      if (text.length >= 200) {
        fs.writeFileSync(file, text + '\n');
        p.cap = 'ok'; delete p.capTry; changed = true;
        console.log('자막 저장:', p.id, text.length + '자');
      } else {
        p.capTry = (p.capTry || 0) + 1; changed = true;
        console.log('자막 없음/실패:', p.id, '시도', p.capTry + '/' + MAX_TRY);
      }
    }

    // 반영이 끝나 pending에서 빠진 영상의 자막은 지운다
    const keep = new Set(pending.map(p => p.id + '.txt'));
    for (const n of fs.readdirSync(CAP_DIR)) if (n.endsWith('.txt') && !keep.has(n)) { fs.unlinkSync(path.join(CAP_DIR, n)); console.log('자막 정리:', n); }
    if (!fs.readdirSync(CAP_DIR).length) fs.rmSync(CAP_DIR, { recursive: true, force: true });

    if (changed) fs.writeFileSync(UPD, JSON.stringify(upd, null, 1) + '\n');
  } catch (e) {
    console.log('자막 수집 중 오류(무시):', e.message);
  }
})();
