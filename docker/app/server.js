'use strict';

// Finestra — a read-only Handshake explorer that reads its data from the Bob
// DNS Umbrel app's node, over Bob's scoped read-only node proxy.
//
// This server does two things:
//   1. serves the static explorer UI from ./public;
//   2. forwards /api/rpc and /api/rest/* to Bob's proxy
//      (BOB_NODE_PROXY_URL, default http://bob-wallet_server_1:3100).
//
// Bob's proxy enforces the real security boundary (read-only, node-only,
// source-restricted). We mirror its allow-list here so obviously-wrong calls
// fail fast with a clear message instead of a 403 from Bob.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const BOB_PROXY = (process.env.BOB_NODE_PROXY_URL || 'http://bob-wallet_server_1:3100').replace(/\/+$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Mirrors docker/web/node-proxy.js in the bob-umbrel repo.
const ALLOWED_RPC = new Set([
  'getinfo', 'getblockchaininfo', 'getnetworkinfo', 'getmininginfo',
  'getblockcount', 'getbestblockhash', 'getdifficulty', 'getconnectioncount',
  'getnetworkhashps', 'uptime',
  'getblock', 'getblockbyheight', 'getblockheader', 'getblockhash',
  'getchaintips', 'getentropy',
  'getrawtransaction', 'gettxout', 'gettxoutproof', 'verifytxoutproof',
  'decoderawtransaction', 'decodescript',
  'getmempoolinfo', 'getrawmempool', 'getmempoolentry', 'estimatefee',
  'estimatesmartfee', 'estimatepriority',
  'getnameinfo', 'getnameresource', 'getnamebyhash', 'getnames',
  'getnameproof', 'getdnssecproof',
  'validateaddress',
]);

const ALLOWED_REST = [
  /^$/, /^block\/[^/]+$/, /^header\/[^/]+$/, /^tx\/[0-9a-fA-F]{64}$/,
  /^tx\/address\/[^/]+$/, /^coin\/[0-9a-fA-F]{64}\/\d+$/,
  /^coin\/address\/[^/]+$/, /^mempool$/, /^fee$/,
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyFetch(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const r = await fetch(url, {...init, signal: controller.signal});
    const text = await r.text();
    return {status: r.status, text};
  } finally {
    clearTimeout(timer);
  }
}

function serveStatic(res, pathname) {
  // Default to index.html; the UI is a single page with client-side routing.
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    return sendJson(res, 403, {error: 'Forbidden'});
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Unknown path -> hand back index.html so the SPA can route it.
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) return sendJson(res, 404, {error: 'Not found'});
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        res.end(html);
      });
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type': type});
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api/health') {
      const r = await proxyFetch(`${BOB_PROXY}/health`, {method: 'GET'}).catch(() => null);
      return sendJson(res, 200, {
        explorer: 'ready',
        node: r && r.status === 200 ? JSON.parse(r.text).status : 'unreachable',
      });
    }

    // JSON-RPC: POST /api/rpc {method, params}
    if (pathname === '/api/rpc' && req.method === 'POST') {
      let payload;
      try { payload = JSON.parse((await readBody(req)).toString() || '{}'); }
      catch (e) { return sendJson(res, 400, {error: 'Invalid JSON body'}); }
      const method = payload && payload.method;
      if (typeof method !== 'string' || !ALLOWED_RPC.has(method)) {
        return sendJson(res, 403, {error: `Method not allowed: ${method}`});
      }
      const r = await proxyFetch(`${BOB_PROXY}/rpc`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({method, params: Array.isArray(payload.params) ? payload.params : []}),
      });
      res.writeHead(r.status, {'Content-Type': 'application/json; charset=utf-8'});
      return res.end(r.text);
    }

    // REST passthrough: GET /api/rest/<whitelisted>
    if (pathname.startsWith('/api/rest/') && req.method === 'GET') {
      const rest = pathname.slice('/api/rest/'.length).replace(/\/+$/, '');
      if (!ALLOWED_REST.some(re => re.test(rest))) {
        return sendJson(res, 403, {error: `Path not allowed: /${rest}`});
      }
      const r = await proxyFetch(`${BOB_PROXY}/rest/${rest}${url.search || ''}`, {method: 'GET'});
      res.writeHead(r.status, {'Content-Type': 'application/json; charset=utf-8'});
      return res.end(r.text);
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, pathname);
    return sendJson(res, 405, {error: 'Method not allowed'});
  } catch (e) {
    return sendJson(res, 502, {error: 'Explorer error', detail: String(e && e.message || e)});
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Finestra] Explorer on 0.0.0.0:${PORT}, reading node at ${BOB_PROXY}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { console.log(`[Finestra] ${sig} received, exiting.`); server.close(() => process.exit(0)); });
}
