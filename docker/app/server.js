'use strict';

// Finestra — a read-only Handshake explorer that reads its data from the Bob
// DNS Umbrel app's node, over Bob's scoped read-only node proxy.
//
// This server does three things:
//   1. serves the static explorer UI from ./public;
//   2. forwards /api/rpc and /api/rest/* to Bob's proxy
//      (BOB_NODE_PROXY_URL, default http://bob-wallet_server_1:3100);
//   3. gathers and caches the data for the dashboard, blocks and mempool pages.
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
  'getnetworkhashps',
  'getblock', 'getblockbyheight', 'getblockheader', 'getblockhash',
  'getchaintips',
  'getrawtransaction', 'gettxout', 'gettxoutproof', 'verifytxoutproof',
  'decoderawtransaction', 'decodescript',
  'getmempoolinfo', 'getrawmempool', 'getmempoolentry', 'estimatefee',
  'estimatesmartfee', 'estimatepriority',
  'getnameinfo', 'getnameresource', 'getnamebyhash',
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

// ---- node data for the dashboard, blocks and mempool pages ------------------
//
// These pages combine many node calls. Doing that here lets the results be
// cached, so opening the explorer doesn't send the same requests to the node
// that the wallet depends on.

async function nodeRpc(method, params = []) {
  const r = await proxyFetch(`${BOB_PROXY}/rpc`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({method, params}),
  });
  const data = JSON.parse(r.text || '{}');
  if (data.error) throw new Error(data.error.message || data.error);
  return data.result;
}

async function nodeRest(rest) {
  const r = await proxyFetch(`${BOB_PROXY}/rest/${rest}`, {method: 'GET'});
  if (r.status === 404) return null;
  const data = JSON.parse(r.text || 'null');
  if (r.status !== 200) throw new Error((data && data.error && data.error.message) || data.error || `Node returned ${r.status}`);
  return data;
}

const LATEST_BLOCKS = 10;
const PAGE_BLOCKS = 25;
const ACTIVITY_ITEMS = 30;
const ACTIVITY_BLOCKS = 36;
const CACHE_LIMIT = 2000;
// Blocks this deep are treated as final, so they can stay cached.
const CACHE_DEPTH = 12;
const TREE_INTERVAL = {main: 36, regtest: 5};
// These covenants carry the plain name, so no lookup is needed.
const COVENANTS_WITH_NAME = new Set(['CLAIM', 'OPEN', 'BID']);

const blockCache = new Map();
const nameCache = new Map();

function remember(map, key, value) {
  if (map.size >= CACHE_LIMIT) map.delete(map.keys().next().value);
  map.set(key, value);
}

function summarize(block, size) {
  const covenants = {};
  const activity = [];
  let fees = 0;
  let inputs = 0;
  let outputs = 0;
  for (const tx of block.txs) {
    fees += tx.fee || 0;
    inputs += tx.inputs.length;
    outputs += tx.outputs.length;
    for (const out of tx.outputs) {
      const action = out.covenant && out.covenant.action;
      if (!action || action === 'NONE') continue;
      covenants[action] = (covenants[action] || 0) + 1;
      if (action !== 'REDEEM' && activity.length < ACTIVITY_ITEMS) {
        const raw = COVENANTS_WITH_NAME.has(action) ? out.covenant.items[2] : null;
        activity.push({
          action,
          tx: tx.hash,
          value: out.value,
          nameHash: out.covenant.items[0],
          name: raw ? Buffer.from(raw, 'hex').toString('latin1') : null,
        });
      }
    }
  }
  const coinbase = block.txs[0];
  return {
    hash: block.hash,
    height: block.height,
    time: block.time,
    size,
    txs: block.txs.length,
    inputs,
    outputs,
    fees,
    reward: coinbase ? coinbase.outputs[0].value : 0,
    miner: coinbase ? coinbase.outputs[0].address : null,
    covenants,
    activity,
  };
}

async function blockSummary(height, tip) {
  const cached = blockCache.get(height);
  if (cached) return cached;
  const [block, stats] = await Promise.all([
    nodeRest(`block/${height}`),
    nodeRpc('getblockbyheight', [height, true, false]),
  ]);
  if (!block) return null;
  const summary = summarize(block, stats ? stats.size : null);
  if (tip - height >= CACHE_DEPTH) remember(blockCache, height, summary);
  return summary;
}

async function blockSummaries(heights, tip) {
  const results = [];
  // A few at a time: full blocks can be large.
  for (let i = 0; i < heights.length; i += 3) {
    results.push(...await Promise.all(heights.slice(i, i + 3).map(h => blockSummary(h, tip))));
  }
  return results.filter(Boolean);
}

