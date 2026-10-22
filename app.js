import { PLATFORM, PAGES_URL, call, on, canFullscreen } from './platform.js';
import { Viewer } from './sphere.js';
import { clock, limits } from './view-math.js';

const $ = (s) => document.querySelector(s);
const OPT_SPEED = 1.58;              // measured: h264_videotoolbox (nv12) left-eye copy runs 1.58× real time on M1

let viewer;
try {
  viewer = new Viewer($('#stage'));
} catch (err) {
  $('#lib-count').textContent = 'The 3D view couldn’t start (WebGL unavailable). Quit and reopen VR Player.';
  throw err;
}
const video = $('#video');
const state = {
  view: 'library',
  rows: new Map(),                   // id -> row data from native
  selected: null,
  ffmpeg: true,
  current: null,                     // { id, name, duration, src, layout, optimizedUntil, sourceLayout }
  fullscreen: false,
};

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const dur = (s) => (reduced() ? 0 : s);

// ---------- Library ----------
const layoutName = (l) => l ? `${l.projection}°${l.stereo === 'mono' ? '' : ' 3D'}` : '';
const hm = (s) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.max(1, m)} min`; };

function statusHTML(r) {
  if (r.unreadable) return 'Can’t read this file';
  if (r.duration == null) return 'Checking…';
  if (r.saving) return '<strong>Saving the optimized video…</strong>';
  if (r.progress != null) return `<strong>Optimizing ${Math.round(r.progress * 100)}%</strong>`;
  if (r.tooWide) return 'Too wide for the iPad · tap for options';
  if (!r.needsOptimizing) return 'Ready';
  if (r.optimized) return 'Ready · optimized';
  if (r.partial) return `Optimized ${Math.max(1, Math.floor(r.partial * 100))}% · paused`;
  if (!state.ffmpeg) return 'Needs ffmpeg';
  return `Optimize first · ~${hm(r.duration / OPT_SPEED)}`;
}

const playable = (r) => (r.vr || r.adhoc) && !r.unreadable && r.duration != null && (!r.needsOptimizing || r.optimized || state.ffmpeg);

function rowEl(r) {
  let li = document.getElementById(`row-${r.id}`);
  if (!li) {
    li = document.createElement('li');
    li.id = `row-${r.id}`;
    li.className = 'row';
    li.tabIndex = -1;
    li.innerHTML = `<span class="row-name"></span>
      <span class="row-meta"></span>
      <span class="row-side">
        <span class="row-status"></span>
        <span class="row-tools">
          <a class="icon lan-only" data-act="download" download aria-label="Download to this iPad" title="Download to this iPad"><svg><use href="#i-download"/></svg></a>
          <button class="icon mac-only" type="button" data-act="reveal" aria-label="Show in Finder" title="Show in Finder"><svg><use href="#i-reveal"/></svg></button>
          <button class="icon" type="button" data-act="delete" aria-label="Delete optimized copy" title="Delete optimized copy"><svg><use href="#i-trash"/></svg></button>
        </span>
      </span>
      <span class="row-progress" hidden><span></span></span>`;
    li.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'download') return;                       // the link downloads by itself
      if (act === 'reveal') return call('reveal', { id: r.id });
      if (act === 'delete') return call('deleteOptimized', { id: r.id }).then((row) => { const d = state.rows.get(r.id); delete d.partial; delete d.progress; d.optimized = false; updateRow(row); });
      unlockMedia();
      select(r.id); play(r.id);
    });
    li.addEventListener('focus', () => select(r.id, false));
  }
  const d = state.rows.get(r.id);
  li.querySelector('.row-name').textContent = d.name;
  li.querySelector('.row-name').title = d.file;
  const meta = d.duration != null ? [clock(d.duration), `${d.width} × ${d.height}`, layoutName(d.layout)] : [d.file];
  li.querySelector('.row-meta').textContent = meta.join('  ·  ');
  li.querySelector('.row-status').innerHTML = statusHTML(d);
  li.querySelector('[data-act="delete"]').hidden = !(d.optimized || d.partial || d.progress != null);
  const dl = li.querySelector('[data-act="download"]');
  dl.hidden = PLATFORM !== 'lan' || d.needsOptimizing !== false;   // only files that play as they are
  dl.href = `media/${d.id}/source`;
  dl.setAttribute('download', d.file);
  const bar = li.querySelector('.row-progress');
  bar.hidden = d.progress == null;
  if (d.progress != null) bar.firstElementChild.style.transform = `scaleX(${d.progress})`;
  bar.firstElementChild.style.width = '100%';
  const checking = d.duration == null && !d.unreadable;
  li.classList.toggle('checking', checking);
  li.classList.toggle('unplayable', !checking && !playable(d));
  li.setAttribute('aria-disabled', String(!playable(d)));
  return li;
}

function updateRow(r) {
  if (!r) return;
  state.rows.set(r.id, { ...state.rows.get(r.id), ...r });
  renderRows();
}

let staggered = false;
function renderRows() {
  const list = $('#rows');
  const all = [...state.rows.values()];
  const shown = all.filter((r) => r.adhoc || (r.vr && !r.unreadable));   // an opened file stays, to say why it won't play
  const vr = all.filter((r) => r.vr);
  const pending = all.filter((r) => r.duration == null && !r.unreadable).length;
  // Rows appear once ffprobe confirms a VR frame; files opened directly always show.
  const ids = new Set(shown.map((r) => r.id));
  [...list.children].forEach((li) => { if (!ids.has(li.id.slice(4))) li.remove(); });
  const fresh = [];
  shown.forEach((r) => {
    const li = rowEl(r);
    if (!li.isConnected) fresh.push(li);
    list.appendChild(li);                            // keeps folder order
  });
  if (fresh.length && !staggered && !reduced()) {
    staggered = true;
    gsap.from(fresh, { autoAlpha: 0, y: 8, duration: 0.45, stagger: 0.04, ease: 'power3.out', clearProps: 'all' });
  }
  $('#lib-count').textContent = pending
    ? `Checking ${pending} video${pending === 1 ? '' : 's'}…`
    : `${vr.length} VR video${vr.length === 1 ? '' : 's'}`;
  $('#lib-empty').hidden = pending > 0 || vr.length > 0;
  if (!state.selected || !ids.has(state.selected)) {
    const first = shown.find(playable);
    if (first) select(first.id, false);
  } else select(state.selected, false);
}

function select(id, focus = true) {
  state.selected = id;
  document.querySelectorAll('.row').forEach((li) => li.setAttribute('aria-current', String(li.id === `row-${id}`)));
  const li = document.getElementById(`row-${id}`);
  if (li) { li.tabIndex = 0; if (focus) li.focus({ preventScroll: false }); }
  document.querySelectorAll('.row').forEach((x) => { if (x !== li) x.tabIndex = -1; });
}

async function loadFolder() {
  for (const [id, r] of state.rows) if (!r.adhoc) state.rows.delete(id);
  $('#rows').replaceChildren();
  staggered = false;
  const res = await call('listFolder');
  $('#lib-title').textContent = res.folderName;
  const emptyFolder = $('#empty-folder');            // replaced by the iPad's own empty-state title
  if (emptyFolder) emptyFolder.textContent = res.folderName;
  res.entries.forEach((r) => state.rows.set(r.id, { ...state.rows.get(r.id), ...r }));
  renderRows();
}

async function chooseFolder() {
  const r = await call('chooseFolder');
  if (r.changed) loadFolder();
}

async function openFile(files) {
  unlockMedia();
  if (PLATFORM === 'ipad') {                               // picked from Files: list them, play a single pick
    const res = await call('openFile', files ? { files } : {});
    if (!res) return;
    await loadFolder();
    select(res.first.id, false);
    if (res.count === 1) play(res.first.id);
    return;
  }
  const r = await call('openFile');
  if (!r) return;
  state.rows.set(r.id, { ...(state.rows.get(r.id) || {}), ...r, adhoc: true });
  renderRows();
  if (r.duration != null) play(r.id); else state.pendingPlay = r.id;
}

on('entry', (r) => {
  if (!state.rows.has(r.id)) return;   // late probe result from a previous folder
  updateRow(r);
  if (state.pendingPlay === r.id && (r.duration != null || r.unreadable)) {
    state.pendingPlay = null;
    if (!r.unreadable) play(r.id);
  }
});
on('open', (r) => {
  state.rows.set(r.id, { ...(state.rows.get(r.id) || {}), ...r, adhoc: true });
  renderRows();
  if (r.duration != null) play(r.id); else state.pendingPlay = r.id;
});
on('progress', ({ id, fraction }) => {
  const r = state.rows.get(id);
  if (r) { r.progress = fraction; r.partial = fraction; if (state.view === 'library') rowEl(r); }
  if (state.current?.id === id) { state.current.optimizedUntil = fraction; updateOptStatus(); }
});
on('optimized', ({ id }) => {
  const r = state.rows.get(id);
  if (r) { delete r.progress; delete r.partial; r.optimized = true; if (state.view === 'library') rowEl(r); }
  if (state.current?.id === id) { state.current.optimizedUntil = 1; updateOptStatus(); }
});
on('optimizeError', ({ id, message }) => {
  const r = state.rows.get(id);
  if (r) { delete r.progress; if (state.view === 'library') rowEl(r); }
  if (state.current?.id === id) showPrep('error', 'Optimizing failed', message);
});
on('saved', ({ file }) => {
  // The original was deleted; the saved copy is a normal video in the same folder.
  if (state.view !== 'library') { state.reloadOnLeave = file; return; }
  loadFolder().then(() => {
    const r = [...state.rows.values()].find((x) => x.file === file);
    if (r) select(r.id, false);
  });
});
on('folderChanged', () => { if (state.view === 'library') loadFolder(); else state.reloadOnLeave = true; });
on('menu', ({ action }) => {
  if (action === 'open') openFile();
  if (action === 'folder') { if (state.view === 'player') leave(); chooseFolder(); }
});
on('fullscreen', ({ on: isOn }) => {
  state.fullscreen = isOn;
  $('#btn-full use').setAttribute('href', isOn ? '#i-unfull' : '#i-full');
  $('#btn-full').setAttribute('aria-label', isOn ? 'Exit full screen' : 'Full screen');
});

$('#btn-folder').addEventListener('click', chooseFolder);
$('#btn-open').addEventListener('click', () => openFile());
// iPad: drop videos onto the app (Split View / Files) as well as picking them.
if (PLATFORM === 'ipad') {
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v)$/i.test(f.name));
    if (files.length) openFile(files);
  });
}
$('#lib-empty').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'folder') chooseFolder();
  if (act === 'open') openFile();
});

// ---------- Player ----------
let playSeq = 0;                     // a newer play() makes older prepare() replies stale
async function play(id) {
  const r = state.rows.get(id);
  if (!r || !playable(r)) return;
  if (state.view === 'player') leave();   // opening another video while one plays
  const seq = ++playSeq;
  state.playing = id;
  state.failedId = id;
  gsap.killTweensOf('#library, #player');
  state.view = 'player';
  document.body.dataset.view = 'player';
  const lib = $('#library');
  gsap.to(lib, { autoAlpha: 0, y: 10, duration: dur(0.3), ease: 'power2.in', onComplete: () => { lib.hidden = true; } });
  viewer.showGrid(false);
  $('#player').hidden = false;
  gsap.fromTo('#player', { autoAlpha: 0 }, { autoAlpha: 1, duration: dur(0.3) });
  setPlayIcon();
  gsap.set('#bar', { autoAlpha: 0, y: 10 });
  barShown = false;
  cursorIdle.restart(true);

  if (r.tooWide && !r.tryAnyway) {
    return showPrep('choice', 'Too wide to play smoothly on the iPad',
      `This video is ${r.width} pixels wide; the iPad’s decoder handles up to 4096. Send it to your Mac to convert (VR Player must be open there), or try it here anyway.`);
  }
  const needsPrep = r.needsOptimizing && !r.optimized;
  if (needsPrep) showPrep('wait');
  try {
    const info = await call('prepare', { id });
    if (seq !== playSeq || state.view !== 'player') return;
    state.current = { ...info, sourceLayout: r.layout };
    hidePrep();
    start(info);
  } catch (err) {
    if (seq !== playSeq || state.view !== 'player') return;
    showPrep('error', 'Can’t play this video', String(err.message || err));
  }
}

function start(info) {
  viewer.setVideo(video, info.layout);
  setLayoutLabel();
  $('#t-end').textContent = clock(info.duration);
  $('#seek').max = String(info.duration);
  updateOptStatus();
  video.src = PLATFORM === 'mac' ? `vr://${info.src}` : info.src;
  video.load();
  video.addEventListener('loadeddata', () => {
    if (video.currentTime > 1) video.currentTime = 0;    // HLS EVENT playlists must start at the top
    viewer.fadeVideoIn();
    video.play().catch(() => setBar(true));               // iPad blocked autoplay: show Play
  }, { once: true });
}

