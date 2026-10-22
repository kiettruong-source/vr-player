// The offline iPad app's library: whatever you pick from Files in this session.
// iPadOS gives web apps no lasting access to files, so the list starts empty each launch.
import { guessLayout } from './view-math.js';

const files = new Map();               // id -> { file, row, url }
let nextId = 1;

function pick() {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'video/*,.mp4,.mov,.m4v', multiple: true });
    input.onchange = () => resolve([...input.files]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** Size and length from the file itself (no ffprobe here). */
function measure(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (r) => { URL.revokeObjectURL(url); v.removeAttribute('src'); resolve(r); };
    v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => done({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
    v.onerror = () => done(null);
    v.src = url;
  });
}

async function add(file) {
  const id = `f${nextId++}`;
  const row = { id, name: file.name.replace(/\.[^.]+$/, ''), file: file.name, adhoc: true, vr: true };
  const m = await measure(file);
  if (!m) Object.assign(row, { unreadable: true });
  else {
    Object.assign(row, m, { layout: guessLayout(file.name, m.width, m.height), needsOptimizing: false });
    // Same decoder limit as the Mac's M1 (assumed for the M-chip iPad): wider H.264 stutters.
    row.tooWide = m.width > 4096 || m.height > 4096;
  }
  files.set(id, { file, row });
  return row;
}

export async function localCall(cmd, args = {}) {
  switch (cmd) {
    case 'state': return { ffmpeg: true, folderName: 'On this iPad' };
    case 'listFolder': return { folderName: 'On this iPad', entries: [...files.values()].map((f) => f.row) };
    case 'openFile': {
      const picked = args.files ?? await pick();          // files can also come from a drop
      const rows = [];
      for (const f of picked) rows.push(await add(f));
      return rows.length ? { first: rows[0], count: rows.length } : null;
    }
    case 'prepare': {
      const f = files.get(args.id);
      if (!f) throw new Error('This video is no longer open. Pick it again with Open video….');
      f.url ||= URL.createObjectURL(f.file);
      return { id: args.id, name: f.row.name, duration: f.row.duration, src: f.url, layout: f.row.layout, optimizedUntil: 1 };
    }
    case 'shareToMac': {
      const f = files.get(args.id);
      if (!f) throw new Error('This video is no longer open.');
      if (!navigator.canShare?.({ files: [f.file] })) {
        throw new Error('Sharing files isn’t available here. In the Files app, share the video with AirDrop to your Mac instead.');
      }
      await navigator.share({ files: [f.file], title: f.row.name });
      return true;
    }
    default: return null;                 // probe, stopped, reveal, deleteOptimized: nothing to do here
  }
}
