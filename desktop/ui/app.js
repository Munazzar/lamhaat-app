// Lamhaat desktop, library screen: your shoots on the left; a shoot's photos on the right.
import { inAlbum, assign, clean, split, merge, GROUPS, SORTS } from '/lib/album.js';
import { NONE, SLIDERS, tidy, frame, applyPixels } from '/lib/edit.js';
const main = document.getElementById('main');
const shootsNav = document.querySelector('.shoots');
const rootBtn = document.querySelector('.root-path');
const toastEl = document.querySelector('.toast');

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(Infinity).filter(k => k != null && k !== false));
  return el;
};
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
  return data;
}
let toastTimer = 0;
function toast(text, kind = '') {
  toastEl.textContent = text; toastEl.className = `toast ${kind}`; toastEl.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, 5000);
}
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const gb = b => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
const day = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const clock = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };

// ---------- state ----------
let library = { folders: [] }, selected = null, progress = null;
try { selected = localStorage.getItem('shoot'); } catch {}

async function refresh() {
  library = await api('/api/library');
  rootBtn.textContent = library.root;
  if (!selected || !library.folders.some(f => f.path === selected)) selected = library.folders.find(f => f.count)?.path || library.folders[0]?.path || null;
  drawShoots();
}

function drawShoots() {
  document.querySelector('.nav-people')?.setAttribute('aria-current', String(onPeople));
  document.querySelector('.nav-settings')?.setAttribute('aria-current', String(onSettings));
  shootsNav.replaceChildren(...library.folders.map(f => h('button', {
    class: 'shoot', type: 'button', 'aria-current': f.path === selected && !onPeople && !onSettings ? 'true' : null,
    onclick: () => select(f.path),
  },
    h('span', { class: 'name' }, f.name),
    h('span', { class: 'meta' }, !f.exists ? 'missing' : f.count ? plural(f.count, 'photo') : 'not imported'),
    progress && progress.folder === f.path && progress.done < progress.total ? h('span', { class: 'mini', style: `--p:${progress.done / progress.total}` }) : null)));
}

async function select(path) {
  onPeople = onSettings = false;
  selected = path; undo = []; picked.clear(); expanded.clear(); tagFilter.clear();
  try { localStorage.setItem('shoot', path); } catch {}
  drawShoots();
  await drawShoot();
}

// ---------- a shoot ----------
const FLAG = { motion: 'Motion blur', blurry: 'Blurry', subject: 'Subject soft', eyes: 'Eyes closed', accident: 'Accidental shot', screenshot: 'Screenshot or document', tilted: 'Tilted', sensitive: 'Sensitive', weak: 'Weak shot', noisy: 'High-ISO noise', highlights: 'Blown highlights', shadows: 'Crushed shadows' };
const KIND = { burst: 'Bursts', near: 'Near duplicates', exact: 'Saved twice' };
const KIND_ONE = { burst: 'Burst', near: 'Near duplicate', exact: 'Same photo' };
const DEC = { todo: 'To decide', keep: 'Kept', reject: 'Rejected' };
let picked = new Set(), lastPick = -1, expanded = new Set(), tagFilter = new Set(), query = '';
let all = [], byId = new Map(), groups = new Map(), photos = [], viewList = [], viewing = -1, median = null, unscored = 0, filter = 'all', order = 'shoot', stacked = true, sameNames = new Set();
try { stacked = localStorage.getItem('stacked') !== 'no'; } catch {}
const FILTERS = () => ['all', ...Object.keys(DEC), 'flagged', ...Object.keys(FLAG), ...Object.keys(KIND)];
const matches = (p, k) => k === 'all' || (k === 'flagged' ? p.flags.length > 0 : k in KIND ? p.kind === k
  : k === 'todo' ? p.decision === 'undecided' : k in DEC ? p.decision === k : p.flags.includes(k));
const counts = () => Object.fromEntries(FILTERS().map(k => [k, all.filter(p => matches(p, k)).length]));
const label = p => sameNames.has(p.name) ? p.rel : p.name; // two copies with one name: say which folder
// group and decision filters list every frame; otherwise a group can show as one stack
const asStack = p => stacked && p.group && !(filter in KIND) && !(filter in DEC) && !tagFilter.size && !query; // a tag filter or a search lists every match too
function shown() {
  // stacked: a group shows as its suggested photo only, until it is opened
  let list = all.filter(p => matches(p, filter) && (!asStack(p) || p.isPick || expanded.has(p.group)) && [...tagFilter].every(t => p.tags.includes(t)));
  if (query) { // best matches first
    const tagName = id => tagLib.find(t => t.id === id)?.name;
    const scored = list.map(p => [p, searchScore(p, query, tagName)]).filter(([, n]) => n);
    return scored.sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }
  if (order === 'new') list.sort((a, b) => (b.taken || '').localeCompare(a.taken || ''));
  if (order === 'name') list.sort((a, b) => label(a).localeCompare(label(b), undefined, { numeric: true }));
  if (order === 'title') list.sort((a, b) => (a.title ? 0 : 1) - (b.title ? 0 : 1) || a.title.localeCompare(b.title));
  if (order === 'sharp') list.sort((a, b) => (b.sharpness ?? -1) - (a.sharpness ?? -1));
  if (order === 'soft') list.sort((a, b) => (a.sharpness ?? 1e12) - (b.sharpness ?? 1e12));
  return list;
}

async function drawShoot() {
  if (onPeople || onSettings) return; // the People or Settings screen is showing; imports and checks finishing don't take it away
  const f = library.folders.find(x => x.path === selected);
  if (!f) return main.replaceChildren(h('div', { class: 'empty' }, h('h1', {}, 'No shoots yet'), h('p', {}, `Put a folder of photos in ${library.root}, or choose another photo folder below.`)));
  const token = selected;
  const q = encodeURIComponent(f.path);
  const [data, scan, al] = await Promise.all([api(`/api/photos?folder=${q}`), f.exists ? api(`/api/scan?folder=${q}`) : null, api(`/api/album?folder=${q}`)]);
  if (token !== selected) return; // the user picked another shoot meanwhile
  const { photos: rows, median: med } = data;
  all = rows; median = med; unscored = data.unscored;
  byId = new Map(rows.map(p => [p.id, p]));
  album = al.album; albumSaved = al.saved; tiles.clear();
  groups = new Map((data.groups || []).map(g => [g.id, g]));
  const seen = new Set(); sameNames = new Set();
  for (const p of rows) { if (seen.has(p.name)) sameNames.add(p.name); seen.add(p.name); }

  const running = progress && progress.folder === f.path && progress.done < progress.total;
  const dates = rows.map(p => p.taken).filter(Boolean).sort();
  const cameras = [...new Set(rows.map(p => p.camera).filter(Boolean))];
  const facts = rows.length ? [plural(rows.length, 'photo'), scan && gb(scan.bytes), dates.length && (day(dates[0]) === day(dates.at(-1)) ? day(dates[0]) : `${day(dates[0])} – ${day(dates.at(-1))}`), cameras.join(', ')].filter(Boolean)
    : scan ? [plural(scan.photos, 'photo') + ' on disk', gb(scan.bytes)] : ['Folder not found'];
  const changed = scan && rows.length && scan.photos !== rows.length;

  const head = h('header', { class: 'head' },
    h('div', {},
      h('h1', {}, f.name),
      rows.length ? h('div', { class: 'modes', role: 'tablist' }, [['review', 'Review'], ['album', 'Album'], ['publish', 'Publish']].map(([m, t]) =>
        h('button', { class: 'mode', type: 'button', role: 'tab', 'aria-selected': String(mode === m), onclick: () => setMode(m) }, t))) : null,
      h('p', { class: 'facts' }, facts.join('  ·  ')),
      rows.length ? h('div', { class: 'review' }) : null,
      rows.length && mode === 'review' ? h('div', { class: 'ailine' }) : null,
      scan?.skipped ? h('p', { class: 'note' }, `${plural(scan.skipped, 'video or RAW file')} won’t be imported (not supported yet).`) : null),
    h('div', { class: 'actions' },
      running ? progressBar() : h('div', { class: 'btns' },
        rows.length && unscored ? h('button', { class: 'btn primary', type: 'button', onclick: () => startJob('/api/check', f.path) }, `Check ${plural(unscored, 'photo')}`) : null,
        f.exists && h('button', { class: `btn ${rows.length ? '' : 'primary'}`, type: 'button', onclick: () => startJob('/api/import', f.path) },
          rows.length ? (changed ? 'Re-import (files changed)' : 'Re-import') : `Import ${scan ? plural(scan.photos, 'photo') : ''}`))));

  if (!rows.length) {
    return main.replaceChildren(head, h('div', { class: 'empty' },
      h('p', {}, running ? 'Reading your photos. They’ll appear here when the import finishes.' : 'Importing reads each photo, its date and camera settings, and makes a small preview. Your originals are never changed.')));
  }
  if (filter !== 'all' && !counts()[filter]) filter = 'all';
  const top = h('div', { class: 'top' }, head, mode === 'review' ? toolsEl() : null);
  main.replaceChildren(top, h('div', { class: mode === 'review' ? 'grid' : mode }));
  // keyboard moves scroll a tile into view below the sticky header, not under it
  new ResizeObserver(() => { main.style.scrollPaddingTop = `${top.offsetHeight + 8}px`; }).observe(top);
  drawReview();
  if (mode === 'review') { drawGrid(); drawAi(); } else if (mode === 'album') drawAlbum(); else drawPublish();
}
function toolsEl() {
  const n = counts();
  return h('div', { class: 'tools' },
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Show' },
      [['all', 'All', all.length], ...[DEC, { flagged: 'Flagged' }, FLAG, KIND].flatMap(o => Object.entries(o).map(([k, t]) => [k, t, n[k]]))]
        .filter(([k, , c]) => k === 'all' || c || k === filter)
        .map(([k, t, c]) => h('button', { class: `chip${k in KIND ? ' g' : ''}${k in DEC ? ' d' : ''}`, type: 'button', 'data-k': k, 'aria-pressed': String(filter === k), onclick: () => { filter = k; drawGrid(); drawTools(); } }, t, h('span', {}, c)))),
    h('div', { class: 'right' },
    h('input', { class: 'search', type: 'search', value: query, placeholder: 'Search: e.g. kids at the beach', 'aria-label': 'Search photos by what is in them',
      oninput: e => { query = e.target.value.trim(); clearTimeout(searchTimer); searchTimer = setTimeout(drawGrid, 200); } }),
    tagLib.length ? h('div', { class: 'tfilter' },
      tagBox({ kind: 'person', placeholder: 'Filter by person', filter: { set: tagFilter, changed: () => drawGrid() } }),
      tagBox({ kind: 'tag', placeholder: 'Filter by tag', filter: { set: tagFilter, changed: () => drawGrid() } })) : null,
    h('label', { class: 'stack' }, h('input', { type: 'checkbox', checked: showTags, onchange: e => { showTags = e.target.checked; remember('showTags', showTags); drawGrid(); } }), 'Show tags'),
    groups.size ? h('label', { class: 'stack', title: 'Show each burst or duplicate set as one photo: the suggested pick' },
      h('input', { type: 'checkbox', checked: stacked, onchange: e => { stacked = e.target.checked; try { localStorage.setItem('stacked', stacked ? 'yes' : 'no'); } catch {} drawGrid(); } }), `Stack ${plural(groups.size, 'group')}`) : null,
    h('label', { class: 'sort' }, 'Order ',
      h('select', { onchange: e => { order = e.target.value; drawGrid(); } },
        [['shoot', 'As shot (oldest first)'], ['new', 'Newest first'], ['name', 'File name'], ['title', 'Title'], ['sharp', 'Sharpest first'], ['soft', 'Softest first']].map(([v, t]) => h('option', { value: v, selected: order === v }, t)))),
    sizeSlider()));
}
// how big the photos are in the grid and the album (remembered)
let tileSize = 190;
try { tileSize = Number(localStorage.getItem('tileSize')) || 190; } catch {}
const applySize = () => document.documentElement.style.setProperty('--tile', `${tileSize}px`);
applySize();
const sizeSlider = () => h('label', { class: 'sort size', title: 'Photo size' }, 'Size ', h('input', { type: 'range', min: 110, max: 420, step: 10, value: tileSize, 'aria-label': 'Photo size',
  oninput: e => { tileSize = Number(e.target.value); applySize(); hidePeek(); try { localStorage.setItem('tileSize', tileSize); } catch {} } }));
function drawTools() {
  main.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.k === filter)));
}
function drawGrid() {
  photos = shown();
  const grid = main.querySelector('.grid');
  if (!grid) return;
  grid.replaceChildren(...photos.map((p, i) => {
    const open = asStack(p) && expanded.has(p.group), stack = asStack(p) && !open;
    const tag = p.group ? (stack ? `${KIND_ONE[p.kind]} · ${p.size} ▸` : open && p.isPick ? `▾ ${KIND_ONE[p.kind]} · ${p.size}` : `${KIND_ONE[p.kind]} ${p.at}/${p.size}${p.isPick ? ' · pick' : ''}`) : null;
    return mark(h('button', {
      class: `cell${stack ? ' stacked' : ''}${open ? ' opened' : ''}${p.group && p.isPick ? ' pick' : ''}${picked.has(p.id) ? ' sel' : ''}`, type: 'button', 'data-id': p.id,
      'aria-label': [label(p), tag, ...p.flags.map(f => FLAG[f])].filter(Boolean).join(', '), 'aria-pressed': String(picked.has(p.id)),
      title: stack ? 'Click to see every frame. Hold or Ctrl+click to pick.' : 'Click to open. Hold, or Ctrl+click, to pick; then click more. Right-click for more.',
      onclick: e => tileClick(e, p, i, stack, open),
    },
      h('img', { src: thumb(p), alt: '', loading: 'lazy', decoding: 'async', onload: e => e.target.classList.add('in') }),
      tag ? h('span', { class: `gtag k-${p.kind}` }, tag) : null,
      h('span', { class: 'dmark' }),
      h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'),
      p.flags.length ? h('span', { class: 'flags' }, p.flags.map(f => h('i', { class: `f-${f}` }, FLAG[f]))) : null,
      tileTags(p)), p, stack);
  }));
  drawPicked();
}
function tileClick(e, p, i, stack, open) {
  // once one photo is picked, a plain click picks or unpicks more (no Ctrl needed)
  if (e.ctrlKey || e.metaKey || (picked.size && !e.shiftKey)) { picked.has(p.id) ? picked.delete(p.id) : picked.add(p.id); lastPick = i; return drawPicked(); }
  if (e.shiftKey && lastPick >= 0) { const [a, b] = [lastPick, i].sort((x, y) => x - y); for (let j = a; j <= b; j++) picked.add(photos[j].id); return drawPicked(); }
  if (open && p.isPick && e.target.closest('.gtag')) { expanded.delete(p.group); return drawGrid(); } // close the group again
  if (stack) { expanded.add(p.group); drawGrid(); return main.querySelector(`.cell[data-id="${p.id}"]`)?.focus(); }
  view(i, photos);
}

// ---------- several photos picked: keep, reject, tag them together ----------
const pickBar = h('div', { class: 'pickbar', hidden: true, role: 'toolbar', 'aria-label': 'Picked photos' });
document.body.append(pickBar);
function drawPicked() {
  for (const c of main.querySelectorAll('.grid .cell, .album .atile')) { const on = picked.has(Number(c.dataset.id)); c.classList.toggle('sel', on); c.setAttribute('aria-pressed', String(on)); }
  main.querySelector('.album')?.classList.toggle('picking', picked.size > 0);
  pickBar.hidden = !picked.size || (mode !== 'review' && mode !== 'album') || onPeople || onSettings;
  if (pickBar.hidden) return;
  const ids = [...picked];
  const after = () => { for (const id of ids) paintTile(byId.get(id)); main.querySelector('.tools')?.replaceWith(toolsEl()); };
  const more = h('button', { class: 'btn small', type: 'button', onclick: e => openMenu(e, byId.get(ids[0])) }, 'More ▾');
  pickBar.replaceChildren(
    h('b', {}, plural(ids.length, 'photo'), ' picked'),
    h('button', { class: 'dbtn d-keep', type: 'button', onclick: () => decide(ids.map(id => ({ id, decision: 'keep' })), { note: true }) }, 'Keep', h('kbd', {}, 'K')),
    h('button', { class: 'dbtn d-reject', type: 'button', onclick: () => decide(ids.map(id => ({ id, decision: 'reject' })), { note: true }) }, 'Reject', h('kbd', {}, 'X')),
    tagBox({ kind: 'person', ids, placeholder: 'Add a person to all', onChange: after }),
    tagBox({ kind: 'tag', ids, placeholder: 'Add a tag to all', onChange: after }),
    more,
    h('button', { class: 'link', type: 'button', onclick: () => { (mode === 'album' ? inAlbum(all) : photos).forEach(p => picked.add(p.id)); drawPicked(); } }, 'Pick all'),
    h('button', { class: 'link', type: 'button', onclick: clearPicked }, 'Clear (Esc)'));
}
function clearPicked() { picked.clear(); lastPick = -1; drawPicked(); }
const togglePick = id => { picked.has(id) ? picked.delete(id) : picked.add(id); drawPicked(); };