function leave() {
  if (state.view !== 'player') return;
  if (state.playing) call('stopped', { id: state.playing });
  state.playing = null;
  gsap.killTweensOf('#library, #player');
  video.pause();
  video.removeAttribute('src');
  video.load();                                         // release the decoder
  viewer.clearVideo();
  state.current = null;
  closeMenu();
  $('#keys').hidden = true;
  hidePrep();
  $('#buffering').hidden = true;
  state.view = 'library';
  document.body.dataset.view = 'library';
  document.body.classList.remove('hide-cursor');
  gsap.to('#player', { autoAlpha: 0, duration: dur(0.25), onComplete: () => { $('#player').hidden = true; } });
  const lib = $('#library');
  lib.hidden = false;
  gsap.fromTo(lib, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: dur(0.4), ease: 'power3.out' });
  viewer.recenter();
  viewer.showGrid(true);
  if (state.reloadOnLeave) { state.reloadOnLeave = null; loadFolder(); }
  renderRows();
  if (state.selected) select(state.selected);
}

function showPrep(kind, title, text) {
  const p = $('#prep');
  p.hidden = false;
  p.classList.toggle('error', kind === 'error');
  $('#prep-title').textContent = title || 'Preparing your video';
  $('#prep-text').textContent = text || 'Making a copy this Mac can play smoothly. It starts in a few seconds and keeps converting while you watch.';
  p.querySelector('.prep-actions').hidden = !['error', 'choice', 'info'].includes(kind);
  $('#btn-retry').hidden = kind !== 'error' || (!state.ffmpeg && /ffmpeg/.test(text || ''));
  $('#btn-share-mac').hidden = kind !== 'choice';
  $('#btn-try').hidden = kind !== 'choice';
  if (kind === 'wait' && !reduced()) {
    gsap.fromTo('.prep-line span', { xPercent: -110 }, { xPercent: 260, duration: 1.4, ease: 'power1.inOut', repeat: -1 });
  }
  gsap.fromTo(p, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: dur(0.35), ease: 'power2.out' });
}
function hidePrep() {
  gsap.killTweensOf('.prep-line span');
  $('#prep').hidden = true;
}
$('#btn-retry').addEventListener('click', () => {
  const id = state.failedId; leave(); if (id) setTimeout(() => play(id), dur(0.3) * 1000);
});
$('#btn-prep-back').addEventListener('click', leave);
$('#btn-try').addEventListener('click', () => {
  const id = state.failedId, r = state.rows.get(id);
  if (r) r.tryAnyway = true;
  leave(); setTimeout(() => play(id), dur(0.3) * 1000);
});
$('#btn-share-mac').addEventListener('click', async () => {
  try {
    await call('shareToMac', { id: state.failedId });
    showPrep('info', 'Sent to your Mac',
      'Your Mac converts it on its own. When it’s done, open the Mac library on this iPad and download the copy. Then delete this original in the Files app to free the space.');
  } catch (err) {
    if (err?.name !== 'AbortError') showPrep('choice', 'Couldn’t send it', String(err.message || err));
  }
});