async function nameOf(item) {
  if (item.name) return item.name;
  if (nameCache.has(item.nameHash)) return nameCache.get(item.nameHash);
  const name = await nodeRpc('getnamebyhash', [item.nameHash]).catch(() => null);
  if (name) remember(nameCache, item.nameHash, name);
  return name;
}

// Name events from the newest blocks. Stops once it has enough, so busy blocks
// cost one or two block reads and quiet periods cost at most ACTIVITY_BLOCKS.
async function recentActivity(tip, known) {
  const items = [];
  for (let height = tip; height > tip - ACTIVITY_BLOCKS && height > 0; height--) {
    const block = known.find(b => b.height === height) || await blockSummary(height, tip);
    if (!block) continue;
    for (const item of block.activity) items.push({...item, height: block.height, time: block.time});
    if (items.length >= ACTIVITY_ITEMS) break;
  }
  const newest = items.slice(0, ACTIVITY_ITEMS);
  return Promise.all(newest.map(async item => ({...item, name: await nameOf(item)})));
}

const average = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

let overviewCache = null;

async function overview() {
  const info = await nodeRest('');
  const tip = info.chain.height;
  const [chain, mining, connections, mempool, network] = await Promise.all([
    nodeRpc('getblockchaininfo'),
    nodeRpc('getmininginfo').catch(() => null),
    nodeRpc('getconnectioncount').catch(() => null),
    nodeRpc('getmempoolinfo').catch(() => null),
    nodeRpc('getnetworkinfo').catch(() => null),
  ]);
  const live = {
    network: info.network,
    version: info.version,
    height: tip,
    progress: info.chain.progress,
    state: info.chain.state,
    difficulty: chain.difficulty,
    hashrate: mining ? mining.networkhashps : null,
    connections,
    peersAgent: network ? network.subversion : null,
    mempool: {
      txs: mempool ? mempool.size : info.mempool.tx,
      bytes: mempool ? mempool.bytes : info.mempool.size,
      claims: info.mempool.claims,
      airdrops: info.mempool.airdrops,
    },
  };
  const interval = TREE_INTERVAL[info.network] || TREE_INTERVAL.main;
  live.nextTree = {height: tip + interval - (tip % interval), blocks: interval - (tip % interval)};

  if (overviewCache && overviewCache.tip === info.chain.tip) return {...live, ...overviewCache.data};

  let data;
  try {
    const heights = [];
    for (let h = tip; h > Math.max(-1, tip - LATEST_BLOCKS); h--) heights.push(h);
    const blocks = await blockSummaries(heights, tip);
    const gaps = blocks.slice(0, -1).map((b, i) => b.time - blocks[i + 1].time);
    data = {
      spv: false,
      blocks: blocks.map(({activity, ...b}) => b),
      activity: await recentActivity(tip, blocks),
      blockTime: average(gaps),
    };
  } catch (e) {
    if (!/spv mode/i.test(e.message)) throw e;
    data = {spv: true, blocks: [], activity: [], blockTime: null};
  }
  overviewCache = {tip: info.chain.tip, data};
  return {...live, ...data};
}

async function blockPage(from) {
  const tip = (await nodeRest('')).chain.height;
  const start = Math.min(Number.isInteger(from) && from >= 0 ? from : tip, tip);
  const heights = [];
  for (let h = start; h > Math.max(-1, start - PAGE_BLOCKS); h--) heights.push(h);
  const blocks = await blockSummaries(heights, tip);
  return {tip, start, pageSize: PAGE_BLOCKS, blocks: blocks.map(({activity, ...b}) => b)};
}

async function mempoolPage() {
  const [info, entries, fee] = await Promise.all([
    nodeRpc('getmempoolinfo'),
    nodeRpc('getrawmempool', [true]),
    nodeRest('fee').catch(() => null),
  ]);
  const txs = Object.entries(entries)
    .map(([hash, tx]) => ({hash, size: tx.size, fee: tx.fee, time: tx.time}))
    .sort((a, b) => b.time - a.time);
  return {info, feeRate: fee ? fee.rate : null, total: txs.length, txs: txs.slice(0, 100)};
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

    if (req.method === 'GET' && pathname === '/api/overview') return sendJson(res, 200, await overview());
    if (req.method === 'GET' && pathname === '/api/mempool') return sendJson(res, 200, await mempoolPage());
    if (req.method === 'GET' && pathname === '/api/blocks') {
      const from = url.searchParams.get('from');
      return sendJson(res, 200, await blockPage(from === null ? undefined : Number(from)));
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