// ---------- the pointer on a photo (review grid and album): hold to pick, rest to peek, keys act on it ----------
const tileOf = el => el?.closest?.('.grid .cell, .album .atile');
const photoOf = el => byId.get(Number(tileOf(el)?.dataset.id));
let hoverEl = null, mouseLast = false, held = false, holdTimer = 0, peekTimer = 0;
const peek = h('div', { class: 'peek', hidden: true, 'aria-hidden': 'true' });
document.body.append(peek);
function showPeek(el) {
  const p = photoOf(el);
  if (!p || !el.isConnected) return;
  // a stack shows its frames; one photo shows itself, larger
  const frames = el.classList.contains('stacked') ? groups.get(p.group).ids.map(id => byId.get(id)) : [p];
  peek.classList.toggle('many', frames.length > 1);
  peek.replaceChildren(...frames.slice(0, 12).map(q => h('figure', {}, h('img', { src: thumb(q), alt: '' }), frames.length > 1 ? h('figcaption', {}, label(q)) : null)),
    frames.length > 12 ? h('p', { class: 'more' }, `+${frames.length - 12} more`) : null);
  peek.hidden = false;
  const r = el.getBoundingClientRect(), pr = peek.getBoundingClientRect();
  const right = r.right + 12 + pr.width < innerWidth;
  peek.style.left = `${Math.max(8, right ? r.right + 12 : r.left - 12 - pr.width)}px`;
  peek.style.top = `${Math.max(8, Math.min(innerHeight - pr.height - 8, r.top + r.height / 2 - pr.height / 2))}px`;
}
const hidePeek = () => { clearTimeout(peekTimer); peek.hidden = true; };
main.addEventListener('mouseover', e => {
  const el = tileOf(e.target);
  if (el === hoverEl) return;
  hoverEl = el; hidePeek();
  if (el) peekTimer = setTimeout(() => showPeek(el), 1300);
});
main.addEventListener('mouseleave', () => { hoverEl = null; hidePeek(); });
addEventListener('mousemove', () => { mouseLast = true; }, { passive: true });
main.addEventListener('scroll', hidePeek, { passive: true });
// hold (half a second) to pick, like on a phone
main.addEventListener('pointerdown', e => {
  hidePeek();
  const el = tileOf(e.target);
  if (!el || e.button !== 0 || e.target.closest('.aact, .gtag')) return;
  const x = e.clientX, y = e.clientY;
  const stop = () => { clearTimeout(holdTimer); removeEventListener('pointermove', mv); };
  const mv = m => { if (Math.abs(m.clientX - x) + Math.abs(m.clientY - y) > 8) stop(); };
  addEventListener('pointermove', mv);
  addEventListener('pointerup', stop, { once: true });
  holdTimer = setTimeout(() => { stop(); held = true; togglePick(Number(el.dataset.id)); }, 500);
});
// the click that ends a hold doesn't also open the photo
main.addEventListener('click', e => { if (held) { held = false; e.stopPropagation(); e.preventDefault(); } }, true);
// what keys act on: the picked photos; else the one under the pointer (if the mouse moved last); else the focused one
function keyTarget(cells, i) {
  if (mouseLast && panel.hidden && hoverEl?.isConnected) return photoOf(hoverEl);
  return i >= 0 ? (cells[i].classList.contains('cell') && panel.hidden ? photos[i] : photoOf(cells[i]) || byId.get(Number(cells[i].dataset.id))) : null;
}

// ---------- right-click: what can be done with this photo (or the picked ones, if it's one of them) ----------
const menu = h('div', { class: 'cmenu', hidden: true, role: 'menu' });
document.body.append(menu);
const closeMenu = () => { menu.hidden = true; };
addEventListener('pointerdown', e => { if (!menu.contains(e.target)) closeMenu(); }, true);
addEventListener('blur', closeMenu);
function openMenu(e, p, { single = false } = {}) {
  e.preventDefault(); hidePeek();
  const ids = !single && picked.has(p.id) ? [...picked] : [p.id], one = ids.length === 1, n = plural(ids.length, 'photo');
  const item = (text, fn, key) => h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); fn(); } }, h('span', {}, text), key ? h('kbd', {}, key) : null);
  const sep = () => h('hr');
  const dec = d => decide(ids.map(id => ({ id, decision: d })), { note: !one });
  const inAlb = album && byId.get(p.id)?.decision !== 'reject';
  menu.replaceChildren(...[
    h('p', { class: 'mtitle' }, one ? label(p) : `${n} picked`),
    one && viewing < 0 ? item('Open large', () => openPhoto(p), 'Enter') : null,
    item(picked.has(p.id) ? (one ? 'Unpick' : 'Unpick all') : 'Pick', () => one ? togglePick(p.id) : clearPicked()),
    sep(),
    item('Keep', () => dec('keep'), 'K'), item('Reject', () => dec('reject'), 'X'), item('Undecided', () => dec('undecided'), 'U'),
    one && inAlb ? [sep(), item('Album cover', () => setCover(p), 'C'), item(album.highlights.includes(p.id) ? 'Remove highlight' : 'Highlight', () => toggleHi(p), 'H'),
      mode === 'album' && album.groupBy === 'date' && p.taken ? item('New chapter from here', () => splitAt(p), 'S') : null] : null,
    sep(),
    one ? item('Edit', () => { if (viewing < 0) openPhoto(p); startEdit(p); }, 'E') : null,
    item(`Remove noise${one ? '' : ` from ${n}`} (AI)`, () => api('/api/denoise', { method: 'POST', body: JSON.stringify({ ids }) }).then(() => toast(`Removing noise: ${n}, about 20 seconds each. A RAW photo is cleaned in place; a JPEG gets a clean copy next to it.`, 'good'), err => toast(err.message, 'bad'))),
    item(`Sharpen${one ? '' : ` ${n}`} (AI)`, () => enhanceAsk(ids, 'fix')),
    item('Make 2× bigger (AI)', () => enhanceAsk(ids, 'x2')),
    item('Make 4× bigger (AI)', () => enhanceAsk(ids, 'x4')),
    item('Describe again with the AI…', () => reprocessDialog(ids)),
    one ? [sep(), item('Show in File Explorer', () => api('/api/reveal', { method: 'POST', body: JSON.stringify({ id: p.id }) }).catch(err => toast(err.message, 'bad')))] : null,
  ].flat().filter(Boolean));
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
  menu.querySelector('button')?.focus({ preventScroll: true });
}
main.addEventListener('contextmenu', e => { const p = photoOf(e.target); if (p) openMenu(e, p); });
// a photo opens large in the list it is seen in
function openPhoto(p) {
  if (mode === 'album') { const list = inAlbum(all); return view(list.indexOf(p), list); }
  const i = photos.indexOf(p);
  view(i >= 0 ? i : 0, i >= 0 ? photos : [p]);
}

// words matched against what is known about a photo: every word must appear (plurals match singulars)
let searchTimer = 0;
function searchScore(p, q, tagName) {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1).map(w => w.replace(/(?<=..)(es|s)$/, ''));
  if (!words.length) return 0;
  const text = [p.title, p.description, p.aiDescription, ...(p.aiTags || []), ...p.tags.map(tagName), p.name, p.camera].filter(Boolean).join(' ').toLowerCase();
  let score = 0;
  for (const w of words) { const n = text.split(w).length - 1; if (!n) return 0; score += n; }
  return score;
}

// ---------- the local AI: status, describing a shoot, finding people ----------
let aiState = null;
async function drawAi() {
  const box = main.querySelector('.ailine');
  if (!box) return;
  const folder = selected;
  try { aiState = await api(`/api/ai?folder=${encodeURIComponent(folder)}`); } catch { return; }
  if (folder !== selected || !main.contains(box)) return;
  const st = aiState, j = st.job;
  const people = tagLib.filter(t => t.kind === 'person' && all.some(p => p.tags.includes(t.id) && !(p.autoTags || []).includes(t.id)));
  box.replaceChildren(...[
    h('span', { class: 'ailab' }, 'AI'),
    !st.ok ? h('span', { class: 'hint' }, st.why)
      : j ? h('span', {}, j.kind === 'describe' ? `Describing photos: ${j.done} of ${j.total}` : `Looking for ${j.person}: ${j.done} of ${j.total}`, h('span', { class: 'bar mini' }, h('i', { style: `transform: scaleX(${j.total ? j.done / j.total : 0})` })),
          h('button', { class: 'link', type: 'button', onclick: () => api('/api/ai/stop', { method: 'POST' }).then(drawAi) }, 'Stop'))
      : st.undescribed ? h('span', {}, `${plural(st.undescribed, 'photo')} not described yet  `,
          h('button', { class: 'link', type: 'button', onclick: () => api('/api/ai/describe', { method: 'POST', body: JSON.stringify({ folder }) }).then(drawAi) }, 'Describe them'))
      : h('span', { class: 'done' }, 'Every photo described: search, and suggested tags in the large view'),
    st.ok && people.length && !j ? h('span', { class: 'hint' }, 'Tag a person in a photo and the AI finds and tags them in the rest of the shoot by itself.') : null,
    st.ok && !people.length && !j ? h('span', { class: 'hint' }, 'Tag someone in one photo (large view, People) and the AI tags them in the rest by itself.') : null,
  ].filter(Boolean));
}
// ---------- decisions: keep, reject, undo ----------
// what a tile shows: its own decision, or for a stack, how far its group is decided
function mark(el, p, stack) {
  let d = p.decision === 'undecided' ? '' : p.decision, text = DEC[d] || '';
  if (stack) {
    const m = groups.get(p.group).ids.map(id => byId.get(id).decision);
    const kept = m.filter(x => x === 'keep').length, open = m.filter(x => x === 'undecided').length;
    d = open === m.length ? '' : open ? 'partial' : kept ? 'keep' : 'reject';
    text = d === 'partial' ? `${m.length - open} of ${m.length} decided` : d === 'keep' ? `Kept ${kept} of ${m.length}` : d ? 'All rejected' : '';
  }
  el.dataset.d = d;
  el.querySelector('.dmark').textContent = text;
  return el;
}
function drawReview() {
  const box = main.querySelector('.review');
  if (!box) return;
  const n = counts(), todo = n.todo;
  box.replaceChildren(...[
    h('span', { class: todo ? '' : 'done' }, todo ? `Review: ${plural(todo, 'photo')} to decide` : 'Review complete', `  ·  ${n.keep.toLocaleString()} kept  ·  ${n.reject.toLocaleString()} rejected`),
    todo && !unscored ? h('button', { class: 'link', type: 'button', onclick: acceptAll, title: 'Applies the suggestions to the photos you haven’t decided yet. Your own decisions stay.' }, `Accept suggestions for ${plural(todo, 'photo')}`) : null,
    todo && unscored ? h('span', { class: 'hint' }, 'Check the photos first to get suggestions') : null,
    h('span', { class: 'hint keys' }, 'Arrows move  ·  K keep  ·  X reject  ·  G group  ·  Ctrl+Z undo')].filter(Boolean));
}
function repaint() {
  main.querySelectorAll('.grid .cell').forEach((c, i) => photos[i] && mark(c, photos[i], asStack(photos[i]) && !expanded.has(photos[i].group)));
  panel.querySelectorAll('.gcell').forEach(c => mark(c, byId.get(Number(c.dataset.id)), false));
  if (viewing >= 0 && !editing) big.querySelector('.row4')?.replaceWith(decisionRow(viewList[viewing]));
  main.querySelector('.tools')?.replaceWith(toolsEl());
  drawReview();
  if (mode === 'album') drawAlbum(); // a rejected photo leaves the album, a kept one joins
}

let undo = [];
const said = changes => {
  const k = changes.filter(c => c.decision === 'keep').length, x = changes.filter(c => c.decision === 'reject').length, u = changes.length - k - x;
  return [k && `kept ${k}`, x && `rejected ${x}`, u && `${u} back to undecided`].filter(Boolean).join(', ');
};
async function decide(changes, { record = true, note = changes.length > 1 } = {}) {
  changes = changes.filter(c => byId.get(c.id) && byId.get(c.id).decision !== c.decision);
  if (!changes.length) return;
  const folder = selected, before = changes.map(c => ({ id: c.id, decision: byId.get(c.id).decision }));
  const apply = list => { for (const c of list) byId.get(c.id).decision = c.decision; repaint(); };
  apply(changes); // show it at once; put it back if saving fails
  try {
    await api('/api/decide', { method: 'POST', body: JSON.stringify({ folder, changes }) });
    if (record) remember2(said(changes), () => decide(before, { record: false, note: false }));
    if (note) { const s = said(changes); toast(`${s[0].toUpperCase()}${s.slice(1)}.${record ? '  Ctrl+Z to undo.' : ''}`, 'good'); }
  } catch (err) {
    if (folder === selected) apply(before);
    toast(`Not saved: ${err.message}`, 'bad');
  }
}
// Ctrl+Z takes back the last thing done in this shoot: decisions, tags and people, album changes
// (chapters, cover, highlights, order), edits. Typing in a box has its own undo.
function remember2(what, run) { undo.push({ what, run, folder: selected }); if (undo.length > 200) undo.shift(); }
async function undoLast() {
  const last = undo.pop();
  if (!last) return toast('Nothing to undo.');
  if (last.folder !== selected) { undo.length = 0; return toast('Nothing to undo in this shoot.'); }
  try { await last.run(); toast(`Undone: ${last.what}.`); }
  catch (err) { toast(`Couldn’t undo: ${err.message}`, 'bad'); }
}
const one = (p, decision) => decide([{ id: p.id, decision }]);
// a whole group at once: 'suggest' keeps the pick and rejects the rest
const decideGroup = (id, how) => decide(groups.get(id).ids.map(x => ({ id: x, decision: how === 'suggest' ? byId.get(x).suggest : how })), { note: true });
function acceptAll() {
  decide(all.filter(p => p.decision === 'undecided').map(p => ({ id: p.id, decision: p.suggest })), { note: true });
}