/** iPadOS only lets a video start with sound inside a tap; touching the element there unlocks it. */
function unlockMedia() {
  if (PLATFORM === 'mac' || video.getAttribute('src')) return;
  video.muted = false;
  video.play().catch(() => {});
}

// Transport
const playIcon = $('#btn-play use');
function setPlayIcon() {
  const paused = video.paused;
  playIcon.setAttribute('href', paused ? '#i-play' : '#i-pause');
  $('#btn-play').setAttribute('aria-label', paused ? 'Play' : 'Pause');
}
function togglePlay() {
  if (!state.current) return;
  if (video.paused) video.play().catch(() => {}); else video.pause();
  flash(video.paused ? '#i-play' : '#i-pause');
}
function flash(icon) {
  if (reduced()) return;
  const f = $('#flash');
  f.querySelector('use').setAttribute('href', icon);
  gsap.fromTo(f, { autoAlpha: 0.9, scale: 0.85 }, { autoAlpha: 0, scale: 1.15, duration: 0.55, ease: 'power2.out' });
}
video.addEventListener('play', setPlayIcon);
video.addEventListener('pause', setPlayIcon);
video.addEventListener('waiting', () => { $('#buffering').hidden = false; });
video.addEventListener('playing', () => { $('#buffering').hidden = true; });
video.addEventListener('volumechange', () => {
  $('#btn-mute use').setAttribute('href', video.muted ? '#i-muted' : '#i-sound');
  $('#btn-mute').setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
});
video.addEventListener('error', () => {
  if (state.view === 'player' && video.getAttribute('src')) {
    const hint = state.current?.src.includes('/hls/')
      ? ' If it plays in QuickTime, try “Delete optimized copy” and open it again.'
      : ' The file may be damaged, or use a format macOS can’t play here.';
    showPrep('error', 'Can’t play this video', 'macOS couldn’t decode it.' + hint);
  }
});

