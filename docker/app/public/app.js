'use strict';

// Finestra explorer UI. Talks only to this app's own /api, which reads from
// Bob's read-only node proxy. All data is read-only.

const view = document.getElementById('view');
const nodeChip = document.getElementById('node-chip');
const DOOS = 1e6; // 1 HNS = 1,000,000 dollarydoos
const REFRESH_MS = 20000;

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

async function api(pathname) {
  const r = await fetch(`/api/${pathname}`);
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(errorText(data, `Request failed (${r.status})`));
  return data;
}

const isSpvError = e => /spv mode|no mempool available/i.test(String(e && e.message));
const SPV_NOTICE = 'Your Bob node is in SPV mode, so it does not store blocks, ' +
  'transactions or address history. Name lookups work once it has finished ' +
  'syncing. Switch Bob to full-node mode and let it sync to use the rest of Finestra.';
const SPV_SYNCING = 'Your Bob node is in SPV mode and still syncing. It can only ' +
  'look up names once it has finished, so this name\'s status is not known yet.';
const notice = text => `<div class="notice">${esc(text)}</div>`;

// hsd's normal name lookups always come back empty in SPV mode, which would make
// every registered name look unregistered. Its "safe" option asks peers instead.
async function nodeIsSpv() {
  try {
    await rest('block/0');
    return false;
  } catch (e) {
    return isSpvError(e);
  }
}