// ---------- a group: every frame side by side, the suggestion and why ----------
const panel = h('div', { class: 'gpanel', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Group' });
document.body.append(panel);
let openGroupId = null;
function openGroup(id) {
  const g = groups.get(id);
  if (!g) return;
  openGroupId = id;
  const members = g.ids.map(x => byId.get(x)).filter(Boolean);
  const top = Math.max(...members.map(p => p.sharpness || 0), 1);
  panel.replaceChildren(h('div', { class: 'gbox' },
    h('header', {},
      h('div', {}, h('p', { class: 'gkind' }, `${KIND_ONE[g.kind]} · ${plural(members.length, 'photo')}`), h('h2', {}, 'Suggested: ', label(byId.get(g.pick)))),
      h('button', { class: 'big-close', type: 'button', 'aria-label': 'Close', onclick: closeGroup }, '×')),
    h('p', { class: 'why' }, g.reason),
    h('div', { class: 'gacts' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => decideGroup(id, 'suggest') }, g.kind === 'exact' ? 'Keep one, reject the extra copies' : 'Keep the suggestion, reject the rest'),
      h('button', { class: 'btn', type: 'button', onclick: () => decideGroup(id, 'keep') }, 'Keep all'),
      h('button', { class: 'btn', type: 'button', onclick: () => decideGroup(id, 'reject') }, 'Reject all'),
      h('span', { class: 'hint' }, 'Or choose each: K keep  ·  X reject  ·  U undecided')),
    h('div', { class: 'gstrip' }, members.map((p, i) => mark(h('button', { class: `gcell${p.id === g.pick ? ' pick' : ''}`, type: 'button', 'data-id': p.id, onclick: () => view(i, members) },
      h('img', { src: thumb(p), alt: '' }),
      p.id === g.pick ? h('span', { class: 'pickmark' }, 'Suggested') : null,
      h('span', { class: 'dmark' }),
      h('span', { class: 'gname' }, label(p)),
      h('span', { class: 'gbar', title: `Sharpness ${Math.round(p.sharpness || 0)}` }, h('i', { style: `transform: scaleX(${(p.sharpness || 0) / top})` })),
      p.flags.length ? h('span', { class: 'flags in' }, p.flags.map(f => h('i', { class: `f-${f}` }, FLAG[f]))) : null), p, false)))));
  if (panel.hidden && history.state?.lamhaat !== 'group') history.pushState({ lamhaat: 'group' }, '');
  panel.hidden = false;
  panel.querySelector('.gcell.pick, .gcell')?.focus();
}
function closeGroup() {
  if (history.state?.lamhaat === 'group') return history.back();
  panel.hidden = true;
  [...main.querySelectorAll('.cell')].find((c, i) => photos[i]?.group === openGroupId)?.focus();
  openGroupId = null;
}
panel.addEventListener('click', e => { if (e.target === panel) closeGroup(); });

function progressBar() {
  const p = progress, frac = p.total ? p.done / p.total : 0;
  const left = p.done > 3 ? ((Date.now() - p.started) / p.done) * (p.total - p.done) : null;
  return h('div', { class: 'progress' },
    h('p', { class: 'phase' }, p.phase === 'checking' ? 'Step 2 of 2 · checking sharpness and exposure' : 'Step 1 of 2 · reading photos'),
    h('div', { class: 'bar' }, h('span', { style: `transform: scaleX(${frac})` })),
    h('p', {}, `${p.done.toLocaleString()} of ${p.total.toLocaleString()}`, left != null ? `  ·  about ${clock(left)} left` : '', p.errors?.length ? `  ·  ${p.errors.length} couldn’t be read` : ''));
}

async function startJob(url, folder) {
  try {
    progress = { folder, phase: url.endsWith('check') ? 'checking' : 'reading', done: 0, total: 1, started: Date.now() };
    drawShoots(); drawShoot();
    await api(url, { method: 'POST', body: JSON.stringify({ folder }) });
  } catch (err) { progress = null; toast(err.message, 'bad'); drawShoots(); drawShoot(); }
}

// ---------- live events ----------
const events = new EventSource('/api/events');
events.addEventListener('progress', e => {
  progress = JSON.parse(e.data);
  drawShoots();
  if (progress.folder === selected) {
    const bar = main.querySelector('.progress');
    if (bar) bar.replaceWith(progressBar()); else drawShoot();
  }
});
events.addEventListener('imported', async e => {
  const r = JSON.parse(e.data);
  const parts = [r.added && `${r.added} new`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} removed`, r.unchanged && `${r.unchanged} unchanged`].filter(Boolean);
  toast(`${r.folder.split('\\').pop()}: ${parts.join(', ') || 'nothing to do'} in ${clock(r.ms)}${r.errors.length ? `. ${r.errors.length} couldn’t be read: ${r.errors.slice(0, 3).map(x => x.file).join(', ')}` : ''}`, r.errors.length ? 'bad' : 'good');
  await refresh();
});
events.addEventListener('checked', async e => {
  const r = JSON.parse(e.data);
  progress = null;
  await refresh();
  if (r.folder === selected) await drawShoot();
  const n = r.folder === selected ? counts() : null;
  toast(r.total ? `Checked ${plural(r.total, 'photo')} in ${clock(r.ms)}${n ? `: ${plural(n.flagged, 'photo')} flagged for a look` : ''}${r.errors.length ? `. ${r.errors.length} couldn’t be read` : ''}.` : 'Every photo was already checked.', r.errors.length ? 'bad' : 'good');
});
events.addEventListener('github', e => {
  const r = JSON.parse(e.data);
  signingIn = webWaiting = null;
  if (r.account) { gh.account = r.account; toast(`Signed in to GitHub as ${r.account.login}.`, 'good'); }
  else toast(r.error, 'bad');
  if (mode === 'publish') drawPublish();
});
events.addEventListener('publish', e => {
  const r = JSON.parse(e.data);
  if (r.folder !== selected) return;
  pubRun = r;
  if (mode === 'publish') drawRun();
  if (r.status === 'done') toast(r.url ? `Published. Live at ${r.url}` : 'Published to GitHub.', 'good');
});
events.addEventListener('job-failed', e => { progress = null; toast(JSON.parse(e.data).error, 'bad'); refresh().then(drawShoot); });

// ---------- a photo, large: full quality, arrows, caption, details, tags, edits ----------
const big = h('div', { class: 'big', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo' });
document.body.append(big);
let showTags = true, showInfo = true, zoomed = false, editing = null, drawToken = 0;
try { showTags = localStorage.getItem('showTags') !== 'no'; showInfo = localStorage.getItem('showInfo') !== 'no'; } catch {}
const remember = (k, v) => { try { localStorage.setItem(k, v ? 'yes' : 'no'); } catch {} };
const thumb = p => p.ev ? `/edited/${p.id}-${p.ev}.jpg` : `/preview/${p.sha256}.jpg`;
const fullImages = new Map(); // sha -> decoded full-quality Image, newest few kept
function fullImage(p) {
  if (!fullImages.has(p.sha256)) {
    const im = new Image();
    im.src = `/full/${p.sha256}.jpg`;
    fullImages.set(p.sha256, im.decode().then(() => im));
    if (fullImages.size > 8) fullImages.delete(fullImages.keys().next().value);
  }
  return fullImages.get(p.sha256);
}

// the picture with its edits, on a canvas sized to fit (or at full size when zoomed in)
function drawEdited(canvas, img, e, maxW, maxH, { whole = false } = {}) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const f = frame(e, w, h), c = whole ? { x: 0, y: 0, w: f.fw, h: f.fh } : f.crop;
  const s = Math.min(maxW / c.w, maxH / c.h, 1);
  canvas.width = Math.max(1, Math.round(c.w * s)); canvas.height = Math.max(1, Math.round(c.h * s));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(s, s); ctx.translate(-c.x, -c.y); ctx.translate(f.fw / 2, f.fh / 2);
  ctx.rotate((e.turn + e.straighten) * Math.PI / 180);
  ctx.scale(e.flipH ? -1 : 1, e.flipV ? -1 : 1);
  ctx.drawImage(img, -w / 2, -h / 2);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyPixels(data.data, canvas.width, canvas.height, 4, e);
  ctx.putImageData(data, 0, 0);
  return { f, s };
}

function view(i, list = viewList) {
  if (editing) return;
  viewList = list;
  viewing = Math.max(0, Math.min(viewList.length - 1, i));
  zoomed = false;
  const p = viewList[viewing];
  zoom = { s: 1, x: 0, y: 0 };
  const pic = h('div', { class: 'pic', ondblclick: e => zoomTo(e, zoom.s > 1 ? 1 : 2.5), onwheel: e => { e.preventDefault(); zoomTo(e, zoom.s * Math.exp(-e.deltaY * 0.0015)); } },
    h('img', { class: 'lo', src: thumb(p), alt: label(p) }));
  big.replaceChildren(
    h('div', { class: 'viewer' + (showInfo ? ' with-side' : '') },
      h('div', { class: 'stagecol' },
        h('div', { class: 'vbar' },
          h('span', { class: 'n' }, `${viewing + 1} / ${viewList.length}`),
          h('b', {}, label(p)),
          h('span', { class: 'sp' }),
          toggle('Tags', showTags, 'T', () => { showTags = !showTags; remember('showTags', showTags); view(viewing); drawGrid(); }),
          toggle('Details', showInfo, 'I', () => { showInfo = !showInfo; remember('showInfo', showInfo); view(viewing); }),
          h('button', { class: 'vbtn', type: 'button', onclick: () => startEdit(p) }, 'Edit', h('kbd', {}, 'E')),
          h('button', { class: 'big-close', type: 'button', 'aria-label': 'Close', onclick: closeView }, '×')),
        h('div', { class: 'stage' },
          h('button', { class: 'nav prev', type: 'button', 'aria-label': 'Previous photo', disabled: viewing === 0, onclick: () => view(viewing - 1) }, '‹'),
          pic,
          h('button', { class: 'nav next', type: 'button', 'aria-label': 'Next photo', disabled: viewing === viewList.length - 1, onclick: () => view(viewing + 1) }, '›')),
        captionEl(p)),
      showInfo ? sideEl(p) : null));
  if (big.hidden && history.state?.lamhaat !== 'view') history.pushState({ lamhaat: 'view' }, ''); // so Back (mouse, Alt+←) closes it
  big.hidden = false;
  if (!big.contains(document.activeElement)) big.querySelector('.big-close').focus();
  drawPic(p);
  fitCaption();
  // the neighbours load in the background, so moving on is instant
  for (const d of [1, -1]) { const q = viewList[viewing + d]; if (q) fullImage(q).catch(() => {}); }
}
const toggle = (text, on, key, fn) => h('button', { class: 'vbtn', type: 'button', 'aria-pressed': String(on), onclick: fn }, text, h('kbd', {}, key));

async function drawPic(p, { quick = false } = {}) {
  const token = ++drawToken, pic = big.querySelector('.pic');
  if (!pic) return;
  let img;
  try { img = await fullImage(p); } catch { return; } // the preview stays
  if (token !== drawToken || viewList[viewing] !== p) return;
  // while "hold for original" is pressed: the photo as it came from the camera
  const e = editing?.p === p ? (editing.original ? null : editing.e) : (p.edits && tidy(p.edits));
  const r = pic.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  if (!e) {
    const hi = h('img', { class: 'hi', src: img.src, alt: label(p), draggable: 'false' });
    pic.replaceChildren(hi);
    applyZoom();
    return;
  }
  const canvas = h('canvas', { class: 'hi' });
  const cropping = editing?.p === p && editing.cropping;
  const limit = zoomed ? 1e9 : quick ? 1100 : Math.max(r.width, 300) * dpr;
  const { f, s } = drawEdited(canvas, img, e, limit, zoomed ? 1e9 : quick ? 1100 : Math.max(r.height, 200) * dpr, { whole: cropping });
  pic.replaceChildren(canvas);
  applyZoom();
  if (cropping) cropOverlay(pic, canvas, f);
}

// zoom: the wheel zooms towards the pointer, dragging moves around, double-click goes in or back out.
// The picture is scaled in place; an edited picture is drawn again at full size once zoomed in far.
let zoom = { s: 1, x: 0, y: 0 }, dragged = false;
function applyZoom() {
  const pic = big.querySelector('.pic'), el = pic?.querySelector('.hi, .lo:only-child');
  if (!el) return;
  const W = pic.clientWidth, H = pic.clientHeight;
  // never pull the picture's edge inside the frame
  zoom.x = Math.min(0, Math.max(W - W * zoom.s, zoom.x)); zoom.y = Math.min(0, Math.max(H - H * zoom.s, zoom.y));
  el.style.transformOrigin = '0 0';
  el.style.transform = zoom.s === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
  pic.classList.toggle('zoomed', zoom.s > 1);
}
function zoomTo(ev, s) {
  if (editing?.cropping) return;
  const pic = big.querySelector('.pic');
  if (!pic) return;
  s = Math.max(1, Math.min(8, s));
  const r = pic.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
  // the point under the pointer stays under the pointer
  zoom.x = mx - (mx - zoom.x) * (s / zoom.s); zoom.y = my - (my - zoom.y) * (s / zoom.s);
  zoom.s = s;
  if (s === 1) zoom.x = zoom.y = 0;
  applyZoom();
  const want = s > 1.6; // an edited picture: sharper once zoomed in
  if (want !== zoomed && pic.querySelector('canvas')) { zoomed = want; clearTimeout(zoomTo.t); zoomTo.t = setTimeout(() => drawPic(viewList[viewing]), 250); }
  else zoomed = want;
}
big.addEventListener('pointerdown', e => {
  const pic = e.target.closest?.('.pic.zoomed');
  dragged = false;
  if (!pic || e.button !== 0 || e.target.closest('.croplayer')) return;
  e.preventDefault();
  const x = e.clientX, y = e.clientY, zx = zoom.x, zy = zoom.y;
  pic.classList.add('dragging');
  const mv = m => { if (Math.abs(m.clientX - x) + Math.abs(m.clientY - y) > 3) dragged = true; zoom.x = zx + m.clientX - x; zoom.y = zy + m.clientY - y; applyZoom(); };
  addEventListener('pointermove', mv);
  addEventListener('pointerup', () => { removeEventListener('pointermove', mv); pic.classList.remove('dragging'); }, { once: true });
});

// title, description and tags under the photo: all of it shown, the text getting smaller to fit
function captionEl(p) {
  const people = p.tags.map(id => tagLib.find(t => t.id === id)).filter(t => t?.kind === 'person');
  const tags = p.tags.map(id => tagLib.find(t => t.id === id)).filter(t => t?.kind === 'tag');
  const any = p.title || p.description || (showTags && (people.length || tags.length));
  return h('div', { class: 'caption' + (any ? '' : ' empty') },
    p.title ? h('p', { class: 'ctitle' }, p.title) : null,
    p.description ? h('p', { class: 'cdesc' }, p.description) : null,
    showTags && (people.length || tags.length) ? h('p', { class: 'ctags' },
      people.map(t => h('span', { class: 'chipt person' }, t.name)), tags.map(t => h('span', { class: 'chipt' }, `#${t.name}`))) : null);
}
function fitCaption() {
  const c = big.querySelector('.caption');
  if (!c) return;
  const max = Math.max(60, innerHeight * 0.22);
  for (let size = 1; size >= 0.62; size -= 0.04) { c.style.fontSize = `${size}em`; if (c.scrollHeight <= max) return; }
}
addEventListener('resize', () => { if (viewing >= 0) { fitCaption(); drawPic(viewList[viewing]); } });

// what the AI saw: its description (one click to use it) and tags not already on the photo
function aiSuggest(p, desc, saveText, redraw) {
  if (!p.aiDescription && !p.aiTags?.length) return null;
  const have = new Set(p.tags.map(id => tagLib.find(t => t.id === id)?.name.toLowerCase()));
  const extra = (p.aiTags || []).filter(t => !have.has(t));
  const box = h('div', { class: 'aisug' },
    h('p', { class: 'lab' }, 'Suggested by the AI'),
    p.aiDescription ? h('p', { class: 'small' }, p.aiDescription, ' ',
      !p.description ? h('button', { class: 'link', type: 'button', onclick: () => { desc.value = p.aiDescription; saveText(); } }, 'Use as description') : null) : null,
    extra.length ? h('div', { class: 'gpicks' }, extra.map(t => h('button', { class: 'chipt add', type: 'button', title: 'Add this tag', onclick: async e => {
      e.target.disabled = true;
      try { const r = await api('/api/tags/apply', { method: 'POST', body: JSON.stringify({ ids: [p.id], kind: 'tag', name: t }) }); tagLib = r.tags; p.tags = [...new Set([...p.tags, r.id])]; e.target.remove(); redraw(); big.querySelector('.tagbox.k-tag')?.replaceWith(tagBox({ kind: 'tag', ids: [p.id], placeholder: 'Add a tag', onChange: redraw })); }
      catch (err) { toast(err.message, 'bad'); }
    } }, `+ ${t}`)), extra.length > 1 ? h('button', { class: 'link', type: 'button', onclick: () => box.querySelectorAll('.chipt.add').forEach(b => b.click()) }, 'Add all') : null) : null);
  return box;
}

// the details beside the photo
function sideEl(p) {
  const title = h('input', { class: 'fld', value: p.title, maxlength: 140, placeholder: 'Add a title', 'aria-label': 'Title' });
  const desc = h('textarea', { class: 'fld', rows: 3, maxlength: 2000, placeholder: 'Add a description', 'aria-label': 'Description' }, p.description);
  let timer = 0;
  const saveText = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const t = title.value.trim(), d = desc.value.trim();
      if (t === p.title && d === p.description) return;
      try { await api('/api/photo/text', { method: 'POST', body: JSON.stringify({ id: p.id, title: t, description: d }) }); p.title = t; p.description = d; big.querySelector('.caption')?.replaceWith(captionEl(p)); fitCaption(); }
      catch (err) { toast(`Not saved: ${err.message}`, 'bad'); }
    }, 500);
  };
  title.addEventListener('input', saveText); desc.addEventListener('input', saveText);
  const facts = [p.taken && new Date(p.taken).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }), p.camera, p.lens,
    [p.f && `ƒ/${p.f}`, p.shutter, p.iso && `ISO ${p.iso}`].filter(Boolean).join('  '), p.w && `${p.w} × ${p.h} px`].filter(Boolean);
  const pct = v => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
  const redraw = () => { big.querySelector('.caption')?.replaceWith(captionEl(p)); fitCaption(); paintTile(p); };
  return h('aside', { class: 'side' },
    h('label', { class: 'lab' }, 'Title'), title,
    h('label', { class: 'lab' }, 'Description'), desc,
    h('label', { class: 'lab' }, 'People'), tagBox({ kind: 'person', ids: [p.id], placeholder: 'Add a name', onChange: () => { redraw(); toast('The AI will look for them in the rest of this shoot.'); } }),
    h('label', { class: 'lab' }, 'Tags'), tagBox({ kind: 'tag', ids: [p.id], placeholder: 'Add a tag', onChange: redraw }),
    aiSuggest(p, desc, saveText, redraw),
    h('label', { class: 'lab' }, 'Keep or reject'), decisionRow(p),
    p.group ? h('p', { class: 'small' }, `${KIND_ONE[p.kind]}, ${p.at} of ${p.size}. `, p.isPick ? h('b', {}, 'Suggested pick: ') : 'The suggested pick is another frame: ', groups.get(p.group)?.reason || '') : null,
    h('label', { class: 'lab' }, 'Details'),
    h('ul', { class: 'facts2' }, facts.map(f => h('li', {}, f)),
      p.sharpness == null ? h('li', {}, 'Not checked yet') : [
        h('li', {}, `Sharpness ${Math.round(p.sharpness)}${median ? ` (shoot middle ${Math.round(median)})` : ''}`),
        h('li', {}, `Pure white ${pct(p.highs)} · pure black ${pct(p.lows)}`)],
      p.flags.length ? h('li', {}, p.flags.map(f => h('i', { class: `flagi f-${f}` }, FLAG[f]))) : null));
}
function decisionRow(p) {
  const b = (d, text, key) => h('button', { class: `dbtn d-${d}`, type: 'button', 'aria-pressed': String(p.decision === d), onclick: () => one(p, d) }, text, h('kbd', {}, key));
  return h('div', { class: 'row4' },
    b('keep', 'Keep', 'K'), b('reject', 'Reject', 'X'),
    p.decision !== 'undecided' ? b('undecided', 'Undecide', 'U') : null,
    h('span', { class: `sugg s-${p.suggest}` }, `Suggested: ${p.suggest === 'keep' ? 'keep' : 'reject'}${p.group ? '' : ` · ${p.why}`}`),
    album ? h('span', { class: 'albrow' },
      h('button', { class: `dbtn${album.cover === p.id ? ' on' : ''}`, type: 'button', onclick: () => setCover(p) }, 'Album cover', h('kbd', {}, 'C')),
      h('button', { class: `dbtn${album.highlights.includes(p.id) ? ' on' : ''}`, type: 'button', onclick: () => toggleHi(p) }, '★ Highlight', h('kbd', {}, 'H'))) : null);
}
function closeView() {
  if (editing) return cancelEdit();
  if (history.state?.lamhaat === 'view') return history.back(); // closes it, through popstate below
  shut();
}
addEventListener('popstate', () => {
  closeMenu();
  if (editing) { cancelEdit(); history.pushState({ lamhaat: 'view' }, ''); return; } // Back while editing: stop editing, stay on the photo
  if (viewing >= 0) shut();
  else if (!panel.hidden) closeGroup();
});
function shut() {
  big.hidden = true;
  drawToken++;
  if (!panel.hidden) panel.querySelectorAll('.gcell')[viewing]?.focus();
  else main.querySelector(`.cell[data-id="${viewList[viewing]?.id}"]`)?.focus();
  viewing = -1;
}
big.addEventListener('contextmenu', e => { if (e.target.closest('.pic') && !editing) openMenu(e, viewList[viewing], { single: true }); });
big.addEventListener('click', e => { if (dragged) { dragged = false; return; } if (e.target === big || e.target.classList.contains('stage')) closeView(); });
// a tile shows the photo's edited look and tags as soon as they change
function paintTile(p) {
  for (const img of document.querySelectorAll(`[data-id="${p.id}"] img`)) if (!img.closest('.hichip')) img.src = thumb(p);
  for (const cell of main.querySelectorAll(`.cell[data-id="${p.id}"]`)) cell.querySelector('.ttags')?.replaceWith(tileTags(p));
}