$('#btn-play').addEventListener('click', togglePlay);
$('#btn-back').addEventListener('click', leave);
$('#btn-recenter').addEventListener('click', () => viewer.recenter());
$('#btn-mute').addEventListener('click', () => { video.muted = !video.muted; });
$('#btn-full').addEventListener('click', () => call('toggleFullscreen'));
$('#btn-full').hidden = !canFullscreen;

/** Latest second you can seek to: an unfinished copy only reaches as far as it's converted. */
function seekLimit() {
  const c = state.current;
  if (!c) return 0;
  if (c.optimizedUntil >= 1) return c.duration;
  const s = video.seekable;
  const listed = s.length ? s.end(s.length - 1) : 0;
  return Math.max(0, Math.min(c.duration * c.optimizedUntil, listed) - 4);
}
function seek(t) {
  if (!state.current) return;
  const lim = seekLimit();
  if (t > lim) {
    t = Math.max(lim, Math.min(t, video.currentTime));   // never jump back when pushing forward
    gsap.fromTo('#scrub-ready', { opacity: 1 }, { opacity: 0.4, duration: 0.15, yoyo: true, repeat: 3 });
  }
  video.currentTime = Math.max(0, t);
}

const seekEl = $('#seek');
let scrubbing = false;
seekEl.addEventListener('pointerdown', () => { scrubbing = true; });
seekEl.addEventListener('pointerup', () => { scrubbing = false; });
seekEl.addEventListener('input', () => {
  const lim = seekLimit();
  if (+seekEl.value > lim) seekEl.value = String(lim);
  seek(+seekEl.value);
});