// ---- formatting ------------------------------------------------------------

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => (
  {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

// ---- punycode (RFC 3492) ---------------------------------------------------
//
// Handshake names are plain ASCII, so emoji and other Unicode names are stored
// in their "xn--" encoded form.

const PUNY = {base: 36, tMin: 1, tMax: 26, skew: 38, damp: 700, bias: 72, first: 128};

function punyAdapt(delta, points, firstTime) {
  let d = firstTime ? Math.floor(delta / PUNY.damp) : delta >> 1;
  d += Math.floor(d / points);
  let k = 0;
  while (d > ((PUNY.base - PUNY.tMin) * PUNY.tMax) >> 1) {
    d = Math.floor(d / (PUNY.base - PUNY.tMin));
    k += PUNY.base;
  }
  return k + Math.floor(((PUNY.base - PUNY.tMin + 1) * d) / (d + PUNY.skew));
}

const punyThreshold = (k, bias) => (
  k <= bias ? PUNY.tMin : k >= bias + PUNY.tMax ? PUNY.tMax : k - bias);

function punyDecode(input) {
  const output = [];
  const split = input.lastIndexOf('-');
  for (let i = 0; i < Math.max(split, 0); i++) {
    if (input.charCodeAt(i) >= 128) throw new Error('Not ASCII');
    output.push(input.charCodeAt(i));
  }
  let n = PUNY.first;
  let i = 0;
  let bias = PUNY.bias;
  let pos = split > 0 ? split + 1 : 0;
  while (pos < input.length) {
    const oldI = i;
    let w = 1;
    for (let k = PUNY.base; ; k += PUNY.base) {
      if (pos >= input.length) throw new Error('Truncated');
      const c = input.charCodeAt(pos++);
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 97 && c <= 122 ? c - 97 : c >= 65 && c <= 90 ? c - 65 : PUNY.base;
      if (digit >= PUNY.base) throw new Error('Bad digit');
      i += digit * w;
      const t = punyThreshold(k, bias);
      if (digit < t) break;
      w *= PUNY.base - t;
    }
    const count = output.length + 1;
    bias = punyAdapt(i - oldI, count, oldI === 0);
    n += Math.floor(i / count);
    i %= count;
    if (n > 0x10ffff) throw new Error('Out of range');
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

function punyEncode(input) {
  const points = Array.from(input, c => c.codePointAt(0));
  const basic = points.filter(p => p < 128);
  let output = String.fromCharCode(...basic);
  let handled = basic.length;
  if (handled) output += '-';
  let n = PUNY.first;
  let delta = 0;
  let bias = PUNY.bias;
  const encodeDigit = d => String.fromCharCode(d < 26 ? d + 97 : d + 22);
  while (handled < points.length) {
    const next = Math.min(...points.filter(p => p >= n));
    delta += (next - n) * (handled + 1);
    n = next;
    for (const p of points) {
      if (p < n) delta++;
      if (p !== n) continue;
      let q = delta;
      for (let k = PUNY.base; ; k += PUNY.base) {
        const t = punyThreshold(k, bias);
        if (q < t) break;
        output += encodeDigit(t + ((q - t) % (PUNY.base - t)));
        q = Math.floor((q - t) / (PUNY.base - t));
      }
      output += encodeDigit(q);
      bias = punyAdapt(delta, handled + 1, handled === basic.length);
      delta = 0;
      handled++;
    }
    delta++;
    n++;
  }
  return output;
}

// The Unicode form of an "xn--" name, or null if it doesn't have a valid one.
function unicodeName(name) {
  if (!/^xn--/i.test(name)) return null;
  try {
    const decoded = punyDecode(name.slice(4).toLowerCase());
    const real = /[^\x00-\x7f]/.test(decoded) && punyEncode(decoded) === name.slice(4).toLowerCase();
    // Joiners build emoji like families; other invisible or text-direction
    // characters would show nothing, or could disguise what a name says.
    const hidden = /[\p{C}\p{Z}]/u.test(decoded.replace(/[‌‍]/g, ''));
    return real && !hidden ? decoded : null;
  } catch (e) {
    return null;
  }
}

// What a typed name is stored as: emoji and other Unicode become "xn--" names.
function asciiName(name) {
  // Emoji pickers often add an invisible variation selector, as in "☕️".
  const lower = name.normalize('NFC').toLowerCase().replace(/[︀-️]/g, '');
  return /[^\x00-\x7f]/.test(lower) ? `xn--${punyEncode(lower)}` : lower;
}

// ---- formatting (continued) ------------------------------------------------

const hns = (doos, digits = 6) => (Number(doos || 0) / DOOS)
  .toLocaleString(undefined, {maximumFractionDigits: digits}) + ' HNS';
const num = n => Number(n || 0).toLocaleString();
const shorten = (s, n = 10) => !s ? '' : (s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`);
const when = t => t ? new Date(t * 1000).toLocaleString() : '—';
const link = (href, text, cls) => `<a href="${href}"${cls ? ` class="${cls}"` : ''}>${esc(text)}</a>`;
function displayName(name) {
  const unicode = unicodeName(name);
  return unicode ? `${name} (${unicode})` : name;
}
const nameLink = name => link(`#/name/${encodeURIComponent(name)}`, displayName(name));
const blockLink = height => link(`#/block/${height}`, num(height));
const txLink = (hash, n = 10) => link(`#/tx/${hash}`, shorten(hash, n), 'mono');
const addressLink = (address, n = 10) => link(`#/address/${address}`, shorten(address, n), 'mono');

function bytes(n) {
  if (n == null) return '—';
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(2)} kB`;
  return `${(n / 1e6).toFixed(2)} MB`;
}

function scaled(n, units) {
  if (n == null) return '—';
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toLocaleString(undefined, {maximumFractionDigits: 2})} ${units[unit]}`.trim();
}
const hashrate = n => scaled(n, ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s']);
const compact = n => scaled(n, ['', 'k', 'M', 'G', 'T', 'P']);

function ago(t) {
  if (!t) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - t));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const age = t => `<span data-age="${Number(t) || ''}" title="${esc(when(t))}">${esc(ago(t))}</span>`;

function duration(s) {
  if (s == null) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

const badge = text => `<span class="badge ${esc(text)}">${esc(text)}</span>`;

// ---- building blocks -------------------------------------------------------

function stat(label, value, sub, extra = '') {
  return `<div class="stat"><div class="label">${esc(label)}</div>
    <div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}${extra}</div>`;
}

function kv(pairs) {
  return `<div class="panel"><div class="kv">${
    pairs.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${v}</div>`).join('')
  }</div></div>`;
}

function table(head, rows, empty) {
  const cols = head.map(h => (h.startsWith('>')
    ? `<th class="right">${esc(h.slice(1))}</th>` : `<th>${esc(h)}</th>`)).join('');
  return `<div class="panel scroll"><table><thead><tr>${cols}</tr></thead><tbody>${
    rows.join('') || `<tr><td colspan="${head.length}" class="muted">${esc(empty)}</td></tr>`
  }</tbody></table></div>`;
}

const raw = (title, obj) => `<details class="raw"><summary>${esc(title)}</summary>
  <pre class="json">${esc(JSON.stringify(obj, null, 2))}</pre></details>`;

function setView(html, keepScroll) {
  view.innerHTML = html;
  if (!keepScroll) window.scrollTo(0, 0);
}
function showError(msg) { setView(`<div class="error">${esc(msg)}</div>`); }
function loading(label) { setView(`<div class="loading">${esc(label || 'Loading…')}</div>`); }

function blockRows(blocks) {
  return blocks.map(b => `<tr>
    <td>${blockLink(b.height)}</td>
    <td class="nowrap">${age(b.time)}</td>
    <td class="right">${num(b.txs)}</td>
    <td class="right hide-small">${num(b.inputs)}</td>
    <td class="right hide-small">${num(b.outputs)}</td>
    <td class="right nowrap">${bytes(b.size)}</td>
    <td class="right nowrap hide-small">${hns(b.fees, 2)}</td>
  </tr>`);
}
const BLOCK_HEAD = ['Height', 'Time', '>Txs', '>Inputs', '>Outputs', '>Size', '>Fees'];
function blockTable(blocks, empty) {
  return table(BLOCK_HEAD, blockRows(blocks), empty).replace(
    /<th class="right">(Inputs|Outputs|Fees)<\/th>/g, '<th class="right hide-small">$1</th>');
}

// ---- node status chip ------------------------------------------------------

async function refreshNodeChip() {
  try {
    const info = await rpc('getblockchaininfo');
    const syncing = info.verificationprogress != null && info.verificationprogress < 0.9999;
    nodeChip.className = 'chip ok';
    nodeChip.textContent = syncing
      ? `Syncing ${(info.verificationprogress * 100).toFixed(2)}% · ${num(info.blocks)}`
      : `Synced · ${num(info.blocks)}`;
    nodeChip.title = `Network: ${info.chain || 'main'}`;
  } catch (e) {
    nodeChip.className = 'chip bad';
    nodeChip.textContent = 'Node unreachable';
    nodeChip.title = String(e.message || e);
  }
}

// ---- search ----------------------------------------------------------------

function classify(q) {
  const s = q.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return {type: 'block', id: s};
  if (/^[0-9a-fA-F]{64}$/.test(s)) return {type: 'hash', id: s.toLowerCase()};
  if (/^(hs|ts|rs|ss)1[0-9ac-hj-np-z]{10,}$/i.test(s)) return {type: 'address', id: s};
  return {type: 'name', id: asciiName(s)};
}

function go(q) {
  const c = classify(q);
  if (!c) return;
  if (c.type === 'block') location.hash = `#/block/${c.id}`;
  else if (c.type === 'address') location.hash = `#/address/${c.id}`;
  else if (c.type === 'name') location.hash = `#/name/${encodeURIComponent(c.id)}`;
  else location.hash = `#/search/${c.id}`; // 64-hex: resolve tx-or-block
}

// ---- dashboard -------------------------------------------------------------

const isHome = () => !location.hash.replace(/^#\/?/, '');

async function viewHome(quiet) {
  if (!quiet) loading('Loading dashboard…');
  const o = await api('overview');
  if (!isHome()) return;

  const last = o.blocks[0];
  const syncing = o.progress < 0.9999;
  const overview = `<div class="grid">
    ${stat('Time since last block', last ? age(last.time).replace(/ ago/, '') : '—', last ? `Block ${num(last.height)}` : '')}
    ${stat('Mempool', o.spv ? '—' : `${num(o.mempool.txs)} <small>pending</small>`, o.spv ? 'Not available in SPV mode' : bytes(o.mempool.bytes))}
    ${stat('Hashrate', o.spv ? '—' : hashrate(o.hashrate), `Difficulty ${compact(o.difficulty)}`)}
    ${stat('Next tree update', `Block ${num(o.nextTree.height)}`,
      `In ${num(o.nextTree.blocks)} block${o.nextTree.blocks === 1 ? '' : 's'}${o.blockTime != null ? `, about ${duration(o.nextTree.blocks * o.blockTime)}` : ''}`)}
  </div>`;

  const issued = o.state.value + o.state.burned;
  const supply = o.spv ? '' : `<h2>Network</h2><div class="grid compact">
    ${stat('Blocks', num(o.height))}
    ${stat('Transactions', num(o.state.tx))}
    ${stat('Unspent outputs', num(o.state.coin))}
    ${stat('Supply', hns(o.state.value, 0))}
    ${stat('Issued', hns(issued, 0))}
    ${stat('Burned', hns(o.state.burned, 0))}
    ${stat('Peers', num(o.connections), `hsd ${esc(o.version)}`)}
    ${stat('Block time', o.blockTime != null ? duration(o.blockTime) : '—', 'Last 25 blocks')}
  </div>`;

  const activity = o.activity.map(a => `<tr>
    <td>${badge(a.action)}</td>
    <td class="name">${a.name ? nameLink(a.name) : txLink(a.tx, 6)}</td>
    <td class="right muted nowrap">${age(a.time)}</td>
  </tr>`);

  setView(`
    ${o.spv ? notice(SPV_NOTICE) : ''}
    ${syncing && !o.spv ? notice(`Your node is still syncing (${(o.progress * 100).toFixed(2)}%), so these numbers are behind the network.`) : ''}
    <h2>Overview</h2>
    ${overview}
    ${supply}
    <div class="columns">
      <div><h2>Latest blocks <a href="#/blocks">See more</a></h2>
        ${blockTable(o.blocks, o.spv ? 'Not available in SPV mode.' : 'No blocks yet.')}</div>
      <div><h2>Name activity</h2>
        <div class="activity">${table(['Action', 'Name', '>Time'], activity, 'No name activity in the latest blocks.')}</div></div>
    </div>`, quiet);
}

async function viewBlocks(from) {
  loading('Loading blocks…');
  const page = await api(`blocks${from ? `?from=${encodeURIComponent(from)}` : ''}`);
  const older = page.start - page.pageSize;
  const newer = Math.min(page.start + page.pageSize, page.tip);
  setView(`<h1 class="page-title">Blocks</h1>
    ${blockTable(page.blocks, 'No blocks found.')}
    <div class="pager">
      <span>${page.start < page.tip ? link(`#/blocks/${newer}`, '← Newer') : ''}</span>
      <span>${older >= 0 ? link(`#/blocks/${older}`, 'Older →') : ''}</span>
    </div>`);
}

async function viewMempool() {
  loading('Loading mempool…');
  const m = await api('mempool');
  const rows = m.txs.map(tx => `<tr>
    <td>${txLink(tx.hash)}</td>
    <td class="nowrap">${age(tx.time)}</td>
    <td class="right nowrap">${bytes(tx.size)}</td>
    <td class="right nowrap">${hns(tx.fee * DOOS)}</td>
  </tr>`);
  const used = m.info.maxmempool ? (m.info.usage / m.info.maxmempool) * 100 : 0;
  setView(`<h1 class="page-title">Mempool</h1>
    <div class="grid">
      ${stat('Pending transactions', num(m.info.size))}
      ${stat('Size', bytes(m.info.bytes))}
      ${stat('Memory used', `${used.toFixed(2)}%`, `of ${bytes(m.info.maxmempool)}`,
        `<div class="meter"><span style="width:${Math.min(used, 100)}%"></span></div>`)}
      ${stat('Minimum fee', `${m.info.mempoolminfee} <small>HNS/kB</small>`)}
    </div>
    <h2>Pending transactions${m.total > m.txs.length ? ` (newest ${m.txs.length} of ${num(m.total)})` : ''}</h2>
    ${table(['Transaction', 'Seen', '>Size', '>Fee'], rows, 'The mempool is empty.')}`);
}

// ---- auctions --------------------------------------------------------------

const BLOCK_SECONDS = 600;
const AUCTION_PAGE = 50;
const AUCTION_TABS = [
  ['opening', 'Opening', 'Bidding starts'],
  ['bidding', 'Bidding', 'Bidding ends'],
  ['reveal', 'Reveal', 'Reveal ends'],
];
const auctionView = {data: null, tab: 'bidding', key: 'end', dir: -1, type: 'any', page: 0};

function timeLeft(blocks) {
  const hours = (blocks * BLOCK_SECONDS) / 3600;
  if (hours < 1) return `~${Math.max(1, Math.round(hours * 60))} minutes left`;
  if (Math.round(hours) === 1) return '~1 hour left';
  if (hours < 48) return `~${Math.round(hours)} hours left`;
  return `~${Math.round(hours / 24)} days left`;
}

function nameLength(name) {
  const unicode = unicodeName(name);
  if (!unicode) return {sort: name.length, text: String(name.length)};
  const shown = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter().segment(unicode)].length : [...unicode].length;
  return {sort: shown, text: `${shown}/${name.length}`};
}

function sortButton(label, key, right) {
  const active = auctionView.key === key;
  const arrow = active ? (auctionView.dir > 0 ? ' ▲' : ' ▼') : '';
  return `<th${right ? ' class="right"' : ''}><button class="sort" data-sort="${key}"
    aria-sort="${active ? (auctionView.dir > 0 ? 'ascending' : 'descending') : 'none'}">${esc(label)}${arrow}</button></th>`;
}

function auctionRows(list, tab, tip) {
  return list.map(a => {
    const length = nameLength(a.name);
    const end = `<span class="nowrap">${esc(timeLeft(a.end - tip))}</span>
      <span class="muted nowrap">Block ${blockLink(a.end)}</span>`;
    const dash = '<span class="muted">—</span>';
    const money = n => (n ? `<span class="nowrap">${hns(n, 2)}</span>` : dash);
    const cells = [`<td class="nowrap">${nameLink(a.name)}</td>`, `<td class="right">${esc(length.text)}</td>`];
    if (tab !== 'opening') cells.push(`<td class="right">${num(a.bids)}</td>`);
    if (tab === 'reveal') {
      cells.push(`<td class="right">${num(a.reveals)}</td>`, `<td class="right">${money(a.highestBid)}</td>`);
    }
    if (tab !== 'opening') cells.push(`<td class="right">${money(a.highest)}</td>`);
    if (tab === 'bidding') cells.push(`<td class="right">${money(a.total)}</td>`);
    cells.push(`<td class="right">${end}</td>`);
    return `<tr>${cells.join('')}</tr>`;
  }).join('');
}

function renderAuctions(keepScroll) {
  const {data, tab, key, dir, type, page} = auctionView;
  const counts = Object.fromEntries(AUCTION_TABS.map(([id]) => [id, 0]));
  for (const a of data.auctions) counts[a.phase]++;

  const tabs = AUCTION_TABS.map(([id, label]) =>
    `<a class="tab${id === tab ? ' active' : ''}" href="#/names/${id}">${label} <span>${num(counts[id])}</span></a>`).join('');

  const matches = data.auctions
    .filter(a => a.phase === tab)
    .filter(a => type === 'any' || (type === 'idn') === Boolean(unicodeName(a.name)));
  const value = a => (key === 'name' ? a.name : key === 'length' ? nameLength(a.name).sort : a[key]);
  matches.sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    return (x < y ? -1 : x > y ? 1 : 0) * dir || b.height - a.height;
  });
  const pages = Math.max(1, Math.ceil(matches.length / AUCTION_PAGE));
  const current = Math.min(page, pages - 1);
  const shown = matches.slice(current * AUCTION_PAGE, (current + 1) * AUCTION_PAGE);

  const endLabel = AUCTION_TABS.find(([id]) => id === tab)[2];
  const heads = [sortButton('Name', 'name'), sortButton('Length', 'length', true)];
  if (tab !== 'opening') heads.push(sortButton('Bids', 'bids', true));
  if (tab === 'reveal') heads.push(sortButton('Revealed', 'reveals', true), sortButton('Highest bid', 'highestBid', true));
  if (tab !== 'opening') heads.push(sortButton('Highest lockup', 'highest', true));
  if (tab === 'bidding') heads.push(sortButton('Total lockup', 'total', true));
  heads.push(sortButton(endLabel, 'end', true));

  const progress = data.finished ? '' : `<div class="stat scan">
    <div class="label">Reading recent blocks for auctions</div>
    <div class="sub">${num(data.scanned)} of ${num(data.total)} blocks. The list fills in as this runs, so counts are still low.</div>
    <div class="meter"><span style="width:${data.total ? (data.scanned / data.total) * 100 : 0}%"></span></div>
  </div>`;

  setView(`<h1 class="page-title">Auction list</h1>
    ${data.error ? notice(`Could not finish reading blocks: ${data.error}`) : ''}
    ${progress}
    <div class="tabs">${tabs}</div>
    <div class="filters">
      <label>Type
        <select id="auction-type">
          <option value="any"${type === 'any' ? ' selected' : ''}>Any</option>
          <option value="ascii"${type === 'ascii' ? ' selected' : ''}>ASCII</option>
          <option value="idn"${type === 'idn' ? ' selected' : ''}>IDN</option>
        </select>
      </label>
      <span class="muted">${num(matches.length)} name${matches.length === 1 ? '' : 's'}</span>
    </div>
    <div class="panel scroll"><table><thead><tr>${heads.join('')}</tr></thead><tbody>
      ${auctionRows(shown, tab, data.tip) || `<tr><td colspan="${heads.length}" class="muted">No auctions at this stage.</td></tr>`}
    </tbody></table></div>
    ${pages > 1 ? `<div class="pager">
      <span>${current > 0 ? '<button class="sort" data-page="-1">← Previous</button>' : ''}</span>
      <span class="muted">Page ${current + 1} of ${pages}</span>
      <span>${current < pages - 1 ? '<button class="sort" data-page="1">Next →</button>' : ''}</span>
    </div>` : ''}
    <p class="hint">Bids in a sealed auction are hidden, so lockup is the most a bid could be, not the bid itself. Real bids appear at reveal. Times assume 10 minutes per block.</p>`, keepScroll);
}

const onNames = () => /^#\/names(\/|$)/.test(location.hash);
let auctionPoll = null;

async function loadAuctions(keepScroll) {
  clearTimeout(auctionPoll);
  const data = await api('auctions');
  if (!onNames()) return;
  if (data.spv) return showError(SPV_NOTICE);
  auctionView.data = data;
  renderAuctions(keepScroll);
  if (!data.finished && !data.error) {
    auctionPoll = setTimeout(() => loadAuctions(true).catch(() => {}), 4000);
  }
}

async function viewNames(tab) {
  const next = AUCTION_TABS.some(([id]) => id === tab) ? tab : 'bidding';
  if (next !== auctionView.tab) {
    auctionView.tab = next;
    auctionView.key = 'end';
    auctionView.dir = -1;
    auctionView.page = 0;
  }
  if (auctionView.data) {
    // Switch at once from what's already loaded, then refresh behind it.
    renderAuctions();
    return loadAuctions(true);
  }
  loading('Loading auctions…');
  return loadAuctions();
}

view.addEventListener('click', e => {
  const sort = e.target.closest('[data-sort]');
  const page = e.target.closest('[data-page]');
  if (sort) {
    const key = sort.dataset.sort;
    auctionView.dir = auctionView.key === key ? -auctionView.dir : (key === 'name' || key === 'end' ? 1 : -1);
    auctionView.key = key;
    auctionView.page = 0;
    renderAuctions(true);
  } else if (page) {
    auctionView.page += Number(page.dataset.page);
    renderAuctions();
  }
});

view.addEventListener('change', e => {
  if (e.target.id !== 'auction-type') return;
  auctionView.type = e.target.value;
  auctionView.page = 0;
  renderAuctions(true);
});

// ---- names -----------------------------------------------------------------

const STAT_LABELS = {
  openPeriodStart: 'Open period starts', openPeriodEnd: 'Open period ends',
  blocksUntilBidding: 'Blocks until bidding', hoursUntilBidding: 'Hours until bidding',
  bidPeriodStart: 'Bidding starts', bidPeriodEnd: 'Bidding ends',
  blocksUntilReveal: 'Blocks until reveal', hoursUntilReveal: 'Hours until reveal',
  revealPeriodStart: 'Reveal starts', revealPeriodEnd: 'Reveal ends',
  blocksUntilClose: 'Blocks until close', hoursUntilClose: 'Hours until close',
  renewalPeriodStart: 'Renewal period starts', renewalPeriodEnd: 'Renewal period ends',
  blocksUntilExpire: 'Blocks until expiry', daysUntilExpire: 'Days until expiry',
  revokePeriodStart: 'Revoke period starts', revokePeriodEnd: 'Revoke period ends',
  blocksUntilValidFinalize: 'Blocks until transfer can finalize',
  hoursUntilValidFinalize: 'Hours until transfer can finalize',
  transferLockupStart: 'Transfer lockup starts', transferLockupEnd: 'Transfer lockup ends',
  blocksUntilWeakUnlock: 'Blocks until unlock', hoursUntilWeakUnlock: 'Hours until unlock',
};
const statValue = (key, value) => (/Height|Start|End$/.test(key) ? blockLink(value) : num(value));

function recordDetail(r) {
  if (r.type === 'DS') return `${r.keyTag} ${r.algorithm} ${r.digestType} ${r.digest}`;
  if (r.type === 'TXT') return `"${(r.txt || []).join(' ')}"`;
  return [r.ns, r.address].filter(Boolean).join(' ');
}

async function viewName(name) {
  loading(`Looking up “${name}”…`);
  const [spv, chain] = await Promise.all([nodeIsSpv(), rpc('getblockchaininfo').catch(() => null)]);
  const params = spv ? [name, true] : [name];
  const behind = chain && chain.verificationprogress < 0.9999;
  let info, resource;
  try { info = await rpc('getnameinfo', params); }
  catch (e) {
    if (/not synced/i.test(e.message)) return showError(SPV_SYNCING);
    return showError(`Could not look up name: ${e.message}`);
  }
  try { resource = await rpc('getnameresource', params); } catch (e) { resource = null; }

  const ni = (info && info.info) || null;
  const start = info && info.start;
  const state = ni && ni.state ? ni.state : 'UNREGISTERED';
  let owner = null;
  if (ni && ni.owner && ni.owner.hash && !spv && !/^0+$/.test(ni.owner.hash)) {
    const tx = await rest(`tx/${ni.owner.hash}`).catch(() => null);
    const out = tx && tx.outputs[ni.owner.index];
    owner = out && out.address;
  }

  const pairs = [['Status', badge(state)]];
  if (ni) {
    if (owner) pairs.push(['Owner', addressLink(owner, 14)]);
    pairs.push(['Auction opened', blockLink(ni.height)]);
    pairs.push(['Highest bid', hns(ni.highest)]);
    pairs.push(['Price paid', hns(ni.value)]);
    pairs.push(['Last renewal', blockLink(ni.renewal)]);
    pairs.push(['Renewals', num(ni.renewals)]);
    if (ni.owner && ni.owner.hash && !/^0+$/.test(ni.owner.hash)) pairs.push(['Latest owner transaction', txLink(ni.owner.hash, 14)]);
    if (ni.transfer) pairs.push(['Transfer started', blockLink(ni.transfer)]);
    if (ni.revoked) pairs.push(['Revoked', blockLink(ni.revoked)]);
    if (ni.claimed) pairs.push(['Claimed', 'Yes, as a reserved name']);
    if (ni.weak) pairs.push(['Weak (claimed with a weak key)', 'Yes']);
    for (const [key, value] of Object.entries(ni.stats || {})) {
      if (value != null) pairs.push([STAT_LABELS[key] || key, statValue(key, value)]);
    }
  } else if (start) {
    pairs.push(['Reserved', start.reserved ? 'Yes' : 'No']);
    pairs.push(['Available from block', blockLink(start.start)]);
  }

  const records = resource && Array.isArray(resource.records) ? resource.records : [];
  const recordRows = records.map(r => `<tr><td class="nowrap">${esc(r.type)}</td><td>${esc(recordDetail(r))}</td></tr>`);

  setView(`<h1 class="page-title">${esc(displayName(name))} <small>Handshake name</small></h1>
    ${behind ? notice('Your Bob node is still syncing, so this information may be out of date. A registered name can show as unregistered until the sync finishes.') : ''}
    ${kv(pairs)}
    <h2>DNS records</h2>
    ${records.length
      ? `<div class="panel scroll records"><table><tbody>${recordRows.join('')}</tbody></table></div>`
      : '<div class="panel"><div class="empty">No DNS records published.</div></div>'}
    ${raw('Raw name data', {info, resource})}`);
}

// ---- blocks ----------------------------------------------------------------

function covenantBadges(txs) {
  const counts = {};
  for (const tx of txs) {
    for (const out of tx.outputs) {
      const action = out.covenant && out.covenant.action;
      if (action && action !== 'NONE') counts[action] = (counts[action] || 0) + 1;
    }
  }
  const items = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return items.length
    ? `<div class="badges">${items.map(([a, n]) => `<span class="badge ${esc(a)}">${esc(a)} ${num(n)}</span>`).join('')}</div>`
    : '<span class="muted">None</span>';
}

function outputCovenants(tx) {
  const actions = [...new Set(tx.outputs.map(o => o.covenant && o.covenant.action))]
    .filter(a => a && a !== 'NONE');
  return actions.map(badge).join(' ');
}

async function viewBlock(id) {
  loading('Loading block…');
  const b = await rest(`block/${id}`);
  if (!b) return showError(`Block not found: ${id}`);
  const stats = await rpc('getblockbyheight', [b.height, true, false]).catch(() => null);
  const txs = b.txs || [];
  const fees = txs.reduce((s, tx) => s + (tx.fee || 0), 0);
  const coinbase = txs[0];
  const miner = coinbase && coinbase.outputs[0];
  const next = stats && stats.nextblockhash;

  const pairs = [
    ['Hash', `<span class="mono">${esc(b.hash)}</span>`],
    ['Time', `${esc(when(b.time))} (${age(b.time)})`],
    ['Confirmations', num(b.depth)],
    ['Transactions', num(txs.length)],
    ['Name activity', covenantBadges(txs)],
    ['Miner reward', miner ? hns(miner.value) : '—'],
    ['Fees', hns(fees)],
    ['Mined to', miner && miner.address ? addressLink(miner.address, 14) : '—'],
  ];
  if (stats) {
    pairs.push(['Size', bytes(stats.size)], ['Weight', num(stats.weight)], ['Difficulty', compact(stats.difficulty)]);
  }
  pairs.push(
    ['Merkle root', `<span class="mono">${esc(b.merkleRoot)}</span>`],
    ['Tree root', `<span class="mono">${esc(b.treeRoot)}</span>`],
    ['Bits / nonce', `${esc(b.bits)} / ${num(b.nonce)}`],
    ['Version', num(b.version)],
  );

  const rows = txs.slice(0, 200).map((tx, i) => `<tr>
    <td class="right muted">${i}</td>
    <td>${txLink(tx.hash)}</td>
    <td>${i === 0 ? '<span class="badge">COINBASE</span>' : outputCovenants(tx)}</td>
    <td class="right">${num(tx.inputs.length)}</td>
    <td class="right">${num(tx.outputs.length)}</td>
    <td class="right nowrap">${hns(tx.fee)}</td>
  </tr>`);

  setView(`<h1 class="page-title">Block ${num(b.height)}</h1>
    ${kv(pairs)}
    <div class="pager">
      <span>${b.height > 0 ? link(`#/block/${b.height - 1}`, '← Previous') : ''}</span>
      <span>${next ? link(`#/block/${b.height + 1}`, 'Next →') : ''}</span>
    </div>
    <h2>Transactions${txs.length > 200 ? ' (first 200)' : ''}</h2>
    ${table(['>#', 'Transaction', 'Activity', '>Inputs', '>Outputs', '>Fee'], rows, 'None.')}`);
}

// ---- transactions ----------------------------------------------------------

async function namesFor(hashes) {
  const names = {};
  await Promise.all([...new Set(hashes)].slice(0, 25).map(async hash => {
    names[hash] = await rpc('getnamebyhash', [hash]).catch(() => null);
  }));
  return names;
}

function covenantCell(c, names) {
  if (!c || !c.action || c.action === 'NONE') return '';
  const name = names[c.items[0]];
  return `${badge(c.action)}${name ? ` ${nameLink(name)}` : ''}`;
}

async function viewTx(hash) {
  loading('Loading transaction…');
  const tx = await rest(`tx/${hash}`);
  if (!tx) return showError(`Transaction not found: ${hash}`);
  const inputs = tx.inputs || [];
  const outputs = tx.outputs || [];
  const hashes = outputs.concat(inputs.map(i => i.coin).filter(Boolean))
    .map(o => o.covenant).filter(c => c && c.action !== 'NONE').map(c => c.items[0]);
  const names = await namesFor(hashes);
  const confirmed = tx.height != null && tx.height >= 0;
  const coinbase = inputs.length > 0 && /^0+$/.test(inputs[0].prevout.hash);
  const total = outputs.reduce((s, o) => s + Number(o.value || 0), 0);

  const pairs = [
    ['Hash', `<span class="mono">${esc(tx.hash)}</span>`],
    ['Status', confirmed
      ? `${num(tx.confirmations)} confirmation${tx.confirmations === 1 ? '' : 's'}`
      : '<span class="badge BIDDING">UNCONFIRMED</span>'],
    ['Block', confirmed ? blockLink(tx.height) : '—'],
    ['Time', `${esc(when(tx.time || tx.mtime))} (${age(tx.time || tx.mtime)})`],
    ['Total output', hns(total)],
    ['Fee', hns(tx.fee)],
    ['Fee rate', tx.rate != null ? `${hns(tx.rate)} / kB` : '—'],
    ['Size', tx.hex ? bytes(tx.hex.length / 2) : '—'],
    ['Version / locktime', `${num(tx.version)} / ${num(tx.locktime)}`],
  ];
  const outRows = outputs.map((o, i) => `<tr>
    <td class="right muted">${i}</td>
    <td>${o.address ? addressLink(o.address) : '<span class="muted">—</span>'}</td>
    <td>${covenantCell(o.covenant, names)}</td>
    <td class="right nowrap">${hns(o.value)}</td>
  </tr>`);
  const inRows = inputs.map((inp, i) => {
    const c = inp.coin;
    return `<tr>
      <td class="right muted">${i}</td>
      <td>${coinbase ? '<span class="badge">COINBASE</span>'
        : c && c.address ? addressLink(c.address) : '<span class="muted">Unknown</span>'}</td>
      <td>${c ? covenantCell(c.covenant, names) : ''}</td>
      <td class="right nowrap">${c && c.value != null ? hns(c.value) : '—'}</td>
    </tr>`;
  });
  const head = ['>#', 'Address', 'Activity', '>Value'];
  setView(`<h1 class="page-title">Transaction</h1>
    ${kv(pairs)}
    <h2>Inputs (${num(inputs.length)})</h2>${table(head, inRows, 'None.')}
    <h2>Outputs (${num(outputs.length)})</h2>${table(head, outRows, 'None.')}`);
}

// ---- addresses -------------------------------------------------------------

const HELD = new Set(['REGISTER', 'UPDATE', 'RENEW', 'TRANSFER', 'FINALIZE', 'CLAIM']);

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
  const sum = list => list.reduce((s, c) => s + Number(c.value || 0), 0);
  const plain = coins.filter(c => !c.covenant || c.covenant.action === 'NONE');
  const locked = coins.filter(c => c.covenant && c.covenant.action !== 'NONE');
  const heldCoins = locked.filter(c => HELD.has(c.covenant.action));
  const names = await namesFor(heldCoins.map(c => c.covenant.items[0]));
  const held = [...new Set(Object.values(names).filter(Boolean))].sort();

  // Newest first; unconfirmed transactions have height -1 and go on top.
  const rank = tx => (tx.height == null || tx.height < 0 ? Infinity : tx.height);
  const newest = [...txs].sort((a, b) => (rank(b) === rank(a) ? 0 : rank(b) > rank(a) ? 1 : -1));
  const rows = newest.slice(0, 200).map(tx => `<tr>
    <td>${txLink(tx.hash, 12)}</td>
    <td>${tx.height != null && tx.height >= 0 ? blockLink(tx.height) : '<span class="badge BIDDING">UNCONFIRMED</span>'}</td>
    <td class="nowrap">${age(tx.time || tx.mtime)}</td>
    <td>${outputCovenants(tx)}</td>
  </tr>`);

  setView(`<h1 class="page-title">Address</h1>
    <p class="mono" style="overflow-wrap:anywhere;margin-top:-8px">${esc(addr)}</p>
    <div class="grid">
      ${stat('Balance', hns(sum(plain)), 'Spendable coins')}
      ${stat('Locked in names', hns(sum(locked)), `${num(locked.length)} output${locked.length === 1 ? '' : 's'}`)}
      ${stat('Transactions', num(txs.length))}
      ${stat('Unspent outputs', num(coins.length))}
    </div>
    ${held.length ? `<h2>Names held (${num(held.length)})</h2>
      <div class="panel"><div class="empty badges">${held.map(nameLink).join(' · ')}</div></div>` : ''}
    <h2>Transactions${txs.length > 200 ? ' (newest 200)' : ''}</h2>
    ${table(['Transaction', 'Block', 'Time', 'Activity'], rows, 'No transactions for this address.')}`);
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

function markNav(kind) {
  const section = {block: 'blocks', name: 'names'}[kind] || kind || '';
  for (const a of document.querySelectorAll('[data-nav]')) {
    a.classList.toggle('active', a.dataset.nav === section);
  }
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [kind, ...parts] = hash.split('/');
  const arg = decodeURIComponent(parts.join('/') || '');
  markNav(kind);
  try {
    switch (kind) {
      case 'blocks': return await viewBlocks(arg);
      case 'names': return await viewNames(arg);
      case 'mempool': return await viewMempool();
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
  input.value = '';
  input.blur();
});

window.addEventListener('hashchange', route);
route();
refreshNodeChip();
setInterval(refreshNodeChip, 15000);
setInterval(() => {
  if (isHome() && !document.hidden) viewHome(true).catch(() => {});
}, REFRESH_MS);
setInterval(() => {
  for (const el of document.querySelectorAll('[data-age]')) {
    if (el.dataset.age) {
      const text = ago(Number(el.dataset.age));
      el.textContent = el.closest('.value') ? text.replace(/ ago/, '') : text;
    }
  }
}, 1000);