// ---------- tags and people: one library, a box that suggests as you type ----------
let tagLib = [];
const loadTags = async () => { tagLib = (await api('/api/tags')).tags; };
// kind: 'tag' or 'person'. ids: the photos it adds to (filter mode: picks tags for a filter instead)
function tagBox({ kind, ids = [], placeholder, onChange = () => {}, filter = null }) {
  const box = h('div', { class: `tagbox k-${kind}` });
  const input = h('input', { class: 'tagin', placeholder, autocomplete: 'off', spellcheck: 'false', 'aria-label': placeholder, role: 'combobox', 'aria-expanded': 'false' });
  const list = h('ul', { class: 'tagdrop', role: 'listbox', hidden: true });
  let active = 0, opts = [];
  const have = () => filter ? [...filter.set] : [...new Set(ids.flatMap(id => byId.get(id)?.tags || []))];
  const name = id => tagLib.find(t => t.id === id);
  const isAuto = t => !filter && ids.length === 1 && (byId.get(ids[0])?.autoTags || []).includes(t.id);
  const chips = () => have().map(name).filter(t => t?.kind === kind).map(t =>
    h('span', { class: `chipt${kind === 'person' ? ' person' : ''}${isAuto(t) ? ' auto' : ''}`, title: isAuto(t) ? 'Tagged by the AI. Remove it if it isn’t them; it won’t tag this photo with them again.' : null }, kind === 'tag' ? `#${t.name}` : t.name, isAuto(t) ? h('small', {}, 'auto') : null,
      h('button', { type: 'button', 'aria-label': `Remove ${t.name}`, onclick: () => (filter ? (filter.set.delete(t.id), filter.changed()) : apply({ tagId: t.id, remove: true })) }, '×')));
  const draw = () => box.replaceChildren(...chips(), input, list);
  async function apply(change, { record = true, on = ids } = {}) {
    try {
      const r = await api('/api/tags/apply', { method: 'POST', body: JSON.stringify({ ids: on, kind, ...change }) });
      tagLib = r.tags;
      const had = on.filter(id => byId.get(id)?.tags.includes(r.id));
      for (const id of on) {
        const p = byId.get(id);
        if (!p) continue;
        p.tags = change.remove ? p.tags.filter(t => t !== r.id) : [...new Set([...p.tags, r.id])];
        p.autoTags = (p.autoTags || []).filter(t => t !== r.id);
      }
      draw(); if (box.isConnected) input.focus(); onChange();
      // undo: put it back on the photos that had it, or take it off the ones that didn't
      const name = tagLib.find(t => t.id === r.id)?.name || '';
      const back = change.remove ? had : on.filter(id => !had.includes(id));
      if (record && back.length) remember2(`${change.remove ? 'removing' : 'adding'} ${name}`, async () => {
        await apply({ tagId: r.id, remove: !change.remove, undo: true }, { record: false, on: back });
        for (const id of back) paintTile(byId.get(id));
      });
    } catch (err) { toast(err.message, 'bad'); }
  }
  const choose = o => {
    input.value = ''; close();
    if (filter) { filter.set.add(o.id); filter.changed(); draw(); return; }
    apply(o.id ? { tagId: o.id } : { name: o.name });
  };
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  const open = () => {
    const q = input.value.trim().toLowerCase(), mine = new Set(have());
    opts = tagLib.filter(t => t.kind === kind && !mine.has(t.id) && t.name.toLowerCase().includes(q))
      .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || b.n - a.n || a.name.localeCompare(b.name)).slice(0, 8);
    // names you already have come first; a new one is offered last (arrow down to it)
    if (!filter && q && !tagLib.some(t => t.kind === kind && t.name.toLowerCase() === q)) opts.push({ name: input.value.trim(), isNew: true });
    active = 0;
    list.replaceChildren(...opts.map((o, i) => h('li', { role: 'option', class: i === active ? 'on' : '', onmousedown: e => { e.preventDefault(); choose(o); } },
      o.isNew ? h('span', {}, `Add new ${kind === 'person' ? 'person' : 'tag'}: `, h('b', {}, o.name)) : h('span', {}, o.name, h('small', {}, ` ${o.n}`)))));
    list.hidden = !opts.length; input.setAttribute('aria-expanded', String(!list.hidden));
  };
  input.addEventListener('input', open);
  input.addEventListener('focus', open);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) open();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % Math.max(1, opts.length);
      [...list.children].forEach((li, i) => li.classList.toggle('on', i === active));
    } else if ((e.key === 'Enter' || e.key === ',' || e.key === 'Tab') && input.value.trim()) {
      e.preventDefault();
      choose(opts[active] || (filter ? null : { name: input.value.trim() }) || {});
    } else if (e.key === 'Backspace' && !input.value) {
      const last = have().map(name).filter(t => t?.kind === kind).at(-1);
      if (last) filter ? (filter.set.delete(last.id), filter.changed(), draw()) : apply({ tagId: last.id, remove: true });
    } else if (e.key === 'Escape') { if (!list.hidden) { e.stopPropagation(); close(); } else input.blur(); }
  });
  draw();
  return box;
}
// a tile's people and tags, when tags are shown
function tileTags(p) {
  const ts = showTags ? p.tags.map(id => tagLib.find(t => t.id === id)).filter(Boolean) : [];
  return h('span', { class: 'ttags' }, ts.slice(0, 3).map(t => h('i', { class: t.kind === 'person' ? 'person' : '' }, t.kind === 'tag' ? `#${t.name}` : t.name)), ts.length > 3 ? h('i', {}, `+${ts.length - 3}`) : null);
}