function updateOptStatus() {
  const c = state.current, el = $('#opt-status');
  const f = c?.optimizedUntil ?? 1;
  $('#scrub-ready').style.transform = `scaleX(${f})`;
  if (!c || f >= 1) { el.hidden = true; return; }
  const left = (c.duration * (1 - f)) / OPT_SPEED;
  el.hidden = false;
  el.textContent = `Optimizing for this Mac · ${Math.round(f * 100)}% · about ${hm(left)} left · you can seek within the lighter part`;
}

gsap.ticker.add(() => {
  const c = state.current;
  if (!c) return;
  const t = video.currentTime || 0;
  $('#scrub-played').style.transform = `scaleX(${Math.min(1, t / c.duration)})`;
  if (!scrubbing) seekEl.value = String(t);
  $('#t-now').textContent = clock(t);
});

// Layout menu
const LAYOUTS = [
  { projection: 180, stereo: 'sbs', label: '180° · 3D side by side' },
  { projection: 180, stereo: 'tb', label: '180° · 3D over-under' },
  { projection: 180, stereo: 'mono', label: '180° · flat' },
  { projection: 360, stereo: 'sbs', label: '360° · 3D side by side' },
  { projection: 360, stereo: 'tb', label: '360° · 3D over-under' },
  { projection: 360, stereo: 'mono', label: '360° · flat' },
];
function setLayoutLabel() {
  const c = state.current;
  // An optimized copy is already one eye; name it by the original's layout.
  const shown = c.layout.stereo === 'mono' && c.sourceLayout ? { ...c.sourceLayout, projection: c.layout.projection } : c.layout;
  $('#layout-label').textContent = layoutName(shown);
}
function openMenu() {
  const c = state.current;
  if (!c) return;
  const menu = $('#layout-menu');
  const optimizedCopy = c.src.includes('/hls/');
  const items = optimizedCopy ? LAYOUTS.filter((l) => l.stereo === 'mono') : LAYOUTS;
  menu.innerHTML = `<div class="menu-title">${optimizedCopy ? 'Projection (the copy shows one eye)' : 'Video layout'}</div>` +
    items.map((l, i) => `${i === 3 && !optimizedCopy ? '<div class="menu-sep"></div>' : ''}<button class="menu-item" role="menuitemradio" type="button"
      aria-checked="${l.projection === c.layout.projection && l.stereo === c.layout.stereo}"
      data-p="${l.projection}" data-s="${l.stereo}">${optimizedCopy ? l.label.replace(' · flat', '') : l.label}</button>`).join('');
  menu.hidden = false;
  $('#btn-layout').setAttribute('aria-expanded', 'true');
  gsap.fromTo(menu, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: dur(0.18), ease: 'power2.out' });
  (menu.querySelector('[aria-checked="true"]') || menu.querySelector('.menu-item')).focus();
}
function closeMenu() {
  const menu = $('#layout-menu');
  if (menu.hidden) return false;
  menu.hidden = true;
  $('#btn-layout').setAttribute('aria-expanded', 'false');
  return true;
}
$('#btn-layout').addEventListener('click', () => ($('#layout-menu').hidden ? openMenu() : closeMenu()));
$('#layout-menu').addEventListener('click', (e) => {
  const b = e.target.closest('.menu-item');
  if (!b) return;
  state.current.layout = { projection: +b.dataset.p, stereo: b.dataset.s };
  if (!state.current.src.includes('/hls/')) state.current.sourceLayout = state.current.layout;
  viewer.setLayout(state.current.layout);
  viewer.recenter();
  setLayoutLabel();
  closeMenu();
  $('#btn-layout').focus();
});
$('#layout-menu').addEventListener('keydown', (e) => {
  const items = [...$('#layout-menu').querySelectorAll('.menu-item')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu-wrap')) closeMenu(); });

// Control bar: hidden until you double-click the video; double-click again hides it.
let barShown = false;
function setBar(show) {
  barShown = show;
  if (!show) closeMenu();
  gsap.to('#bar', show
    ? { autoAlpha: 1, y: 0, duration: dur(0.18), ease: 'power2.out', overwrite: 'auto' }
    : { autoAlpha: 0, y: 10, duration: dur(0.25), ease: 'power2.in', overwrite: 'auto' });
}
viewer.onDoubleClick = () => (state.view === 'player' ? setBar(!barShown) : viewer.recenter());

// The cursor fades out over the video when it sits still.
const cursorIdle = gsap.delayedCall(2.5, () => {
  if (state.view === 'player' && !barShown) document.body.classList.add('hide-cursor');
});
addEventListener('pointermove', () => {
  document.body.classList.remove('hide-cursor');
  if (state.view === 'player') cursorIdle.restart(true);
});

// ---------- iPad ----------
/** Mac: the panel that shares this library on Wi-Fi (QR code, link, on/off). */
function initIPadPanel() {
  const panel = $('#ipad-panel'), btn = $('#btn-ipad'), sw = $('#share-switch');
  const render = (s) => {
    sw.setAttribute('aria-checked', String(!!s.on));
    $('#share-on').hidden = !s.ready;
    $('#share-wait').hidden = !(s.on && !s.ready);
    if (s.ready) {
      $('#share-qr').src = s.qr || '';
      $('#share-url').textContent = s.url || '';
      $('#share-ip').textContent = s.ipURL ? `or ${s.ipURL}` : '';
    }
  };
  const open = async () => {
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    gsap.fromTo(panel, { autoAlpha: 0, y: -6 }, { autoAlpha: 1, y: 0, duration: dur(0.2), ease: 'power2.out' });
    render(await call('shareState'));
    sw.focus();
  };
  const close = () => { if (panel.hidden) return false; panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); return true; };
  state.closeIPadPanel = close;
  btn.addEventListener('click', () => (panel.hidden ? open() : close()));
  $('#btn-ipad-close').addEventListener('click', close);
  sw.addEventListener('click', async () => {
    const on = sw.getAttribute('aria-checked') !== 'true';
    render({ on, ready: false });
    render(await call('setShare', { on }));
  });
  $('#btn-new-link').addEventListener('click', async () => render(await call('newShareLink')));
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !e.target.closest('#ipad-panel, #btn-ipad')) close();
  });
}

