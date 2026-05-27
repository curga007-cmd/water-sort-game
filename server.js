'use strict';

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

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

// ── 빠른 매칭 큐 (메모리) ──────────────────────────────────────
let matchQueue = null;
let matchTimer  = null;
function clearMatch() {
  matchQueue = null;
  clearTimeout(matchTimer);
  matchTimer = null;
}

// ── 열린 방 목록 (HTTP 등록, WS 종료 시 삭제) ────────────────────
const openRooms = new Map(); // roomCode → {code, emoji, name, count, max, ts}

// ── WebSocket 게임 릴레이 ────────────────────────────────────────
// roomCode → { hostWs, guests: Map<idx, ws>, nextIdx }
const gameRooms = new Map();
const wss       = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
  const url  = new URL(req.url, 'http://localhost');
  const room = url.searchParams.get('room');
  const role = url.searchParams.get('role') || 'guest';
  if (!room) { ws.close(1008, 'no room'); return; }

  let roomData = gameRooms.get(room);
  let myIdx    = 0;

  if (role === 'host') {
    if (!roomData) {
      roomData = { hostWs: ws, guests: new Map(), nextIdx: 1 };
      gameRooms.set(room, roomData);
    } else {
      roomData.hostWs = ws;
    }
    ws.send(JSON.stringify({ type: '_ready', idx: 0 }));
  } else {
    // guest
    if (!roomData || !roomData.hostWs || roomData.hostWs.readyState !== WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: '_noHost' }));
      ws.close(); return;
    }
    myIdx = roomData.nextIdx++;
    roomData.guests.set(myIdx, ws);
    ws.send(JSON.stringify({ type: '_ready', idx: myIdx }));
    // 호스트에게 알림
    roomData.hostWs.send(JSON.stringify({ type: '_guestJoined', idx: myIdx }));
  }

  ws.on('message', (rawData) => {
    let msg;
    try { msg = JSON.parse(rawData); } catch { return; }
    if (!roomData) return;

    if (role === 'host') {
      // _to 있으면 특정 게스트에게만, 없으면 전체 브로드캐스트
      const target = msg._to;
      if (target !== undefined) {
        const gws = roomData.guests.get(Number(target));
        if (gws && gws.readyState === WebSocket.OPEN) gws.send(rawData.toString());
      } else {
        roomData.guests.forEach(gws => {
          if (gws.readyState === WebSocket.OPEN) gws.send(rawData.toString());
        });
      }
    } else {
      // 게스트 → 호스트 (서버가 _from 추가)
      if (roomData.hostWs && roomData.hostWs.readyState === WebSocket.OPEN) {
        const fwd = Object.assign({}, msg, { _from: myIdx });
        roomData.hostWs.send(JSON.stringify(fwd));
      }
    }
  });

  ws.on('close', () => {
    if (!roomData) return;
    if (role === 'host') {
      // 호스트 떠남 → 모든 게스트에게 알림
      roomData.guests.forEach(gws => {
        if (gws.readyState === WebSocket.OPEN)
          gws.send(JSON.stringify({ type: '_hostLeft' }));
      });
      gameRooms.delete(room);
      openRooms.delete(room);
    } else {
      // 게스트 떠남 → 호스트에게 알림
      roomData.guests.delete(myIdx);
      if (roomData.hostWs && roomData.hostWs.readyState === WebSocket.OPEN)
        roomData.hostWs.send(JSON.stringify({ type: '_guestLeft', idx: myIdx }));
    }
  });

  ws.on('error', () => {});
});

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

  // ── 열린 방 목록 API ────────────────────────────────────────
  if (urlPath === '/api/rooms') {
    if (req.method === 'GET') {
      const now = Date.now();
      for (const [code, r] of openRooms) {
        if (now - r.ts > 300000) openRooms.delete(code); // 5분 만료
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.from(openRooms.values()).slice(0, 20)));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const { roomCode, emoji, name, count, max } = JSON.parse(body);
          if (roomCode) openRooms.set(roomCode, { code: roomCode, emoji, name, count, max, ts: Date.now() });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch { res.writeHead(400); res.end('error'); }
      });
      return;
    }
    res.writeHead(405); res.end(); return;
  }

  // ── 빠른 매칭 API ────────────────────────────────────────────
  if (urlPath === '/api/match') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const { roomCode, action } = JSON.parse(body);
          if (action === 'cancel') {
            if (matchQueue && matchQueue.roomCode === roomCode) clearMatch();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (matchQueue && Date.now() - matchQueue.ts < 60000) {
            const connectTo = matchQueue.roomCode;
            clearMatch();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ matched: true, connectTo }));
          } else {
            clearMatch();
            matchQueue = { roomCode, ts: Date.now() };
            matchTimer = setTimeout(clearMatch, 60000);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ matched: false, waiting: true }));
          }
        } catch (e) {
          res.writeHead(400); res.end('error');
        }
      });
      return;
    }
  }

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

// ── WebSocket 업그레이드 처리 ───────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`\n🧪  물 색깔 대결!  서버 실행 중`);
  console.log(`    http://localhost:${PORT}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌  포트 ${PORT} 가 이미 사용 중이에요.`);
  } else {
    console.error('서버 오류:', err.message);
  }
  process.exit(1);
});