// ---------- editing: light, colour, crop and turn; the original is never changed ----------
function startEdit(p) {
  if (editing) return;
  editing = { p, e: { ...NONE, ...(tidy(p.edits) || {}) }, start: JSON.stringify(tidy(p.edits)), cropping: false, aspect: null };
  zoomed = false; zoom = { s: 1, x: 0, y: 0 }; // editing starts from the whole picture
  big.querySelector('.viewer').classList.add('editing', 'with-side');
  big.querySelector('.side')?.remove();
  big.querySelector('.viewer').append(editSide());
  big.querySelectorAll('.nav').forEach(b => b.disabled = true);
  drawPic(p);
}
function editSide() {
  const ed = editing, e = ed.e;
  let quickTimer = 0;
  const changed = () => { drawPic(ed.p, { quick: true }); clearTimeout(quickTimer); quickTimer = setTimeout(() => drawPic(ed.p), 220); };
  const slider = ([k, label, lo = -100, hi = 100]) => {
    const val = h('span', { class: 'sv' }, e[k]);
    const r = h('input', { type: 'range', min: lo, max: hi, step: 1, value: e[k], 'aria-label': label,
      oninput: ev => { e[k] = Number(ev.target.value); val.textContent = e[k]; changed(); },
      ondblclick: ev => { e[k] = 0; ev.target.value = 0; val.textContent = 0; changed(); } });
    return h('div', { class: 'srow' }, h('span', { class: 'sl' }, label), val, r);
  };
  const group = (title, ...kids) => h('section', { class: 'eg' }, h('h4', {}, title), ...kids);
  const btn = (text, fn, on) => h('button', { class: `ebtn${on ? ' on' : ''}`, type: 'button', onclick: fn }, text);
  const straight = slider(['straighten', 'Straighten', -45, 45]);
  straight.querySelector('input').step = 0.1;
  const aspects = [['Free', null], ['Original', 'orig'], ['Square', 1], ['4:5', 4 / 5], ['3:2', 3 / 2], ['16:9', 16 / 9]];
  const redrawSide = () => big.querySelector('.side.edit')?.replaceWith(editSide());
  return h('aside', { class: 'side edit' },
    h('div', { class: 'erow top' },
      h('button', { class: 'btn small', type: 'button', onclick: cancelEdit }, 'Cancel'),
      h('button', { class: 'ebtn', type: 'button', title: 'Hold to see the original',
        onpointerdown: e => { e.currentTarget.setPointerCapture?.(e.pointerId); ed.original = true; drawPic(ed.p); },
        onpointerup: () => { ed.original = false; drawPic(ed.p); }, onpointercancel: () => { ed.original = false; drawPic(ed.p); },
        onkeydown: e => { if ((e.key === ' ' || e.key === 'Enter') && !ed.original) { ed.original = true; drawPic(ed.p); } },
        onkeyup: () => { if (ed.original) { ed.original = false; drawPic(ed.p); } } }, 'Hold for original'),
      h('button', { class: 'btn small primary', type: 'button', onclick: saveEdit }, 'Done')),
    group('Crop and turn',
      h('div', { class: 'erow' },
        btn(ed.cropping ? 'Finish crop' : 'Crop', () => { ed.cropping = !ed.cropping; zoom = { s: 1, x: 0, y: 0 }; zoomed = false; redrawSide(); drawPic(ed.p); }, ed.cropping),
        btn('↺ Turn', () => { e.turn = (e.turn + 270) % 360; e.crop = null; changed(); }),
        btn('↻ Turn', () => { e.turn = (e.turn + 90) % 360; e.crop = null; changed(); }),
        btn('⇋ Flip', () => { e.flipH = !e.flipH; changed(); }),
        btn('⇵ Flip', () => { e.flipV = !e.flipV; changed(); })),
      ed.cropping ? h('div', { class: 'erow' }, aspects.map(([t, a]) => btn(t, () => { ed.aspect = a; fitAspect(); redrawSide(); drawPic(ed.p); }, ed.aspect === a))) : null,
      straight),
    group('Light', ...SLIDERS.slice(0, 6).map(slider)),
    group('Colour', ...SLIDERS.slice(6, 10).map(slider),
      h('label', { class: 'srow chk' }, h('input', { type: 'checkbox', checked: e.bw, onchange: ev => { e.bw = ev.target.checked; changed(); } }), 'Black and white')),
    group('Detail', ...SLIDERS.slice(10).map(slider)),
    h('div', { class: 'erow' }, h('button', { class: 'link', type: 'button', onclick: () => { editing.e = { ...NONE }; redrawSide(); drawPic(ed.p); } }, 'Reset everything')),
    h('p', { class: 'hint' }, 'Double-click a slider to reset it. Your original file is never changed.'));
}
// keep the crop to the chosen shape, as big as fits, centred where it was
async function fitAspect() {
  const ed = editing, img = await fullImage(ed.p), f = frame(ed.e, img.naturalWidth, img.naturalHeight);
  if (!ed.aspect) return;
  const want = ed.aspect === 'orig' ? f.W / f.H : ed.aspect;
  const c = ed.e.crop || { x: 0, y: 0, w: 1, h: 1 };
  let w = c.w * f.fw, hh = c.h * f.fh;
  if (w / hh > want) w = hh * want; else hh = w / want;
  const cx = (c.x + c.w / 2) * f.fw, cy = (c.y + c.h / 2) * f.fh;
  const x = Math.max(0, Math.min(f.fw - w, cx - w / 2)), y = Math.max(0, Math.min(f.fh - hh, cy - hh / 2));
  ed.e.crop = { x: x / f.fw, y: y / f.fh, w: w / f.fw, h: hh / f.fh };
}
// the crop box over the whole picture: drag it, or drag a corner
function cropOverlay(pic, canvas, f) {
  const ed = editing;
  const c = () => ed.e.crop || { x: 0, y: 0, w: 1, h: 1 };
  const boxEl = h('div', { class: 'cropbox' }, ...['nw', 'ne', 'sw', 'se'].map(k => h('span', { class: `hdl ${k}`, 'data-h': k })));
  const layer = h('div', { class: 'croplayer' }, boxEl);
  pic.append(layer);
  const place = () => {
    // the picture as drawn: the canvas is shrunk to fit, so its box can be wider or taller than the picture
    const box = canvas.getBoundingClientRect(), pr = pic.getBoundingClientRect(), k = c();
    const sc = Math.min(box.width / canvas.width, box.height / canvas.height), w = canvas.width * sc, hh = canvas.height * sc;
    const r = { left: box.left + (box.width - w) / 2, top: box.top + (box.height - hh) / 2, width: w, height: hh };
    Object.assign(layer.style, { left: `${r.left - pr.left}px`, top: `${r.top - pr.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    Object.assign(boxEl.style, { left: `${k.x * 100}%`, top: `${k.y * 100}%`, width: `${k.w * 100}%`, height: `${k.h * 100}%` });
  };
  requestAnimationFrame(place);
  boxEl.addEventListener('pointerdown', ev => {
    ev.preventDefault(); ev.stopPropagation();
    const r = layer.getBoundingClientRect(), start = { ...c() }, x0 = ev.clientX, y0 = ev.clientY, hdl = ev.target.dataset.h;
    const want = ed.aspect ? (ed.aspect === 'orig' ? f.W / f.H : ed.aspect) * f.fh / f.fw : null; // in fractions
    const mv = m => {
      const dx = (m.clientX - x0) / r.width, dy = (m.clientY - y0) / r.height;
      let { x, y, w, h: hh } = start;
      if (!hdl) { x = Math.max(0, Math.min(1 - w, x + dx)); y = Math.max(0, Math.min(1 - hh, y + dy)); }
      else {
        if (hdl.includes('w')) { x = Math.max(0, Math.min(start.x + start.w - 0.05, x + dx)); w = start.x + start.w - x; }
        if (hdl.includes('e')) w = Math.max(0.05, Math.min(1 - x, w + dx));
        if (hdl.includes('n')) { y = Math.max(0, Math.min(start.y + start.h - 0.05, y + dy)); hh = start.y + start.h - y; }
        if (hdl.includes('s')) hh = Math.max(0.05, Math.min(1 - y, hh + dy));
        if (want) { // keep the shape: width leads, height follows (and the top edge, if dragged)
          const nh = Math.min(w / want, hdl.includes('n') ? start.y + start.h : 1 - y);
          if (hdl.includes('n')) y = start.y + start.h - nh;
          hh = nh; w = hh * want;
          if (hdl.includes('w')) x = start.x + start.w - w;
        }
      }
      ed.e.crop = { x, y, w, h: hh };
      place();
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', () => removeEventListener('pointermove', mv), { once: true });
  });
}
async function saveEdit() {
  const ed = editing, e = tidy(ed.e);
  if (JSON.stringify(e) === ed.start) return endEdit();
  try {
    const before = ed.p.edits;
    await setEdits(ed.p, e);
    remember2(`editing ${label(ed.p)}`, () => setEdits(ed.p, before));
    toast(ed.p.edits ? 'Edit saved. The original file is unchanged.  Ctrl+Z to undo.' : 'Back to the original.', 'good');
    endEdit();
  } catch (err) { toast(`Not saved: ${err.message}`, 'bad'); }
}
async function setEdits(p, edits) {
  const r = await api('/api/photo/edits', { method: 'POST', body: JSON.stringify({ id: p.id, edits }) });
  p.edits = r.edits;
  p.ev = r.edits ? (await sha1(JSON.stringify(r.edits))).slice(0, 10) : null;
  paintTile(p);
  if (viewing >= 0 && viewList[viewing] === p && !editing) drawPic(p);
}
const sha1 = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
function cancelEdit() { endEdit(); }
function endEdit() { const p = editing.p; editing = null; view(viewList.indexOf(p)); }


// ---------- the keyboard: arrows move, K keep, X reject, U undecided, G group, Ctrl+Z undo ----------
const cols = el => getComputedStyle(el).gridTemplateColumns.split(' ').length;
function move(cells, i, d) {
  const j = Math.max(0, Math.min(cells.length - 1, i < 0 ? 0 : i + d));
  cells[j]?.focus({ preventScroll: true });
  cells[j]?.scrollIntoView({ block: 'nearest' });
}
const ARROW = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 'up', ArrowDown: 'down' };
addEventListener('keydown', e => {
  if (!menu.hidden) { // the right-click menu: arrows move, Esc closes
    const items = [...menu.querySelectorAll('button')], at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    return;
  }
  if (dialog.open) return; // a dialog handles its own keys (Esc closes it)
  if (e.target.closest?.('input, select, textarea')) return;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === 'z') { e.preventDefault(); undoLast(); return; }
  if ((e.ctrlKey || e.metaKey) && key === 'a' && viewing < 0 && (mode === 'review' || mode === 'album') && !onPeople && !onSettings) {
    e.preventDefault(); (mode === 'album' ? inAlbum(all) : photos).forEach(p => picked.add(p.id)); return drawPicked();
  }
  if (e.key === 'Backspace' && viewing >= 0 && !editing) { e.preventDefault(); return closeView(); } // back, like a browser
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat && 'kxu'.includes(key)) return;
  const verdict = { k: 'keep', x: 'reject', u: 'undecided' }[key];

  if (editing) { if (e.key === 'Escape') cancelEdit(); return; }
  if (viewing >= 0) { // one photo, large: deciding moves on to the next
    const p = viewList[viewing];
    if (e.key === 'Escape') closeView();
    else if (key === 'e') startEdit(p);
    else if (key === 'i') { showInfo = !showInfo; remember('showInfo', showInfo); view(viewing); }
    else if (key === 't') { showTags = !showTags; remember('showTags', showTags); view(viewing); drawGrid(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); view(viewing + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); view(viewing - 1); }
    else if (verdict) { one(p, verdict); if (verdict !== 'undecided' && viewing < viewList.length - 1) view(viewing + 1); }
    else if (key === 'g' && p.group && panel.hidden) { closeView(); openGroup(p.group); }
    else if (key === 'c') setCover(p);
    else if (key === 'h') toggleHi(p);
    return;
  }
  if (!panel.hidden && e.key === 'Escape') return closeGroup();
  if (e.key === 'Escape' && picked.size) return clearPicked(); // Esc lets go of every picked photo, anywhere
  if (onPeople || onSettings) return;
  if (mode === 'album' && panel.hidden) return albumKeys(e, key);
  const area = !panel.hidden ? panel.querySelector('.gstrip') : main.querySelector('.grid');
  if (!area) return;
  if (panel.hidden && picked.size && verdict) { decide([...picked].map(id => ({ id, decision: verdict })), { note: true }); return; }
  const cells = [...area.children], i = cells.indexOf(document.activeElement);
  if (e.key in ARROW) {
    e.preventDefault(); mouseLast = false;
    const d = ARROW[e.key];
    return move(cells, i, d === 'up' ? -cols(area) : d === 'down' ? cols(area) : d);
  }
  const p = keyTarget(cells, i);
  if (!p) return;
  const onHover = mouseLast && hoverEl?.isConnected;
  if (e.key === 'Enter' && onHover) openPhoto(p);
  else if (verdict) {
    // on a stack, K keeps the suggested frame and rejects the rest; X rejects them all
    if (panel.hidden && asStack(p)) decideGroup(p.group, verdict === 'keep' ? 'suggest' : verdict);
    else one(p, verdict);
    if (verdict !== 'undecided' && !onHover) move(cells, i, 1);
  } else if (key === 'g' && p.group && panel.hidden) openGroup(p.group);
  else if (key === 'c') setCover(p);
  else if (key === 'h') toggleHi(p);
});

// ---------- the album: title, chapters, cover, highlights ----------
let album = null, albumSaved = false, mode = 'review', saveTimer = 0;
try { const m = localStorage.getItem('mode'); if (m === 'album' || m === 'publish') mode = m; } catch {}
function setMode(m) {
  mode = m; picked.clear(); drawPicked();
  try { localStorage.setItem('mode', m); } catch {}
  drawShoot();
}
const ROMAN = n => [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']].reduce((s, [v, r]) => { while (n >= v) { s += r; n -= v; } return s; }, '');
const span = ps => {
  const t = ps.map(p => p.taken).filter(Boolean);
  if (!t.length) return 'no dates';
  const f = iso => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const a = f(t[0]), b = f(t.at(-1));
  return a === b ? a : `${a} – ${day(t[0]) === day(t.at(-1)) ? new Date(t.at(-1)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : b}`;
};

// tiles are kept per photo and moved between chapters, so their images never load twice
const tiles = new Map();
function tile(p, first) {
  let t = tiles.get(p.id);
  if (!t) {
    t = h('div', { class: 'atile', 'data-id': p.id },
      h('button', { class: 'aimg', type: 'button', 'aria-label': label(p), onclick: e => { if (picked.size || e.ctrlKey || e.metaKey) return togglePick(p.id); const list = inAlbum(all); view(list.indexOf(p), list); } },
        h('img', { src: thumb(p), alt: '', loading: 'lazy', decoding: 'async', onload: e => e.target.classList.add('in') })),
      h('span', { class: 'amark' }),
      h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'),
      h('div', { class: 'aact' },
        h('button', { type: 'button', title: 'Make this the album cover (C)', onclick: () => setCover(p) }, 'Cover'),
        h('button', { type: 'button', class: 'hi', title: 'Highlight (H)', onclick: () => toggleHi(p) }, '★'),
        p.taken ? h('button', { type: 'button', class: 'sp', title: 'Start a new chapter from this photo (S)', onclick: () => splitAt(p) }, 'Split here') : null));
    tiles.set(p.id, t);
  }
  const cover = album.cover === p.id, hi = album.highlights.includes(p.id);
  t.classList.toggle('is-cover', cover);
  t.classList.toggle('is-hi', hi);
  t.classList.toggle('first', first);
  t.classList.toggle('sel', picked.has(p.id));
  t.querySelector('.amark').textContent = [cover && 'Cover', hi && '★'].filter(Boolean).join('  ');
  return t;
}

function drawAlbum() {
  const box = main.querySelector('.album');
  if (!box || !album) return;
  const list = inAlbum(all);
  album = clean(album, list);
  const byDate = album.groupBy === 'date';
  box.classList.toggle('keyed', !byDate); // splitting by hand only makes sense by date
  const parts = assign(album, list, new Map(tagLib.map(t => [t.id, t]))), cover = byId.get(album.cover);
  // chapter names: by date they belong to the chapter; by person, tag or camera, to that name
  const byRules = album.groupBy === 'rules';
  const setName = (c, i, field, v) => { if (byRules) { if (album.rules?.[i]) album.rules[i][field] = v; else album.rest = { ...album.rest, title: c.title, sub: c.sub, [field]: v }; albumSaved = true; save(500); return; } if (byDate) album.chapters[i][field] = v; else { const k = c.key ?? ''; album.names = { ...album.names, [k]: { title: c.title, sub: c.sub, ...album.names?.[k], [field]: v } }; } albumSaved = true; save(500); };
  const open = all.filter(p => p.decision === 'undecided').length;
  const focused = document.activeElement;
  const hiChip = (id, i) => {
    const p = byId.get(id);
    return h('div', { class: 'hichip' },
      h('button', { class: 'hiimg', type: 'button', title: label(p), onclick: () => view(list.indexOf(p), list) }, h('img', { src: thumb(p), alt: '' })),
      h('div', { class: 'hibtns' },
        h('button', { type: 'button', 'aria-label': 'Earlier', disabled: i === 0, onclick: () => moveHi(i, -1) }, '‹'),
        h('button', { type: 'button', 'aria-label': 'Remove highlight', onclick: () => toggleHi(p) }, '×'),
        h('button', { type: 'button', 'aria-label': 'Later', disabled: i === album.highlights.length - 1, onclick: () => moveHi(i, 1) }, '›')));
  };
  box.replaceChildren(
    h('section', { class: 'ahead' },
      h('button', { class: 'acover', type: 'button', title: 'The album cover. Press C on any photo to change it.', onclick: () => cover && view(list.indexOf(cover), list) },
        cover ? h('img', { src: thumb(cover), alt: '' }) : h('span', {}, 'No photos'), h('span', { class: 'clabel' }, 'Cover')),
      h('div', { class: 'ameta' },
        h('input', { class: 'atitle', value: album.title, maxlength: 120, placeholder: 'Album title', 'aria-label': 'Album title', oninput: e => { album.title = e.target.value; albumSaved = true; save(500); } }),
        h('textarea', { class: 'adesc', rows: 2, maxlength: 2000, placeholder: 'A few words about this album (optional)', 'aria-label': 'Album description', oninput: e => { album.description = e.target.value; albumSaved = true; save(600); } }, album.description || ''),
        h('div', { class: 'arrange' },
          h('label', { class: 'sort' }, 'Chapters by ', h('select', { onchange: e => change({ ...album, groupBy: e.target.value }, { what: 'chapters by ' + GROUPS[e.target.value].toLowerCase() }) },
            Object.entries(GROUPS).map(([v, t]) => h('option', { value: v, selected: album.groupBy === v }, t)))),
          h('label', { class: 'sort' }, 'Photos in order ', h('select', { onchange: e => change({ ...album, sort: e.target.value }, { what: 'photo order' }) },
            Object.entries(SORTS).map(([v, t]) => h('option', { value: v, selected: album.sort === v }, t)))),
          sizeSlider()),
        album.groupBy === 'place' && !list.some(p => Number.isFinite(p.lat)) ? h('p', { class: 'note' }, 'No GPS positions known for these photos. Phones usually record them; most cameras don’t.  ',
          h('button', { class: 'link', type: 'button', onclick: () => api('/api/reprocess', { method: 'POST', body: JSON.stringify({ folder: selected, what: { details: true } }) }).then(() => toast('Reading the files again for their positions…', 'good'), err => toast(err.message, 'bad')) }, 'Read them from the files')) : null,
        h('p', { class: 'facts' }, `${plural(list.length, 'photo')}  ·  ${plural(parts.filter(c => c.photos.length).length, 'chapter')}  ·  ${plural(album.highlights.length, 'highlight')}`, h('span', { class: 'saved' })),
        album.id && !albumSaved ? h('p', { class: 'note warn' }, 'Already on GitHub, arranged before this app: its titles, tags, chapters and highlights are only there. Bring them in before changing anything here, or this page’s version replaces them on the next publish.  ',
          h('button', { class: 'link', type: 'button', onclick: async e => {
            e.target.disabled = true;
            try { const r = await api('/api/album/adopt', { method: 'POST', body: JSON.stringify({ folder: selected }) }); toast(`Brought in ${plural(r.matched, 'photo')}’s words and ${plural(r.chapters, 'chapter')} from GitHub.`, 'good'); await loadTags(); await drawShoot(); }
            catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
          } }, 'Bring them into Lamhaat')) : null,
        open ? h('p', { class: 'note' }, `Includes ${plural(open, 'photo')} you haven’t reviewed yet. Rejected photos are never in the album.`) : null,
        h('p', { class: 'label2' }, 'Highlights'),
        h('div', { class: 'hirow' }, album.highlights.length ? album.highlights.map(hiChip)
          : h('p', { class: 'hint' }, 'None yet. Highlights are the photos the album opens with on the site. Press H on a photo, or its ★, to add one.')),
        h('p', { class: 'hint' }, `On a photo:  C cover  ·  H highlight${byDate ? '  ·  S new chapter from here' : ''}  ·  Enter view large`))),
    ...parts.map((c, i) => h('section', { class: 'chap' },
      h('header', {},
        h('span', { class: 'roman' }, ROMAN(i + 1)),
        h('div', { class: 'cfields' },
          h('input', { class: 'ctitle', value: c.title, maxlength: 120, placeholder: parts.length === 1 ? 'Chapter title (optional)' : 'Chapter title', 'aria-label': `Chapter ${i + 1} title`, oninput: e => setName(c, i, 'title', e.target.value) }),
          h('input', { class: 'csub', value: c.sub, maxlength: 200, placeholder: 'A line under the title (optional)', 'aria-label': `Chapter ${i + 1} subtitle`, oninput: e => setName(c, i, 'sub', e.target.value) }),
          // your own chapters: the tags that bring a photo in (the first chapter that fits wins)
          byRules && album.rules?.[i] ? h('input', { class: 'csub ctags', value: album.rules[i].tags.join(', '), placeholder: 'Tags that bring photos in, e.g. chicago, city', 'aria-label': `Chapter ${i + 1} tags`,
            onchange: e => change({ ...album, rules: album.rules.map((r, k) => k === i ? { ...r, tags: e.target.value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) } : r) }, { what: 'chapter tags' }) }) : null),
        h('div', { class: 'cside' },
          h('span', { class: 'crange' }, `${span(c.photos)}  ·  ${plural(c.photos.length, 'photo')}`),
          byDate && i > 0 ? h('button', { class: 'btn small', type: 'button', onclick: () => change(merge(album, i), { what: 'merging chapters' }) }, 'Merge with previous') : null,
          byRules && album.rules?.[i] ? h('button', { class: 'btn small', type: 'button', onclick: () => change({ ...album, rules: album.rules.filter((_, k) => k !== i) }, { what: 'removing a chapter' }) }, 'Remove chapter') : null)),
      c.photos.length ? h('div', { class: 'astrip' }, c.photos.map((p, j) => tile(p, j === 0)))
        : h('p', { class: 'hint' }, byRules ? 'No photos have these tags yet.' : 'No photos in this chapter. Merge it with the previous one.'))),
    byRules ? h('div', { class: 'row addchap' }, h('button', { class: 'btn small', type: 'button', onclick: () => change({ ...album, rules: [...(album.rules || []), { title: 'New chapter', sub: '', tags: [] }] }, { what: 'adding a chapter' }) }, '+ Add a chapter')) : null);
  if (focused?.isConnected && focused !== document.activeElement) focused.focus({ preventScroll: true });
}

function change(next, { then, what = 'album change' } = {}) {
  const prev = album, wasSaved = albumSaved;
  remember2(what, () => { album = prev; albumSaved = wasSaved; save(0); if (mode === 'album') drawAlbum(); if (viewing >= 0) big.querySelector('.row4')?.replaceWith(decisionRow(viewList[viewing])); });
  album = next; albumSaved = true;
  save(0);
  drawAlbum();
  if (viewing >= 0) big.querySelector('.row4')?.replaceWith(decisionRow(viewList[viewing]));
  then?.();
}
function save(delay) {
  clearTimeout(saveTimer);
  const folder = selected, mark = main.querySelector('.album .saved');
  if (mark) mark.textContent = '  ·  saving…';
  saveTimer = setTimeout(async () => {
    try {
      await api('/api/album', { method: 'PUT', body: JSON.stringify({ folder, album }) });
      const m = main.querySelector('.album .saved');
      if (m && folder === selected) m.textContent = '  ·  saved';
    } catch (err) { toast(`Album not saved: ${err.message}`, 'bad'); }
  }, delay);
}
const inIt = p => { if (p.decision !== 'reject') return true; toast('Rejected photos aren’t in the album. Keep it first (K).'); return false; };
const setCover = p => inIt(p) && change({ ...album, cover: p.id }, { what: 'new cover' });
const toggleHi = p => inIt(p) && change({ ...album, highlights: album.highlights.includes(p.id) ? album.highlights.filter(x => x !== p.id) : [...album.highlights, p.id] }, { what: 'highlight' });
function moveHi(i, d) {
  const hs = [...album.highlights];
  [hs[i], hs[i + d]] = [hs[i + d], hs[i]];
  change({ ...album, highlights: hs }, { what: 'highlight order' });
}
function splitAt(p) {
  const next = split(album, p);
  if (next === album) return toast(p.taken ? 'A chapter already starts here.' : 'This photo has no date, so it can’t start a chapter.');
  // then name the new chapter straight away
  change(next, { what: 'new chapter', then: () => { const input = [...main.querySelectorAll('.chap')].find(c => c.contains(tiles.get(p.id)))?.querySelector('.ctitle'); input?.focus(); input?.select(); } });
}
function albumKeys(e, key) {
  const cells = [...main.querySelectorAll('.album .aimg')], i = cells.indexOf(document.activeElement);
  if (e.key in ARROW) {
    if (i < 0 && e.target !== document.body) return; // arrows on a button or link keep their usual job
    e.preventDefault(); mouseLast = false;
    const d = ARROW[e.key], strip = cells[i]?.closest('.astrip');
    return move(cells, i, typeof d === 'number' ? d : (d === 'up' ? -1 : 1) * (strip ? cols(strip) : 1));
  }
  const verdict = { k: 'keep', x: 'reject', u: 'undecided' }[key];
  if (picked.size && verdict) return decide([...picked].map(id => ({ id, decision: verdict })), { note: true }); // X takes them out of the album
  const p = keyTarget(cells, i);
  if (!p) return;
  if (e.key === 'Enter' && mouseLast && hoverEl?.isConnected) openPhoto(p);
  else if (key === 'c') setCover(p);
  else if (key === 'h') toggleHi(p);
  else if (key === 's' && album.groupBy === 'date') { e.preventDefault(); splitAt(p); } // or the "s" lands in the new chapter's name
  else if (verdict) one(p, verdict);
}

// ---------- publishing to GitHub ----------
let gh = { account: null, ready: {} }, pubRun = null, signingIn = null, webWaiting = null, ghHost = 'github.com';
try { ghHost = localStorage.getItem('ghHost') || 'github.com'; } catch {}
const MARK = { waiting: '○', running: '◌', done: '✓', skipped: '–', failed: '✕' };

async function drawPublish() {
  const box = main.querySelector('.publish');
  if (!box) return;
  const folder = selected;
  const [g, r, ppl] = await Promise.all([api(`/api/github?host=${encodeURIComponent(ghHost)}`), api(`/api/publish?folder=${encodeURIComponent(folder)}`), api('/api/people')]);
  if (folder !== selected || !main.contains(box)) return;
  gh = g; pubRun = r.run;
  if (g.pending && !signingIn) signingIn = g.pending;
  const open = all.filter(p => p.decision === 'undecided').length, count = inAlbum(all).length;
  const ready = gh.account && !open && count;
  box.replaceChildren(...[
    h('section', { class: 'pcard' }, h('h2', {}, 'GitHub account'), gh.account ? signedIn() : signInOptions()),
    h('section', { class: 'pcard' }, h('h2', {}, 'Who can see this album'),
      h('div', { class: 'vis', role: 'radiogroup' },
        [[true, 'Public', 'On your site, for anyone with the link. Stored unencrypted.'],
         [false, 'Private', 'Only in your private GitHub repositories, encrypted. Only the people you choose (below) can open it on your site, after signing in with Google.']]
          .map(([v, t, d]) => h('label', { class: 'vopt' },
            h('input', { type: 'radio', name: 'vis', checked: !!album?.public === v, onchange: () => setVisibility(v) }),
            h('span', {}, h('b', {}, t), h('small', {}, d))))),
      !album?.public ? h('div', { class: 'whosees' },
        h('p', { class: 'lab' }, 'Private: who can see it'),
        h('div', { class: 'gpicks' }, ['everyone', ...ppl.groups].map(gr => h('label', { class: 'gpick' },
          h('input', { type: 'checkbox', checked: (album?.groups || []).includes(gr), onchange: async e => {
            const gs = e.target.checked ? [...new Set([...(album.groups || []), gr])] : (album.groups || []).filter(x => x !== gr);
            try { await api('/api/album/visibility', { method: 'POST', body: JSON.stringify({ folder: selected, groups: gs }) }); album = { ...album, groups: gs }; }
            catch (err) { toast(err.message, 'bad'); }
          } }), gr === 'everyone' ? 'Anyone signed in with Google' : `${groupName(gr)} (${ppl.people.filter(x => x.groups.includes(gr)).length})`))),
        h('p', { class: 'hint' }, 'You always see it. Add people and groups under People & sharing. Changes apply on the next publish.')) : null,
      album?.id ? h('p', { class: 'hint' }, `On GitHub as lamha-a-${album.id}-media. Changing this applies on the next publish.`) : null),
    all.some(p => Number.isFinite(p.lat)) ? h('section', { class: 'pcard' }, h('h2', {}, 'Map'),
      h('label', { class: 'opt' }, h('input', { type: 'checkbox', checked: album?.geo === true, onchange: async e => {
        try { await api('/api/album/visibility', { method: 'POST', body: JSON.stringify({ folder: selected, geo: e.target.checked }) }); album = { ...album, geo: e.target.checked }; }
        catch (err) { toast(err.message, 'bad'); }
      } }), h('span', {}, h('b', {}, 'Show where photos were taken, on a map on the site'),
        h('small', {}, `${plural(all.filter(p => Number.isFinite(p.lat)).length, 'photo')} here know their place. Only rounded to about 1 km, so no exact address is shown. Off unless you turn it on.`)))) : null,
    h('section', { class: 'pcard' }, h('h2', {}, 'Full size'),
      h('label', { class: 'opt' }, h('input', { type: 'checkbox', checked: album?.full !== false, onchange: async e => {
        try { await api('/api/album/visibility', { method: 'POST', body: JSON.stringify({ folder: selected, full: e.target.checked }) }); album = { ...album, full: e.target.checked }; }
        catch (err) { toast(err.message, 'bad'); }
      } }), h('span', {}, h('b', {}, 'Show each photo at its full size when it is opened on the site'),
        h('small', {}, `Uploads up to ${gb(inAlbum(all).reduce((s, p) => s + (p.size || 0), 0))} the first time (photos already up aren’t sent again). Kept in public repositories lamha-full-1, -2…, under 1 GB each. The camera’s hidden details, like where it was taken, are left out.`)))),
    h('section', { class: 'pcard' }, h('h2', {}, 'Publish'),
      h('ul', { class: 'checks' },
        h('li', { class: gh.account ? 'ok' : '' }, gh.account ? `Signed in as ${gh.account.login}` : 'Sign in to GitHub'),
        h('li', { class: open ? '' : 'ok' }, open ? h('span', {}, `${plural(open, 'photo')} still to review  `, h('button', { class: 'link', type: 'button', onclick: () => setMode('review') }, 'Go to review')) : 'Review finished'),
        h('li', { class: count ? 'ok' : '' }, `${plural(count, 'photo')} in the album`)),
      h('div', { class: 'runbox' })),
    album?.id ? h('details', { class: 'pcard danger' }, h('summary', {}, 'Remove deleted photos from GitHub for good'),
      h('p', {}, 'A photo you reject or remove leaves the album, but GitHub keeps it in the history of the album’s repositories. This takes those files out and starts each repository’s history again from now, so they are no longer part of it (GitHub clears them from its storage some time after). Photos still in the album are not touched.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: async e => {
        if (!confirm('Remove deleted photos from GitHub for good? This can’t be undone.')) return;
        e.target.disabled = true;
        try { await api('/api/purge', { method: 'POST', body: JSON.stringify({ folder: selected }) }); } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
      } }, 'Remove them for good'), h('span', { class: 'hint purgeline' }))) : null].filter(Boolean));
  drawRun(ready);
}

function signedIn() {
  const how = { browser: 'Sign in with GitHub', code: 'sign-in code', cli: 'GitHub CLI sign-in', token: 'access token' }[gh.account.method] || '';
  return h('div', { class: 'acct' },
    h('p', {}, 'Signed in as ', h('b', {}, gh.account.login), gh.account.name ? ` (${gh.account.name})` : '', `  ·  ${gh.account.host}  ·  ${how}`),
    h('button', { class: 'btn small', type: 'button', onclick: async () => {
      try { const r = await api('/api/github/signout', { method: 'POST' }); toast(r.revoked ? 'Signed out, and GitHub has cancelled the sign-in too.' : 'Signed out on this PC. To cancel the sign-in on GitHub too, remove it under GitHub → Settings → Applications (or Tokens).'); drawPublish(); } catch (err) { toast(err.message, 'bad'); }
    } }, 'Sign out'),
    h('p', { class: 'hint' }, 'The sign-in is stored encrypted for your Windows account only. To cut it off completely, revoke it on GitHub under Settings → Applications or Tokens.'));
}

function signInOptions() {
  const tokenInput = h('input', { type: 'password', class: 'tok', placeholder: 'ghp_… or github_pat_…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'GitHub token' });
  const idInput = h('input', { class: 'tok', placeholder: 'Client ID', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'App Client ID' });
  const secretInput = h('input', { type: 'password', class: 'tok', placeholder: 'Client secret', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'App Client secret' });
  const hostInput = h('input', { class: 'tok', value: ghHost, 'aria-label': 'GitHub address', onchange: e => { ghHost = e.target.value.trim() || 'github.com'; try { localStorage.setItem('ghHost', ghHost); } catch {} drawPublish(); } });
  const busyBtn = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (err) { toast(err.message, 'bad'); } finally { btn.disabled = false; } };
  const web = ghHost === 'github.com' ? 'https://github.com' : `https://${ghHost}`;
  const copy = (text, what) => h('button', { class: 'btn small', type: 'button', onclick: () => navigator.clipboard.writeText(text).then(() => toast(`${what} copied.`)) }, 'Copy');
  const cancel = h('button', { class: 'link', type: 'button', onclick: async () => { await api('/api/github/cancel', { method: 'POST' }); signingIn = webWaiting = null; drawPublish(); } }, 'Cancel');

  // the one way most people need
  const main = h('div', { class: 'way main' },
    h('h3', {}, 'Sign in with GitHub'),
    h('p', {}, 'Your browser opens GitHub. Sign in there the way you always do (two-step verification, passkey, security key, Google or company sign-in all work), allow Lamhaat, and you’re back here, signed in. Lamhaat never sees your password.'),
    webWaiting ? h('div', { class: 'code' },
        h('p', { class: 'hint wait' }, 'Waiting for you to allow Lamhaat in your browser…  ', cancel),
        h('p', { class: 'hint' }, 'Browser didn’t open? ', h('a', { href: webWaiting, target: '_blank', rel: 'noopener' }, 'Open GitHub'), '.'))
    : gh.ready.browser ? h('button', { class: 'btn primary gh', type: 'button', onclick: e => busyBtn(e.target, async () => {
        webWaiting = (await api('/api/github/web', { method: 'POST', body: JSON.stringify({ host: ghHost }) })).url;
        drawPublish();
      }) }, 'Sign in with GitHub')
    : h('div', { class: 'setup' },
        h('p', {}, h('b', {}, 'One-time setup'), ' by the owner of this copy of Lamhaat: register it on GitHub, the way every app that offers “Sign in with GitHub” is registered once. Nobody signing in later sees this.'),
        h('ol', {},
          h('li', {}, h('a', { href: `${web}/settings/applications/new`, target: '_blank', rel: 'noopener' }, 'Open “Register a new OAuth app”'), ' on GitHub.'),
          h('li', {}, 'Application name: ', h('b', {}, 'Lamhaat'), '. Homepage URL: your site, e.g. https://yourname.github.io/lamhaat/'),
          h('li', {}, 'Authorization callback URL: ', h('code', {}, gh.callback), ' ', copy(gh.callback, 'Callback URL')),
          h('li', {}, 'Tick ', h('b', {}, 'Enable Device Flow'), ', then Register application.'),
          h('li', {}, 'Copy the Client ID, press ', h('b', {}, 'Generate a new client secret'), ', and paste both here.')),
        h('div', { class: 'row' }, idInput, secretInput, h('button', { class: 'btn', type: 'button', onclick: e => busyBtn(e.target, async () => {
          await api('/api/github/app-id', { method: 'POST', body: JSON.stringify({ host: ghHost, clientId: idInput.value, clientSecret: secretInput.value }) });
          secretInput.value = '';
          toast('Saved. “Sign in with GitHub” is ready.', 'good'); drawPublish();
        }) }, 'Save'))));

  // the rest, for when that can't be used
  const other = h('details', { class: 'way other', open: !!signingIn }, h('summary', {}, 'Other ways to sign in'),
    h('div', { class: 'ways' },
      h('div', { class: 'way' },
        h('h3', {}, 'With a code'),
        h('p', {}, 'For when your browser is on another device: approve a short code at GitHub from anywhere.'),
        signingIn ? h('div', { class: 'code' },
            h('div', { class: 'big-code' }, signingIn.userCode, copy(signingIn.userCode, 'Code')),
            h('p', {}, h('a', { href: signingIn.url, target: '_blank', rel: 'noopener' }, signingIn.url.replace(/^https:\/\//, '')), ': enter the code and approve.'),
            h('p', { class: 'hint wait' }, 'Waiting…  ', cancel))
        : h('button', { class: 'btn', type: 'button', disabled: !gh.ready.code, title: gh.ready.code ? '' : 'Needs the one-time setup above', onclick: e => busyBtn(e.target, async () => {
            signingIn = await api('/api/github/browser', { method: 'POST', body: JSON.stringify({ host: ghHost }) });
            drawPublish();
          }) }, 'Get a code')),
      h('div', { class: 'way' },
        h('h3', {}, 'The GitHub CLI on this PC'),
        h('p', {}, 'If you already ran “gh auth login”, Lamhaat can use that sign-in.'),
        h('button', { class: 'btn', type: 'button', onclick: e => busyBtn(e.target, async () => {
          const r = await api('/api/github/cli', { method: 'POST', body: JSON.stringify({ host: ghHost }) });
          toast(`Signed in to GitHub as ${r.account.login}.`, 'good'); drawPublish();
        }) }, 'Use GitHub CLI sign-in')),
      h('div', { class: 'way' },
        h('h3', {}, 'An access token'),
        h('p', {}, 'Classic with the “repo” scope, or fine-grained for all repositories with Contents, Administration and Pages set to read and write. ',
          h('a', { href: `${web}/settings/tokens/new?scopes=repo&description=Lamhaat`, target: '_blank', rel: 'noopener' }, 'Make a classic token')),
        h('div', { class: 'row' }, tokenInput, h('button', { class: 'btn', type: 'button', onclick: e => busyBtn(e.target, async () => {
          const r = await api('/api/github/token', { method: 'POST', body: JSON.stringify({ host: ghHost, token: tokenInput.value }) });
          tokenInput.value = '';
          toast(`Signed in to GitHub as ${r.account.login}.`, 'good'); drawPublish();
        }) }, 'Sign in'))),
      h('div', { class: 'way' },
        h('h3', {}, 'GitHub Enterprise'),
        h('p', {}, 'Leave as github.com unless your company runs its own GitHub.'), hostInput)));
  return h('div', { class: 'signin' }, main, other);
}

async function setVisibility(pub) {
  try { await api('/api/album/visibility', { method: 'POST', body: JSON.stringify({ folder: selected, public: pub }) }); album = { ...album, public: pub }; drawPublish(); }
  catch (err) { toast(err.message, 'bad'); drawPublish(); }
}

function drawRun(ready = !!gh.account && !all.some(p => p.decision === 'undecided')) {
  const box = main.querySelector('.runbox');
  if (!box) return;
  const r = pubRun, running = r?.status === 'running';
  const start = async () => {
    try { await prepareMeaning(selected); await api('/api/publish', { method: 'POST', body: JSON.stringify({ folder: selected }) }); }
    catch (err) { toast(err.message, 'bad'); }
  };
  const fix = r?.error && {
    signin: ['Sign in again', async () => { await api('/api/github/signout', { method: 'POST' }); drawPublish(); }],
    scope: ['Sign in again', async () => { await api('/api/github/signout', { method: 'POST' }); drawPublish(); }],
    sso: ['Sign in again', async () => { await api('/api/github/signout', { method: 'POST' }); drawPublish(); }],
    review: ['Go to review', () => setMode('review')],
    sensitive: ['Publish them anyway', async () => { await api('/api/album/visibility', { method: 'POST', body: JSON.stringify({ folder: selected, allowSensitive: true }) }); start(); }],
    'public-repo': [`Make ${r.error.repo} private`, async () => { await api('/api/github/make-private', { method: 'POST', body: JSON.stringify({ repo: r.error.repo }) }); toast('It’s private now. Running again…'); start(); }],
  }[r.error.kind];
  const btn = (text, fn, cls = 'btn') => h('button', { class: cls, type: 'button', onclick: async e => { e.target.disabled = true; try { await fn(); } catch (err) { toast(err.message, 'bad'); } finally { e.target.disabled = false; } } }, text);
  box.replaceChildren(...[
    h('div', { class: 'go' },
      running ? btn('Stop', () => api('/api/publish/cancel', { method: 'POST' }))
        : btn(r && r.status !== 'done' ? 'Carry on publishing' : r ? 'Publish again' : 'Publish to GitHub', start, `btn primary${ready ? '' : ' off'}`),
      r?.status === 'done' && r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener', class: 'link' }, `Open ${r.url.replace(/^https:\/\//, '')}`) : null,
      r && !running ? h('span', { class: 'hint' }, `Last run ${new Date(r.endedAt || r.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}: ${{ done: 'finished', failed: 'stopped with a problem', cancelled: 'stopped by you', interrupted: 'cut off when the app closed' }[r.status] || r.status}`) : null),
    r ? h('ol', { class: 'steps' }, r.steps.map(s => h('li', { class: `st ${s.status}` },
      h('span', { class: 'sm', 'aria-hidden': 'true' }, MARK[s.status]), h('span', { class: 'sl' }, s.label), s.detail ? h('span', { class: 'sd' }, s.detail) : null))) : null,
    r?.error && r.status !== 'running' ? h('div', { class: `problem ${r.status === 'cancelled' ? 'calm' : ''}` },
      h('p', {}, r.error.message),
      h('div', { class: 'row' },
        fix ? btn(fix[0], fix[1], 'btn primary') : null,
        r.error.url ? h('a', { class: 'btn', href: r.error.url, target: '_blank', rel: 'noopener' }, 'Open on the web') : null,
        r.error.kind !== 'review' ? btn('Try again', start) : null),
      h('p', { class: 'hint' }, 'Trying again is always safe: anything already on GitHub is kept and skipped.')) : null,
    r?.log?.length ? h('details', { class: 'log' }, h('summary', {}, `Activity (${r.log.length})`),
      h('ul', {}, r.log.slice(-40).map(l => h('li', {}, h('time', {}, new Date(l.at).toLocaleTimeString()), ' ', l.text)))) : null,
  ].filter(Boolean));
}

// ---------- search by meaning: before publishing, each photo's numbers (site/meaning.js), worked out here ----------
let meaningRun = null;
function prepareMeaning(folder) {
  meaningRun ||= (async () => {
    const { todo } = await api(`/api/embeds?folder=${encodeURIComponent(folder)}`);
    if (!todo.length) return;
    const m = await import('/lib/meaning.js');
    for (let i = 0; i < todo.length; i += 20) {
      const items = [];
      for (const t of todo.slice(i, i + 20)) items.push({ id: t.id, hash: t.hash, vec: m.pack(await m.embed(t.text)) });
      const { saved } = await api('/api/embeds', { method: 'POST', body: JSON.stringify({ items }) });
      if (saved !== items.length) throw new Error('the library didn’t keep them');
      toast(`Getting search by meaning ready: ${Math.min(i + 20, todo.length)} of ${todo.length}`);
    }
  })().catch(err => toast(`Search by meaning wasn’t prepared (${err.message}); publishing goes on without it.`, 'bad')).finally(() => { meaningRun = null; });
  return meaningRun;
}

// ---------- people and sharing: who can see private albums, and putting private viewing online ----------
const peopleBtn = document.querySelector('.nav-people');
let onPeople = false;
peopleBtn.addEventListener('click', () => { onPeople = true; onSettings = false; hidePeek(); picked.clear(); drawPicked(); drawShoots(); drawPeople(); });
const groupName = g => g[0].toUpperCase() + g.slice(1);

async function drawPeople() {
  if (!onPeople) return;
  const [p, fb, g, rq] = await Promise.all([api('/api/people'), api('/api/firebase'), api('/api/github').catch(() => null), api('/api/requests').catch(() => ({ requests: [] }))]);
  if (g) gh = g; // the site's address in the instructions comes from your GitHub name
  if (!onPeople) return;
  main.replaceChildren(h('div', { class: 'peoplepage' },
    h('header', { class: 'head' }, h('div', {}, h('h1', {}, 'People & sharing'),
      h('p', { class: 'facts' }, 'Private albums are seen only by the people here, after they sign in with Google. Public albums need nothing.'))),
    fb.rulesOld ? h('p', { class: 'note warn pnote' }, 'Lamhaat’s Firestore rules have changed (favourites, comments and asking for access). Copy the rules below again, paste them into Firestore → Rules, press Publish, then Check and connect.') : null,
    rq.requests.length ? h('section', { class: 'pcard' }, h('h2', {}, 'Asked for access'),
      h('table', { class: 'ptable' }, h('tbody', {}, rq.requests.map(r => h('tr', {},
        h('td', {}, r.name || '—'), h('td', { class: 'mono' }, r.email), h('td', { class: 'hint' }, r.at ? day(r.at) : ''),
        h('td', {}, h('div', { class: 'row' },
          h('button', { class: 'btn small primary', type: 'button', onclick: async () => {
            try { await api('/api/people', { method: 'POST', body: JSON.stringify({ email: r.email, name: r.name || '', groups: ['family'] }) }); await api('/api/requests/dismiss', { method: 'POST', body: JSON.stringify({ email: r.email }) }); toast(`Added ${r.name || r.email} to Family. Change their groups above.`, 'good'); drawPeople(); }
            catch (err) { toast(err.message, 'bad'); }
          } }, 'Add to Family'),
          h('button', { class: 'link', type: 'button', onclick: async () => { await api('/api/requests/dismiss', { method: 'POST', body: JSON.stringify({ email: r.email }) }); drawPeople(); } }, 'Dismiss')))))))) : null,
    peopleCard(p),
    firebaseCard(fb),
    fb.ready ? h('section', { class: 'pcard' }, h('h2', {}, 'Lock private albums again'),
      h('p', {}, 'Removing someone stops them seeing private albums from now on, but a browser keeps the keys it already had. To be sure, give every private album a new key: Lamhaat seals each one again and uploads it, so old keys open nothing.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: async e => {
        if (!confirm('Give every private album a new key and upload it again? This takes a while for big albums.')) return;
        e.target.disabled = true;
        try { const r = await api('/api/albums/relock', { method: 'POST' }); toast(r.albums ? `Locking ${plural(r.albums, 'private album')} again, one after another…` : 'No private albums on GitHub yet.', 'good'); }
        catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
      } }, 'Lock again'), h('span', { class: 'hint relock' }))) : null));
}

function peopleCard({ people, groups }) {
  const email = h('input', { class: 'tok', type: 'email', placeholder: 'their Gmail address', autocomplete: 'off', 'aria-label': 'Email' });
  const name = h('input', { class: 'tok', placeholder: 'name (optional)', autocomplete: 'off', 'aria-label': 'Name' });
  const newGroup = h('input', { class: 'tok small', placeholder: 'new group', autocomplete: 'off', 'aria-label': 'New group' });
  const chosen = new Set(['family']);
  const groupPicks = () => h('div', { class: 'gpicks' }, groups.map(g => h('label', { class: 'gpick' },
    h('input', { type: 'checkbox', checked: chosen.has(g), onchange: e => e.target.checked ? chosen.add(g) : chosen.delete(g) }), groupName(g))));
  const after = r => { toast(r.synced === 'synced' ? 'Saved, and updated online.' : r.synced === 'local' ? 'Saved. It goes online when private viewing is set up.' : `Saved here; ${r.synced}`, r.synced?.startsWith('not') ? 'bad' : 'good'); drawPeople(); };
  const save = async (person, gs) => { try { after(await api('/api/people', { method: 'POST', body: JSON.stringify({ ...person, groups: gs }) })); } catch (err) { toast(err.message, 'bad'); } };
  return h('section', { class: 'pcard' }, h('h2', {}, 'People'),
    people.length ? h('table', { class: 'ptable' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Google account'), h('th', {}, 'Groups'), h('th', {}))),
      h('tbody', {}, people.map(per => h('tr', {},
        h('td', {}, per.name || '—'), h('td', { class: 'mono' }, per.email),
        h('td', {}, h('div', { class: 'gpicks' }, groups.map(g => h('label', { class: 'gpick' },
          h('input', { type: 'checkbox', checked: per.groups.includes(g), onchange: e => {
            const gs = e.target.checked ? [...per.groups, g] : per.groups.filter(x => x !== g);
            if (!gs.length) { e.target.checked = true; return toast('Everyone needs at least one group. To stop sharing with them, press Remove.', 'bad'); }
            save(per, gs);
          } }), groupName(g))))),
        h('td', {}, h('button', { class: 'link', type: 'button', onclick: async () => {
          if (!confirm(`Stop sharing with ${per.name || per.email}? They won’t see any private album after this.`)) return;
          try { after(await api('/api/people/remove', { method: 'POST', body: JSON.stringify({ email: per.email }) })); } catch (err) { toast(err.message, 'bad'); }
        } }, 'Remove')))))) : h('p', { class: 'hint' }, 'Nobody yet. Add the people who should see your private albums.'),
    h('div', { class: 'addperson' },
      h('div', { class: 'row' }, email, name),
      h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Groups:'), groupPicks(), newGroup,
        h('button', { class: 'btn small', type: 'button', onclick: () => {
          const g = newGroup.value.trim().toLowerCase();
          if (!g) return;
          if (!groups.includes(g)) groups.push(g);
          chosen.add(g); newGroup.value = '';
          newGroup.parentElement.querySelector('.gpicks').replaceWith(groupPicks());
        } }, 'Add group')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => save({ email: email.value, name: name.value }, [...chosen]) }, 'Add person')),
    h('p', { class: 'hint' }, 'Choose which groups see each private album on its Publish tab. Changes reach your site within seconds once Google sign-in is set up below.'));
}

// private albums with Google sign-in: one Firebase project, set up once, then managed from here
function firebaseCard(fb) {
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  const cfg = h('textarea', { class: 'fld mono', rows: 6, placeholder: 'const firebaseConfig = {\n  apiKey: "…",\n  authDomain: "…",\n  projectId: "…",\n  appId: "…"\n};' });
  const ownerName = h('input', { class: 'tok', value: fb.ownerName || '', placeholder: 'your name, shown on the site (e.g. Sam)' });
  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (err) { toast(err.message, 'bad'); } finally { btn.disabled = false; } };
  const step = (n, done, title, ...body) => h('div', { class: `fbstep${done ? ' done' : ''}` }, h('span', { class: 'fbn' }, done ? '✓' : n), h('div', {}, h('h3', {}, title), ...body));
  const signIn = async () => {
    const SDK = 'https://www.gstatic.com/firebasejs/13.0.0';
    const [{ initializeApp, getApps }, auth] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`)]);
    const app = getApps()[0] || initializeApp(fb.config);
    const provider = new auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    let cred;
    try { cred = await auth.signInWithPopup(auth.getAuth(app), provider); }
    catch (e) {
      if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
      if (e.code === 'auth/operation-not-allowed') throw new Error('Google sign-in isn’t switched on in this Firebase project (Authentication → Sign-in method → Google → Enable).');
      if (e.code === 'auth/unauthorized-domain') throw new Error('Firebase doesn’t allow this window. In Authentication → Settings → Authorized domains, keep “localhost” in the list.');
      throw new Error(`Google sign-in didn’t finish (${e.code || e.message}).`);
    }
    await api('/api/firebase/signin', { method: 'POST', body: JSON.stringify({ refreshToken: cred.user.refreshToken }) });
    await auth.signOut(auth.getAuth(app)); // the app keeps its own copy, encrypted; this window holds nothing
    toast(`Signed in as ${cred.user.email}.`, 'good');
    drawPeople();
  };
  // the Firebase console, step by step (the same steps the owner does once, before step 1 below)
  const site = `${(gh.account?.login || 'yourname').toLowerCase()}.github.io`;
  const part = (title, ...items) => h('li', {}, h('b', {}, title), h('ul', {}, ...items.map(i => h('li', {}, ...[].concat(i)))));
  // sign in from a browser (the default one, or any other via the link): Lamhaat hears back by itself
  const browserSignIn = async (stepEl, open) => {
    const { link } = await api('/api/firebase/browser', { method: 'POST', body: JSON.stringify({ open }) });
    if (!open) await navigator.clipboard.writeText(link).then(() => toast('Link copied. Paste it into any browser on this PC.', 'good')).catch(() => {});
    stepEl.querySelector('.signlink').replaceChildren(
      h('p', { class: 'hint wait' }, open ? 'Finish signing in in your browser; this page updates by itself. Not the right browser? Open this link in another one on this PC:' : 'Open this link in any browser on this PC and sign in there; this page updates by itself:'),
      h('div', { class: 'row' }, h('input', { class: 'tok mono', readonly: true, value: link, onfocus: e => e.target.select() }),
        h('button', { class: 'btn small', type: 'button', onclick: () => navigator.clipboard.writeText(link).then(() => toast('Link copied.', 'good')) }, 'Copy link')),
      h('p', { class: 'hint' }, 'The link works once, for 20 minutes.'));
  };
  const howTo = h('details', { class: 'way', open: !fb.config },
    h('summary', {}, 'First: make the Firebase project (about 10 minutes, free, no card)'),
    h('ol', { class: 'howto' },
      part('Create the project',
        ['Open ', link('https://console.firebase.google.com', 'console.firebase.google.com'), ' and sign in with the Google account that will own the albums.'],
        'Create a project → name it Lamhaat → turn Google Analytics off → Create project.'),
      part('Turn on Google sign-in',
        'Left menu: Build → Authentication → Get started.',
        'Sign-in method → Google → switch Enable on → pick your email as support email → Save.'),
      part('Allow your site to use it',
        ['Authentication → Settings → Authorized domains → Add domain → ', h('b', {}, site), ' → Add.'],
        'Leave “localhost” in the list: Lamhaat uses it.'),
      part('Create the database',
        'Build → Firestore Database → Create database.',
        'Edition: Standard. Location: one near you (e.g. nam5, United States). It can’t change later.',
        'Start in production mode → Create.'),
      part('Get the settings for Lamhaat',
        'Click ⚙ next to Project Overview → Project settings → Your apps → the </> (web) icon.',
        'Nickname Lamhaat, leave Hosting unticked → Register app.',
        'Copy the whole firebaseConfig { … } block and paste it into step 1 below.'),
      part('Then here in Lamhaat', 'Do steps 1 to 4 below. Step 3 gives you the rules to paste, already filled in with your email.'),
      h('li', {}, 'Skip everything else Firebase offers (billing, Storage, Functions, Hosting).')));
  return h('section', { class: 'pcard' }, h('h2', {}, 'Private albums with Google sign-in'),
    h('p', {}, fb.ready && fb.connected ? '✓ On. Your site shows “Sign in with Google”; people on your list see the private albums shared with their groups.'
      : 'Uses a free Google Firebase project. Your family and friends sign in with Google on your site; Lamhaat decides who sees what.'),
    howTo,
    step(1, !!fb.config, fb.config ? `Firebase project: ${fb.config.projectId}` : 'Paste the Firebase settings',
      h('div', { class: 'row' }, cfg), h('div', { class: 'row' }, ownerName,
        h('button', { class: 'btn small', type: 'button', onclick: e => busy(e.target, async () => {
          await api('/api/firebase/details', { method: 'POST', body: JSON.stringify({ config: cfg.value || undefined, ownerName: ownerName.value }) });
          toast('Saved.', 'good'); drawPeople();
        }) }, 'Save'))),
    step(2, !!fb.owner, fb.owner ? `Signed in as ${fb.owner}` : 'Sign in with Google, as the owner',
      h('p', { class: 'hint' }, 'Use the Google account you’ll own the albums with. Lamhaat keeps this sign-in encrypted on this PC to update your list; it renews by itself.'),
      h('div', { class: 'row' }, fb.owner
        ? h('button', { class: 'btn small', type: 'button', onclick: e => busy(e.target, async () => { await api('/api/firebase/signout', { method: 'POST' }); drawPeople(); }) }, 'Sign out')
        : [h('button', { class: 'btn primary gh', type: 'button', disabled: !fb.config, title: 'Opens your usual browser, where you are probably signed in to Google already',
            onclick: e => busy(e.target, () => browserSignIn(e.target.closest('.fbstep'), true)) }, 'Sign in with Google in your browser'),
          h('button', { class: 'link', type: 'button', disabled: !fb.config, onclick: e => busy(e.target, () => browserSignIn(e.target.closest('.fbstep'), false)) }, 'Copy a link for another browser'),
          h('button', { class: 'link', type: 'button', disabled: !fb.config, onclick: e => busy(e.target, signIn) }, 'Sign in here instead')]),
      h('div', { class: 'signlink' })),
    step(3, false, 'Paste the rules into Firestore',
      h('p', { class: 'hint' }, 'Firestore Database → Rules → replace everything with this → Publish. It names ', h('b', {}, fb.owner || 'your email (sign in first)'), ' as the only one who can change anything.'),
      h('pre', { class: 'rules' }, fb.rules),
      h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', disabled: !fb.owner, onclick: () => navigator.clipboard.writeText(fb.rules).then(() => toast('Rules copied.', 'good')) }, 'Copy rules'))),
    step(4, !!fb.connected, 'Check it works and connect your site',
      h('p', { class: 'hint' }, 'Lamhaat writes a test, copies your people list in, and adds “Sign in with Google” to your site. Safe to press again any time.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', disabled: !fb.ready, onclick: e => busy(e.target, async () => {
        const r = await api('/api/firebase/connect', { method: 'POST' });
        toast(`Works. ${plural(r.people, 'person')} copied in${r.site === 'publishing' ? '; updating your site…' : '.'}`, 'good');
      }) }, 'Check and connect'), h('span', { class: 'hint fbsite' }))));
}
events.addEventListener('fbsite', e => {
  const r = JSON.parse(e.data), el = main.querySelector('.fbsite');
  if (r.error) toast(`Site not updated: ${r.error}`, 'bad');
  else if (r.done) { toast('Your site now shows “Sign in with Google”.', 'good'); if (onPeople) drawPeople(); }
  if (el) el.textContent = r.detail || r.done || r.error || '';
});

// a newer version of Lamhaat took over (and opened its own window): this old window closes
events.addEventListener('restart', () => { toast('Lamhaat was updated: the new version opens in a new window.'); setTimeout(() => window.close(), 1500); });
events.addEventListener('relock', e => {
  const r = JSON.parse(e.data), el = main.querySelector('.relock');
  const t = r.status === 'done' ? `${r.album} locked again (${r.done} of ${r.total})` : `${r.album}: ${r.error || r.status}. Press Lock again to carry on.`;
  if (el) el.textContent = t;
  if (r.done === r.total && r.status === 'done') toast('Every private album has a new key.', 'good'); else if (r.status !== 'done') toast(t, 'bad');
});
events.addEventListener('purge', e => {
  const r = JSON.parse(e.data), el = main.querySelector('.purgeline');
  if (el) el.textContent = r.detail || (r.error ? '' : r.done != null ? 'Done.' : '');
  if (r.done != null) toast(r.done ? `Removed ${plural(r.done, 'file')} for good, and cleared the history.` : 'Nothing deleted was left; the history is cleared.', 'good');
  if (r.error) toast(r.error, 'bad');
});
events.addEventListener('fbsignin', e => { toast(`Signed in to Google as ${JSON.parse(e.data).owner}.`, 'good'); if (onPeople) drawPeople(); });

// AI progress and results
events.addEventListener('ai', () => { if (mode === 'review') drawAi(); });
events.addEventListener('ai-done', async e => {
  const r = JSON.parse(e.data);
  if (r.error) toast(`AI: ${r.error}`, 'bad');
  else if (r.kind === 'find') toast(r.tagged?.length ? `Found ${r.person} in ${plural(r.tagged.length, 'more photo')} and tagged them (marked auto). Remove any that aren’t ${r.person}; it learns from that.` : `Looked for ${r.person} in ${plural(r.checked || 0, 'photo')}: no new ones.`, 'good');
  else if (r.kind === 'describe') toast(`Described ${plural(r.done || 0, 'photo')}${r.errors ? ` (${r.errors} couldn’t be read)` : ''}.`, 'good');
  if (r.folder === selected && viewing < 0 && !editing && !onPeople && !onSettings) { await loadTags().catch(() => {}); await drawShoot(); }
  else drawAi();
});

// ---------- a dialog, for questions that need an answer before going on ----------
const dialog = h('dialog', { class: 'dlg' });
document.body.append(dialog);
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); }); // a click outside closes it
const ask = (...kids) => { dialog.replaceChildren(...kids); if (!dialog.open) dialog.showModal(); };

// going over photos again: quality, the files' details, or the AI (with instructions for this run)
function reprocessForm({ folder = selected, ids = null, done = () => {} } = {}) {
  const n = ids ? ids.length : library.folders.find(f => f.path === folder)?.count || 0;
  const what = { describe: true, check: false, details: false };
  const box = (k, text, hint) => h('label', { class: 'opt' }, h('input', { type: 'checkbox', checked: what[k], onchange: e => { what[k] = e.target.checked; } }), h('span', {}, h('b', {}, text), h('small', {}, hint)));
  const note = h('textarea', { class: 'fld', rows: 3, maxlength: 500, placeholder: 'Instructions for the AI for this run (optional). For example: “The subject is the baby. Ignore faces on phone screens. Name the room or place in the tags.”' });
  return h('div', { class: 'reform' },
    box('describe', 'Describe again with the AI', `A new description and tags, and where the main subject is, to check that it (not just the background) is sharp. About ${clock(n * 3000)}.`),
    note,
    box('check', 'Check sharpness and exposure again', 'Quick: a few seconds for a shoot.'),
    box('details', 'Read dates, camera and place again', 'From the files themselves, including GPS positions for chapters by place.'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: async e => {
      if (!Object.values(what).some(Boolean)) return toast('Choose what to do.', 'bad');
      e.target.disabled = true;
      try {
        await api('/api/reprocess', { method: 'POST', body: JSON.stringify({ folder, ids, what, note: note.value }) });
        toast(`Going over ${plural(n, 'photo')} again${what.describe ? '. The AI works through them one by one; you can keep working.' : '.'}`, 'good');
        done();
      } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
    } }, `Go over ${plural(n, 'photo')}`)));
}
const reprocessDialog = ids => ask(h('h2', {}, `Go over ${plural(ids.length, 'photo')} again`), reprocessForm({ ids, done: () => dialog.close() }),
  h('button', { class: 'big-close', type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '×'));

// enhancing: with the AI once its download is in; until then, ask (or do the careful resize)
const ENH = { fix: 'Sharpen', x2: 'Make 2× bigger', x4: 'Make 4× bigger' };
async function enhanceAsk(ids, mode) {
  const st = await api('/api/upscale').catch(() => ({ ai: false }));
  const go = async useAi => {
    dialog.close();
    try { await api('/api/upscale', { method: 'POST', body: JSON.stringify({ ids, mode, ai: useAi }) }); toast(`${ENH[mode]}: ${plural(ids.length, 'photo')}, one after another. The originals stay as they are.`, 'good'); }
    catch (err) { toast(err.message, 'bad'); }
  };
  if (st.ai) return go(true);
  const bar = h('span', { class: 'bar mini' }, h('i', { style: 'transform: scaleX(0)' }));
  ask(h('h2', {}, `${ENH[mode]}: ${plural(ids.length, 'photo')}`),
    h('p', {}, `The AI that redraws photos sharper and bigger (Real-ESRGAN) isn’t on this PC yet. It is one ${st.size || '45 MB'} download, runs on your graphics card, and nothing leaves your PC. It cleans up noise and slight softness and adds detail when enlarging; strong blur stays blurry.`),
    h('p', { class: 'hint' }, 'Without it, Lamhaat can still resize carefully and sharpen a little, but it can’t add detail or fix a soft subject.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: async e => {
        e.target.disabled = true; e.target.after(bar);
        installThen = () => go(true);
        try { await api('/api/upscale/install', { method: 'POST' }); } catch (err) { toast(err.message, 'bad'); }
      } }, `Download it (${st.size || '45 MB'})`),
      h('button', { class: 'btn', type: 'button', onclick: () => go(false) }, 'Basic resize instead'),
      h('button', { class: 'link', type: 'button', onclick: () => dialog.close() }, 'Cancel')));
}
let installThen = null;
events.addEventListener('upscale-install', e => {
  const r = JSON.parse(e.data);
  for (const b of document.querySelectorAll('.dlg .bar i, .settings .bar i')) b.style.transform = `scaleX(${r.total ? r.done / r.total : 0})`;
  if (r.error) { toast(`Download stopped: ${r.error}`, 'bad'); installThen = null; }
  if (r.finished) { toast('The AI upscaler is installed.', 'good'); installThen?.(); installThen = null; if (onSettings) drawSettings(); }
});
events.addEventListener('upscale', e => {
  const r = JSON.parse(e.data);
  if (!r.finished) return toast(`Working on ${Math.min(r.total, Math.floor(r.done) + 1)} of ${r.total}: ${r.current}  ·  ${Math.round((r.done % 1) * 100)}%`);
  toast(r.kind === 'denoise' ? `Noise removed from ${plural(r.done, 'photo')}. RAW photos are cleaner where they are; JPEGs have a clean copy in the shoot’s “Enhanced” folder.` : `${plural(r.done, 'photo')} enhanced${r.ai ? ' with the AI' : ''}. They are new photos in the shoot’s “Enhanced” folder and appear next to the originals in a moment.${r.errors.length ? ` ${r.errors.length} failed: ${r.errors[0].error}` : ''}`, r.errors.length ? 'bad' : 'good');
});

// ---------- settings ----------
const settingsBtn = document.querySelector('.nav-settings');
let onSettings = false;
settingsBtn.addEventListener('click', () => { onSettings = true; onPeople = false; hidePeek(); picked.clear(); drawPicked(); drawShoots(); drawSettings(); });
async function drawSettings() {
  if (!onSettings) return;
  const [st, keys, tl] = await Promise.all([api('/api/settings'), api('/api/keys'), api('/api/tools')]);
  if (!onSettings) return;
  let folder = library.folders.find(f => f.path === selected && f.count) ? selected : library.folders.find(f => f.count)?.path;
  const formBox = h('div');
  const drawForm = () => formBox.replaceChildren(folder ? reprocessForm({ folder }) : h('p', { class: 'hint' }, 'Import a shoot first.'));
  drawForm();
  const card = (title, ...kids) => h('section', { class: 'pcard' }, h('h2', {}, title), ...kids);
  const up = st.upscale;
  main.replaceChildren(h('div', { class: 'peoplepage settings' },
    h('header', { class: 'head' }, h('div', {}, h('h1', {}, 'Settings'))),
    toolsCard(tl.tools),
    card('Go over photos again',
      h('p', { class: 'hint' }, 'For a few photos, pick them (or right-click one) and choose “Describe again with the AI”.'),
      h('label', { class: 'sort' }, 'Shoot ', h('select', { onchange: e => { folder = e.target.value; drawForm(); } },
        library.folders.filter(f => f.count).map(f => h('option', { value: f.path, selected: f.path === folder }, `${f.name} (${plural(f.count, 'photo')})`)))),
      formBox),
    card('Local AI',
      h('p', {}, 'Describes photos, finds people and checks the subject is sharp, with a model that runs on this PC through Ollama. Nothing is uploaded.'),
      st.models.length ? h('label', { class: 'sort' }, 'Model ', h('select', { onchange: async e => {
        try { await api('/api/settings', { method: 'POST', body: JSON.stringify({ visionModel: e.target.value }) }); toast(`The AI now uses ${e.target.value}. Photos are described again with it when you ask.`, 'good'); }
        catch (err) { toast(err.message, 'bad'); }
      } }, st.models.map(m => h('option', { value: m.name, selected: m.name === st.model }, `${m.name}  ·  ${gb(m.size)}`))))
        : h('p', { class: 'hint' }, `The AI server isn’t running, or the vision model isn’t downloaded: see “Programs Lamhaat uses” above. Using ${st.model}.`)),
    card('Bigger or sharper photos',
      h('p', {}, up.ai ? '✓ The AI upscaler (Real-ESRGAN) is installed. It runs on your graphics card.'
        : `The AI upscaler (Real-ESRGAN) isn’t installed. It is one ${up.size} download; without it, enhancing is a careful resize only.`),
      up.ai ? null : h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: async e => {
        e.target.disabled = true; e.target.after(h('span', { class: 'bar mini' }, h('i', { style: 'transform: scaleX(0)' })));
        try { await api('/api/upscale/install', { method: 'POST' }); } catch (err) { toast(err.message, 'bad'); }
      } }, `Download it (${up.size})`)),
      h('p', { class: 'hint' }, 'Right-click a photo (or pick several, then More ▾): Sharpen keeps the size and cleans up noise and slight softness; 2× and 4× make it bigger (up to 120 megapixels). No AI can bring back a face lost to strong blur. The result is a new photo in the shoot’s “Enhanced” folder; the original never changes.')),
    keysCard(keys),
    card('RAW photos and noise',
      h('p', {}, st.raw.raw ? '✓ RAW photos (Fuji .RAF, and DNG, NEF, CR2/CR3, ARW and others) are imported: developed with the camera’s white balance and none of the camera’s smearing noise reduction. Re-import a shoot to bring its RAW files in.'
        : 'RAW photos aren’t read yet: download the RAW reader under “Programs Lamhaat uses” above.'),
      st.raw.denoise ? h('label', { class: 'opt' }, h('input', { type: 'checkbox', checked: st.denoiseRaw, onchange: async e => {
        try { await api('/api/settings', { method: 'POST', body: JSON.stringify({ denoiseRaw: e.target.checked }) }); toast(e.target.checked ? 'New RAW photos will have their noise removed as they come in.' : 'RAW photos come in as they are; remove noise when you choose.', 'good'); }
        catch (err) { toast(err.message, 'bad'); }
      } }), h('span', {}, h('b', {}, 'Remove noise from RAW photos as they are imported'), h('small', {}, 'With the AI, on your graphics card: about 20 seconds a photo. Best for high-ISO shots.')))
        : h('p', { class: 'hint' }, 'The AI noise removal needs ComfyUI’s Python on this PC for now; this PC doesn’t have it.'),
      h('p', { class: 'hint' }, 'For photos already here: right-click (or pick several, then More ▾) → Remove noise. Set your camera to RAW + JPEG for the best results: a JPEG has already lost detail to the camera’s own noise reduction.')),
    card('Mouse and keys',
      h('ul', { class: 'keys2' },
        [['Hold a photo, or Ctrl+click', 'pick it; then a click picks more'], ['Shift+click', 'pick everything in between'], ['Esc', 'let go of all picked photos'],
         ['Right-click', 'everything you can do with a photo'], ['Rest the pointer on a photo', 'a larger look (a stack shows its frames)'],
         ['K  X  U  C  H  S', 'keep, reject, undecided, cover, highlight, new chapter: on the photo under the pointer'],
         ['Ctrl+Z', 'undo the last change'], ['Back (mouse), Alt+←, Backspace', 'close the large view'], ['Size slider', 'make the photos in the grid bigger or smaller']]
          .map(([k, t]) => h('li', {}, h('b', {}, k), h('span', {}, t)))))));
}

// ---------- the programs Lamhaat uses: what is here, what runs, what can be downloaded ----------
const TOOL_STEP = { git: 'Downloading', ollama: 'Downloading', model: 'Downloading', upscaler: 'Downloading', raw: 'Downloading' };
function toolsCard(list) {
  const row = t => {
    const state = t.installing ? h('span', { class: 'tstate' }, `${t.installing.step || TOOL_STEP[t.id]}…`, h('span', { class: 'bar mini', 'data-tool': t.id }, h('i', { style: `transform: scaleX(${t.installing.total ? t.installing.done / t.installing.total : 0})` })))
      : t.id === 'ollama' && t.ok ? h('span', { class: `tstate ${t.running ? 'on' : 'off'}` }, t.running ? 'Running' : 'Stopped')
      : t.ok ? h('span', { class: 'tstate on' }, 'Ready')
      : t.unknown ? h('span', { class: 'tstate off' }, 'Start the AI server to check')
      : h('span', { class: 'tstate off' }, t.needed ? 'Needed' : 'Not installed');
    const btn = (label, fn, primary) => h('button', { class: `btn small${primary ? ' primary' : ''}`, type: 'button', onclick: async e => { e.target.disabled = true; try { await fn(); } catch (err) { toast(err.message, 'bad'); } drawSettings(); } }, label);
    const acts = t.installing ? []
      : t.id === 'ollama' && t.ok ? [t.running ? btn('Restart', () => api('/api/tools/ollama', { method: 'POST', body: '{"restart":true}' }).then(() => toast('The AI server restarted.', 'good')))
          : btn('Start', () => api('/api/tools/ollama', { method: 'POST', body: '{}' }).then(() => toast('The AI server is running.', 'good')), true)]
      : t.ok || t.unknown ? []
      : [btn(`Download (${t.size})`, () => installTool(t), t.needed)];
    return h('li', {}, h('div', {}, h('b', {}, t.name), h('small', {}, t.why)), h('div', { class: 'tacts' }, state, ...acts));
  };
  return h('section', { class: 'pcard progs' }, h('h2', {}, 'Programs Lamhaat uses'),
    h('p', { class: 'hint' }, 'All free. Lamhaat uses what is already on this PC and only downloads what is missing, when you click.'),
    h('ul', { class: 'tlist' }, list.map(row)),
    h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: () => drawSettings().then(() => toast('Checked again.', 'good')) }, 'Check again')));
}
const TOOL_DONE = { git: 'Git is installed. Publishing can go ahead.', ollama: 'The AI server is installed and running.', model: 'The vision model is downloaded. The AI is ready.', upscaler: 'The AI upscaler is installed.', raw: 'The RAW reader is installed. Re-import a shoot to bring its RAW files in.' };
const installTool = t => {
  if (t.id === 'ollama' && !confirm(`Download and install Ollama, the free AI server (${t.size})? Windows may ask you to allow it.`)) return Promise.resolve();
  return api('/api/tools/install', { method: 'POST', body: JSON.stringify({ id: t.id }) });
};
events.addEventListener('tool', e => {
  const r = JSON.parse(e.data);
  for (const b of document.querySelectorAll(`.bar[data-tool="${r.id}"] i`)) b.style.transform = `scaleX(${r.total ? r.done / r.total : 0})`;
  if (r.error) toast(`Download stopped: ${r.error}`, 'bad');
  if (r.finished) toast(TOOL_DONE[r.id] || 'Installed.', 'good');
  if ((r.error || r.finished) && onSettings) drawSettings();
});
// first start (or something needed went missing): say what is needed, once a day at most
async function toolsCheck() {
  const list = (await api('/api/tools').catch(() => null))?.tools;
  const missing = list?.filter(t => t.needed && !t.ok && !t.unknown && !t.installing) || [];
  let later = 0; try { later = Number(localStorage.getItem('toolsLater')) || 0; } catch {}
  if (!missing.length || Date.now() - later < 864e5) return;
  ask(h('h2', {}, 'A few free programs to finish setting up'),
    h('p', {}, 'Lamhaat checked this PC. These are missing:'),
    h('ul', { class: 'tlist' }, missing.map(t => h('li', {}, h('div', {}, h('b', {}, t.name), h('small', {}, t.why)), h('span', { class: 'tstate' }, t.size)))),
    h('p', { class: 'hint' }, 'Nothing leaves your PC: the AI runs here. You can do this later in Settings.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        dialog.close();
        for (const t of missing) { if (t.id === 'model' && missing.some(x => x.id === 'ollama')) continue; await installTool(t).catch(err => toast(err.message, 'bad')); }
        toast('Downloading. Progress is in Settings → Programs Lamhaat uses.', 'good');
      } }, 'Download them'),
      h('button', { class: 'btn', type: 'button', onclick: () => { try { localStorage.setItem('toolsLater', Date.now()); } catch {} dialog.close(); } }, 'Later')));
}

// the recovery code: without it, a lost PC means private albums can never be opened again
function keysCard(keys) {
  const box = h('div', { class: 'codebox', hidden: true });
  return h('section', { class: 'pcard' }, h('h2', {}, 'Recovery code for private albums'),
    h('p', {}, keys.saved ? `✓ You saved it on ${day(keys.saved)}. Keep it safe; you can show it again here.` : 'Private albums are locked with a key that only this PC has. Save this code somewhere safe (on paper, or in a password manager). If this PC is lost, the code is the only way to open them again.'),
    h('div', { class: 'row' },
      h('button', { class: `btn ${keys.saved ? '' : 'primary'}`, type: 'button', onclick: async e => {
        e.target.disabled = true;
        const { code } = await api('/api/keys/code', { method: 'POST' });
        box.hidden = false;
        box.replaceChildren(h('pre', { class: 'rules code' }, code), h('div', { class: 'row' },
          h('button', { class: 'btn small', type: 'button', onclick: () => navigator.clipboard.writeText(code).then(() => toast('Copied. Paste it somewhere safe.', 'good')) }, 'Copy'),
          h('button', { class: 'btn small', type: 'button', onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([`Lamhaat recovery code. Keep it private and safe: it opens your private albums.\n\n${code}\n`], { type: 'text/plain' })), download: 'Lamhaat recovery code.txt' }); a.click(); } }, 'Save as a file'),
          h('button', { class: 'btn small primary', type: 'button', onclick: async () => { await api('/api/keys/saved', { method: 'POST' }); toast('Thanks. Keep it safe.', 'good'); drawSettings(); } }, 'I’ve saved it')));
      } }, 'Show the code')),
    box,
    h('details', { class: 'way other' }, h('summary', {}, 'Restore from a recovery code (a new or repaired PC)'),
      (() => { const inp = h('textarea', { class: 'fld mono', rows: 3, placeholder: 'XXXX-XXXX-…' }); return h('div', { class: 'reform' }, inp,
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: async () => {
          if (!confirm('Use this code’s key for private albums on this PC? The key here now is kept in a backup file, not deleted.')) return;
          try { await api('/api/keys/restore', { method: 'POST', body: JSON.stringify({ code: inp.value }) }); toast('Restored. Private albums open with this key again.', 'good'); drawSettings(); }
          catch (err) { toast(err.message, 'bad'); }
        } }, 'Restore'))); })()));
}

// ---------- the photo folder ----------
rootBtn.addEventListener('click', async () => {
  rootBtn.disabled = true;
  let next;
  try { next = (await api('/api/pick-folder', { method: 'POST', body: JSON.stringify({ start: library.root, title: 'Choose the folder that holds your shoots (each subfolder is one shoot)' }) })).path; }
  catch (err) { toast(err.message, 'bad'); }
  finally { rootBtn.disabled = false; }
  if (!next || next === library.root) return;
  try { await api('/api/root', { method: 'POST', body: JSON.stringify({ root: next }) }); await refresh(); await drawShoot(); toast('Photo folder changed.', 'good'); }
  catch (err) { toast(err.message, 'bad'); }
});

await refresh();
await loadTags().catch(() => {});
await drawShoot();
toolsCheck();