/** iPad (offline app, HTTPS): turning the iPad turns the view. iPadOS asks once, inside a tap. */
const motion = $('#btn-motion');
if (PLATFORM === 'ipad' && 'DeviceOrientationEvent' in window && isSecureContext) {
  motion.hidden = false;
  motion.addEventListener('click', async () => {
    const on = motion.getAttribute('aria-pressed') !== 'true';
    if (on && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const answer = await DeviceOrientationEvent.requestPermission().catch(() => 'denied');
      if (answer !== 'granted') return showPrep('info', 'Motion is off', 'Allow Motion & Orientation Access for this app in Settings › Safari, then try again.');
    }
    viewer.setGyro(on);
    motion.setAttribute('aria-pressed', String(on));
  });
}

// ---------- Keyboard ----------
function rowsNav(e) {
  const rows = [...document.querySelectorAll('.row')].filter((li) => li.getAttribute('aria-disabled') !== 'true');
  if (!rows.length) return;
  const i = rows.findIndex((li) => li.id === `row-${state.selected}`);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = rows[clampIndex(i + (e.key === 'ArrowDown' ? 1 : -1), rows.length)];
    select(next.id.slice(4));
  } else if (e.key === 'Enter' && i >= 0) {
    e.preventDefault();
    play(state.selected);
  }
}
const clampIndex = (i, n) => Math.max(0, Math.min(n - 1, i));

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target instanceof Element ? e.target : document.body;
  if (state.view === 'library') {
    if (e.key === 'Escape' && state.closeIPadPanel?.()) return;
    if (target.closest('button, a, #ipad-panel') && (e.key === 'Enter' || target.closest('#ipad-panel'))) return;
    return rowsNav(e);
  }
  if (!$('#layout-menu').hidden && e.key !== 'Escape') return;
  const k = e.key.toLowerCase();
  const onButton = target.closest('button:not(#btn-layout)');   // Space on the layout chip still plays/pauses
  if (e.key === ' ' && !onButton) { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(video.currentTime - 10); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seek(video.currentTime + 10); }
  else if (k === 'j') seek(video.currentTime - 30);
  else if (k === 'l') seek(video.currentTime + 30);
  else if (k === 'w') viewer.nudge(0, 12);
  else if (k === 's') viewer.nudge(0, -12);
  else if (k === 'a') viewer.nudge(-15, 0);
  else if (k === 'd') viewer.nudge(15, 0);
  else if (k === 'r') viewer.recenter();
  else if (k === 'm') video.muted = !video.muted;
  else if (k === 'f') call('toggleFullscreen');
  else if (e.key === '?') { $('#keys').hidden = !$('#keys').hidden; }
  else if (e.key === 'Escape') {
    e.preventDefault();
    if (closeMenu()) return $('#btn-layout').focus();
    if (!$('#keys').hidden) { $('#keys').hidden = true; return; }
    if (state.fullscreen) return call('toggleFullscreen');
    leave();
  }
});

