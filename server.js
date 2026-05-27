'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT        = process.env.PORT || 3000;
const BASE_DIR    = __dirname;
const SCORES_FILE = path.join(BASE_DIR, 'scores.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js'  : 'text/javascript; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.ico' : 'image/x-icon',
  '.svg' : 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp3' : 'audio/mpeg',
  '.ogg' : 'audio/ogg',
  '.wav' : 'audio/wav',
};

// ── 점수 파일 ──────────────────────────────────────────────────
function readScores() {
  try { return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8')); }
  catch (_) { return []; }
}
function writeScores(arr) {
  try { fs.writeFileSync(SCORES_FILE, JSON.stringify(arr), 'utf8'); }
  catch (_) {}
}

// ── 정적 파일 서비스 ───────────────────────────────────────────
function serveFile(res, filePath) {
  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type' : mime,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // CORS
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ── 점수 API ──────────────────────────────────────────────────
  if (urlPath === '/api/scores') {
    if (req.method === 'GET') {
      const scores = readScores().slice(0, 10);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(scores));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const entry = JSON.parse(body);
          const scores = readScores();
          const ts = Date.now();
          const newEntry = {
            ts,
            em:      String(entry.em      || '🐱').slice(0, 4),
            name:    String(entry.name    || '익명').slice(0, 10),
            score:   Math.round(Number(entry.score)  || 0),
            time:    String(entry.time    || '').slice(0, 8),
            message: String(entry.message || '').slice(0, 10),
            levels:  String(entry.levels  || '').slice(0, 20),
            date:    new Date().toISOString().slice(0, 10),
          };
          scores.push(newEntry);
          scores.sort((a, b) => b.score - a.score);
          const top100 = scores.slice(0, 100);
          writeScores(top100);
          const rank = top100.findIndex(s => s.ts === ts) + 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ rank, top10: top100.slice(0, 10) }));
        } catch (e) {
          res.writeHead(400); res.end('error');
        }
      });
      return;
    }
  }

  // ── 정적 파일 ────────────────────────────────────────────────
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(BASE_DIR, safePath === '/' ? 'index.html' : safePath);

  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err || fs.statSync(filePath).isDirectory()) {
      serveFile(res, path.join(BASE_DIR, 'index.html'));
    } else {
      serveFile(res, filePath);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🧪  물 색깔 대결!  서버 실행 중`);
  console.log(`    http://localhost:${PORT}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌  포트 ${PORT} 가 이미 사용 중이에요. PORT 환경변수를 바꿔보세요.`);
  } else {
    console.error('서버 오류:', err.message);
  }
  process.exit(1);
});
