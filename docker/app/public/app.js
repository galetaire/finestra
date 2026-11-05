'use strict';

// Finestra explorer UI. Talks only to this app's own /api, which forwards to
// Bob's read-only node proxy. All data is read-only.

const view = document.getElementById('view');
const nodeChip = document.getElementById('node-chip');
const DOOS = 1e6; // 1 HNS = 1,000,000 dollarydoos

// ---- api -------------------------------------------------------------------

// hsd reports errors as {message, ...} objects; our servers use plain strings.
function errorText(data, fallback) {
  const err = data && data.error;
  if (!err) return fallback;
  if (typeof err === 'string') return data.detail ? `${err}: ${data.detail}` : err;
  return err.message || fallback;
}

async function rpc(method, params = []) {
  const r = await fetch('/api/rpc', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({method, params}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(errorText(data, `RPC ${method} failed (${r.status})`));
  return data.result !== undefined ? data.result : data;
}

async function rest(pathname) {
  const r = await fetch(`/api/rest/${pathname}`);
  if (r.status === 404) return null;
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(errorText(data, `REST ${pathname} failed (${r.status})`));
  return data;
}

const isSpvError = e => /spv mode/i.test(String(e && e.message));
const SPV_NOTICE = 'Your Bob node is in SPV mode, so it does not store blocks, ' +
  'transactions or address history. Name lookups still work. Switch Bob to ' +
  'full-node mode and let it sync to use the rest of Finestra.';
const notice = text => `<div class="error">${esc(text)}</div>`;

// ---- helpers ---------------------------------------------------------------

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => (
  {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

const hns = doos => (Number(doos || 0) / DOOS).toLocaleString(undefined, {maximumFractionDigits: 6}) + ' HNS';
const num = n => Number(n || 0).toLocaleString();
const shorten = (s, n = 10) => !s ? '' : (s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`);
const when = t => t ? new Date(t * 1000).toLocaleString() : '—';
const link = (href, text, cls) => `<a href="${href}"${cls ? ` class="${cls}"` : ''}>${esc(text)}</a>`;

function kv(pairs) {
  return `<div class="panel"><div class="kv">${
    pairs.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${v}</div>`).join('')
  }</div></div>`;
}

function json(obj) {
  return `<pre class="json">${esc(JSON.stringify(obj, null, 2))}</pre>`;
}

function setView(html) { view.innerHTML = html; window.scrollTo(0, 0); }
function showError(msg) { setView(`<div class="error">${esc(msg)}</div>`); }
function loading(label) { setView(`<div class="loading">${esc(label || 'Loading…')}</div>`); }

// ---- node status chip ------------------------------------------------------

async function refreshNodeChip() {
  try {
    const info = await rpc('getblockchaininfo');
    const syncing = info.verificationprogress != null && info.verificationprogress < 0.9999;
    nodeChip.className = 'chip ok';
    nodeChip.textContent = syncing
      ? `syncing ${(info.verificationprogress * 100).toFixed(2)}% · ${num(info.blocks)}`
      : `synced · height ${num(info.blocks)}`;
    nodeChip.title = `chain: ${info.chain || 'main'}`;
  } catch (e) {
    nodeChip.className = 'chip bad';
    nodeChip.textContent = 'node unreachable';
    nodeChip.title = String(e.message || e);
  }
}

// ---- search classification -------------------------------------------------

function classify(q) {
  const s = q.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return {type: 'block', id: s};
  if (/^[0-9a-fA-F]{64}$/.test(s)) return {type: 'hash', id: s.toLowerCase()};
  if (/^(hs|ts|rs|ss)1[0-9ac-hj-np-z]{10,}$/i.test(s)) return {type: 'address', id: s};
  return {type: 'name', id: s.toLowerCase()};
}

function go(q) {
  const c = classify(q);
  if (!c) return;
  if (c.type === 'block') location.hash = `#/block/${c.id}`;
  else if (c.type === 'address') location.hash = `#/address/${c.id}`;
  else if (c.type === 'name') location.hash = `#/name/${encodeURIComponent(c.id)}`;
  else location.hash = `#/search/${c.id}`; // 64-hex: resolve tx-or-block
}

// ---- views -----------------------------------------------------------------

async function viewHome() {
  loading('Loading chain…');
  const info = await rpc('getblockchaininfo');
  const height = info.blocks;
  const want = 10;
  const heights = [];
  for (let h = height; h > Math.max(-1, height - want); h--) heights.push(h);
  let spv = false;
  const blocks = await Promise.all(heights.map(h => rest(`block/${h}`).catch(e => {
    if (isSpvError(e)) spv = true;
    return null;
  })));

  const stats = `<div class="grid">
    ${stat('Chain', esc(info.chain || 'main'))}
    ${stat('Height', num(info.blocks))}
    ${stat('Progress', info.verificationprogress != null ? (info.verificationprogress * 100).toFixed(2) + '%' : '—')}
    ${stat('Difficulty', info.difficulty != null ? num(Math.round(info.difficulty)) : '—')}
  </div>`;

  const rows = blocks.filter(Boolean).map(b => `<tr>
    <td>${link(`#/block/${b.height}`, num(b.height))}</td>
    <td class="mono">${link(`#/block/${b.hash}`, shorten(b.hash, 8))}</td>
    <td>${when(b.time)}</td>
    <td class="right">${num((b.txs || []).length)}</td>
  </tr>`).join('');

  setView(`<h1 class="page-title">Handshake explorer</h1>${spv ? notice(SPV_NOTICE) : ''}${stats}
    <h2>Latest blocks</h2>
    <div class="panel"><table>
      <thead><tr><th>Height</th><th>Hash</th><th>Time</th><th class="right">Txs</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">No blocks yet.</td></tr>'}</tbody>
    </table></div>
    <p class="hint">Search a name (e.g. <code>welcome</code>), a block height or hash, a txid, or an <code>hs1…</code> address.</p>`);
}

function stat(label, value) {
  return `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${value}</div></div>`;
}

async function viewName(name) {
  loading(`Looking up “${name}”…`);
  let info, resource;
  try { info = await rpc('getnameinfo', [name]); }
  catch (e) { return showError(`Could not look up name: ${e.message}`); }
  try { resource = await rpc('getnameresource', [name]); } catch (e) { resource = null; }

  const ni = (info && info.info) || null;
  const state = ni && ni.state ? ni.state : 'UNREGISTERED';
  const pairs = [
    ['Name', `<strong>${esc(name)}</strong>`],
    ['State', `<span class="badge ${esc(state)}">${esc(state)}</span>`],
  ];
  if (ni) {
    if (ni.height != null) pairs.push(['Auction open height', link(`#/block/${ni.height}`, num(ni.height))]);
    if (ni.highest != null) pairs.push(['Highest bid', hns(ni.highest)]);
    if (ni.value != null) pairs.push(['Paid / value', hns(ni.value)]);
    if (ni.owner && ni.owner.hash) pairs.push(['Owner outpoint', `<span class="mono">${esc(shorten(ni.owner.hash, 8))}/${ni.owner.index}</span>`]);
    if (ni.renewal != null) pairs.push(['Last renewal height', num(ni.renewal)]);
    if (ni.expired != null) pairs.push(['Expired', ni.expired ? 'yes' : 'no']);
    if (ni.registered != null) pairs.push(['Registered', ni.registered ? 'yes' : 'no']);
    if (ni.weak != null) pairs.push(['Weak (reserved)', ni.weak ? 'yes' : 'no']);
  }

  let records = '<p class="muted">No DNS records published.</p>';
  if (resource && Array.isArray(resource.records) && resource.records.length) {
    const detail = r => {
      if (r.type === 'DS') return `${r.keyTag} ${r.algorithm} ${r.digestType} ${r.digest}`;
      if (r.type === 'TXT') return `"${(r.txt || []).join(' ')}"`;
      return [r.ns, r.address].filter(Boolean).join(' ');
    };
    records = `<ul class="records mono">${resource.records.map(r =>
      `<li>${esc(r.type)} ${esc(detail(r))}</li>`).join('')}</ul>`;
  }

  setView(`<h1 class="page-title">${esc(name)}<span class="pill">  ·  name</span></h1>
    ${kv(pairs)}
    <h2>DNS records</h2>${records}
    <h2>Auction detail</h2>${json(info)}
    ${resource ? `<h2>Resource</h2>${json(resource)}` : ''}`);
}

async function viewBlock(id) {
  loading('Loading block…');
  const b = await rest(`block/${id}`);
  if (!b) return showError(`Block not found: ${id}`);
  const txs = b.txs || [];
  const pairs = [
    ['Height', num(b.height)],
    ['Hash', `<span class="mono">${esc(b.hash)}</span>`],
    ['Time', when(b.time)],
    ['Transactions', num(txs.length)],
    ['Previous', b.prevBlock ? link(`#/block/${b.prevBlock}`, shorten(b.prevBlock, 10)) : '—'],
    ['Merkle root', `<span class="mono">${esc(shorten(b.merkleRoot, 12))}</span>`],
    ['Version', num(b.version)],
    ['Bits', esc(b.bits)],
    ['Nonce', num(b.nonce)],
  ];
  const rows = txs.slice(0, 200).map((tx, i) => {
    const hash = typeof tx === 'string' ? tx : tx.hash;
    return `<tr><td class="right muted">${i}</td><td class="mono">${link(`#/tx/${hash}`, shorten(hash, 12))}</td></tr>`;
  }).join('');
  setView(`<h1 class="page-title">Block ${num(b.height)}<span class="pill">  ·  block</span></h1>
    ${kv(pairs)}
    <h2>Transactions${txs.length > 200 ? ' (first 200)' : ''}</h2>
    <div class="panel"><table><tbody>${rows || '<tr><td class="muted">None.</td></tr>'}</tbody></table></div>`);
}

function covenant(c) {
  if (!c || c.action == null) return '';
  const action = typeof c.action === 'string' ? c.action : `type ${c.type}`;
  return action && action !== 'NONE' ? `<span class="badge ${esc(action)}">${esc(action)}</span> ` : '';
}

async function viewTx(hash) {
  loading('Loading transaction…');
  const tx = await rest(`tx/${hash}`);
  if (!tx) return showError(`Transaction not found: ${hash}`);
  const pairs = [
    ['Hash', `<span class="mono">${esc(tx.hash)}</span>`],
    ['Block', tx.height != null && tx.height >= 0 ? link(`#/block/${tx.height}`, num(tx.height)) : 'unconfirmed'],
    ['Time', when(tx.time || tx.mtime)],
    ['Inputs', num((tx.inputs || []).length)],
    ['Outputs', num((tx.outputs || []).length)],
  ];
  const outRows = (tx.outputs || []).map((o, i) => `<tr>
    <td class="right muted">${i}</td>
    <td>${covenant(o.covenant)}${o.address ? link(`#/address/${o.address}`, shorten(o.address, 10), 'mono') : '<span class="muted">—</span>'}</td>
    <td class="right mono">${hns(o.value)}</td>
  </tr>`).join('');
  const inRows = (tx.inputs || []).map((inp, i) => {
    const a = inp.coin && inp.coin.address;
    const v = inp.coin && inp.coin.value;
    return `<tr>
      <td class="right muted">${i}</td>
      <td>${a ? link(`#/address/${a}`, shorten(a, 10), 'mono') : '<span class="muted">coinbase / unknown</span>'}</td>
      <td class="right mono">${v != null ? hns(v) : '—'}</td>
    </tr>`;
  }).join('');
  setView(`<h1 class="page-title">Transaction<span class="pill">  ·  tx</span></h1>
    ${kv(pairs)}
    <h2>Inputs</h2><div class="panel"><table>
      <thead><tr><th class="right">#</th><th>Address</th><th class="right">Value</th></tr></thead>
      <tbody>${inRows || '<tr><td colspan="3" class="muted">None.</td></tr>'}</tbody></table></div>
    <h2>Outputs</h2><div class="panel"><table>
      <thead><tr><th class="right">#</th><th>Address / covenant</th><th class="right">Value</th></tr></thead>
      <tbody>${outRows || '<tr><td colspan="3" class="muted">None.</td></tr>'}</tbody></table></div>`);
}

async function viewAddress(addr) {
  loading('Loading address…');
  let txs, coins;
  try {
    [txs, coins] = await Promise.all([rest(`tx/address/${addr}`), rest(`coin/address/${addr}`)]);
  } catch (e) {
    if (isSpvError(e)) return showError(SPV_NOTICE);
    if (/too large|timed out|aborted/i.test(e.message)) {
      return showError('This address has too much history for the node to return in one request.');
    }
    return showError(`Could not load address: ${e.message}`);
  }
  txs = Array.isArray(txs) ? txs : [];
  coins = Array.isArray(coins) ? coins : [];
  const balance = coins.reduce((s, c) => s + Number(c.value || 0), 0);

  const pairs = [
    ['Address', `<span class="mono">${esc(addr)}</span>`],
    ['Balance (unspent)', hns(balance)],
    ['Unspent outputs', num(coins.length)],
    ['Transactions seen', num(txs.length)],
  ];
  // Newest first; unconfirmed transactions have height -1 and go on top.
  const rank = tx => (tx.height == null || tx.height < 0 ? Infinity : tx.height);
  const newest = [...txs].sort((a, b) => (rank(b) === rank(a) ? 0 : rank(b) > rank(a) ? 1 : -1));
  const rows = newest.slice(0, 200).map(tx => `<tr>
    <td class="mono">${link(`#/tx/${tx.hash}`, shorten(tx.hash, 12))}</td>
    <td>${tx.height != null && tx.height >= 0 ? link(`#/block/${tx.height}`, num(tx.height)) : 'unconfirmed'}</td>
    <td>${when(tx.time || tx.mtime)}</td>
  </tr>`).join('');

  setView(`<h1 class="page-title">Address<span class="pill">  ·  address</span></h1>
    ${kv(pairs)}
    <p class="hint">Balance and history come from hsd's address index, which your Bob node keeps enabled.</p>
    <h2>Transactions${txs.length > 200 ? ' (newest 200)' : ''}</h2>
    <div class="panel"><table>
      <thead><tr><th>Txid</th><th>Block</th><th>Time</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3" class="muted">No transactions for this address.</td></tr>'}</tbody>
    </table></div>`);
}

// A 64-hex value: resolve to a tx, else a block.
async function viewSearchHash(hash) {
  loading('Resolving…');
  const tx = await rest(`tx/${hash}`);
  if (tx) { location.hash = `#/tx/${hash}`; return; }
  const block = await rest(`block/${hash}`);
  if (block) { location.hash = `#/block/${hash}`; return; }
  showError(`Nothing found for ${hash} (not a known transaction or block).`);
}

// ---- router ----------------------------------------------------------------

async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [kind, ...rest] = hash.split('/');
  const arg = decodeURIComponent(rest.join('/') || '');
  try {
    switch (kind) {
      case '': case undefined: return await viewHome();
      case 'name': return await viewName(arg);
      case 'block': return await viewBlock(arg);
      case 'tx': return await viewTx(arg);
      case 'address': return await viewAddress(arg);
      case 'search': return await viewSearchHash(arg);
      default: return await viewHome();
    }
  } catch (e) {
    showError(isSpvError(e) ? SPV_NOTICE : String(e && e.message || e));
  }
}

document.getElementById('search-form').addEventListener('submit', e => {
  e.preventDefault();
  const input = document.getElementById('search-input');
  go(input.value);
  input.blur();
});

window.addEventListener('hashchange', route);
route();
refreshNodeChip();
setInterval(refreshNodeChip, 15000);