// ---------- Boot ----------
function setupPlatform() {
  const touch = matchMedia('(hover: none)').matches;
  $('.lib-hint').textContent = touch
    ? 'Drag to look around · Double-tap the video for controls'
    : 'Drag to look around · Double-click the video for controls · Return plays';
  if (PLATFORM === 'lan') {
    $('#btn-offline').href = `${PAGES_URL}#mac=${encodeURIComponent(location.href.split('#')[0])}`;
  }
  if (PLATFORM === 'ipad') {
    $('#btn-open').lastChild.textContent = 'Open video…';
    $('#empty-title').textContent = 'No videos open';
    $('#empty-text').textContent = 'Pick a VR video from the Files app. Copies converted on your Mac play best.';
    // The Mac library's address arrives once, from its “Offline iPad app” link.
    const m = location.hash.match(/^#mac=(.+)$/);
    try {
      if (m) { localStorage.setItem('macURL', decodeURIComponent(m[1])); history.replaceState(null, '', location.pathname); }
      const mac = localStorage.getItem('macURL');
      if (mac) { $('#btn-maclib').href = mac; $('#btn-maclib').hidden = false; }
    } catch { /* private mode: no remembered Mac */ }
  }
}
setupPlatform();

(async () => {
  const s = await call('state');
  state.ffmpeg = s.ffmpeg;
  $('#ffmpeg-banner').hidden = s.ffmpeg;
  state.fullscreen = await call('isFullscreen');
  if (PLATFORM === 'mac') initIPadPanel();
  await loadFolder();
  gsap.from('.lib-head, .lib-hint', { autoAlpha: 0, y: 8, duration: dur(0.5), stagger: 0.06, ease: 'power3.out', clearProps: 'all' });
})().catch((err) => {
  $('#lib-count').textContent = `Couldn’t read the folder: ${err.message || err}`;
});

// Debug hook for scripted verification (window.vr in the Web Inspector).
window.vr = { viewer, video, state, play, leave, seek, limits, openFile };
