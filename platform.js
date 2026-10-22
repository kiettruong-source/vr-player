// How the page reaches its library:
//   mac   the Mac window, through the native bridge
//   lan   an iPad streaming from the Mac over Wi-Fi (served under /<secret>/): HTTP API + polling
//   ipad  the offline iPad app (GitHub Pages / Home Screen): files picked on the iPad
import { localCall } from './local.js';

export const PAGES_URL = 'https://kiettruong-source.github.io/vr-player/';

export const PLATFORM = window.webkit?.messageHandlers?.native ? 'mac'
  : /^\/[0-9a-f]{32}\//.test(location.pathname) ? 'lan' : 'ipad';
document.body.dataset.platform = PLATFORM;

const handlers = {};
export const on = (event, fn) => { (handlers[event] ||= []).push(fn); };
export const receive = ({ event, payload }) => (handlers[event] || []).forEach((fn) => fn(payload));

async function lanCall(cmd, args = {}) {
  const r = await fetch('api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd, ...args }) });
  const j = await r.json().catch(() => ({ error: `The Mac answered ${r.status}.` }));
  if (j.error) throw new Error(j.error);
  return j.value;
}

// Full screen is the browser's own on the iPad; the Mac window does it natively.
const goFull = () => (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)?.call(document.documentElement);
const exitFull = () => (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
const browserUI = {
  isFullscreen: () => isFull(),
  toggleFullscreen: () => (isFull() ? exitFull() : canFullscreen ? goFull() : null),
};
export const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
// iPadOS Safari's element full screen adds its own one-finger swipe-down and pan-down gestures that
// exit full screen and can't be blocked by the page (WebKit WKFullScreenWindowControllerIOS), so
// dragging to look up would throw you out. On a touch screen, full screen means the Home Screen app.
export const touchScreen = navigator.maxTouchPoints > 1 || matchMedia('(hover: none)').matches;
export const canFullscreen = PLATFORM === 'mac'
  || (!touchScreen && !standalone && !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen));
if (PLATFORM !== 'mac') {
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, () => receive({ event: 'fullscreen', payload: { on: isFull() } }));
  }
}

export const call = PLATFORM === 'mac'
  ? (cmd, args = {}) => window.webkit.messageHandlers.native.postMessage({ cmd, ...args })
  : async (cmd, args = {}) => {
    if (browserUI[cmd]) return browserUI[cmd]();
    return PLATFORM === 'lan' ? lanCall(cmd, args) : localCall(cmd, args);
  };

window.native = { call, on, receive };    // the Mac pushes its events through window.native.receive

if (PLATFORM === 'lan') {
  // The Mac's events (conversion progress, new files) arrive by polling once a second.
  (async () => {
    let since = Number.MAX_SAFE_INTEGER;
    for (;;) {
      try {
        const res = await lanCall('poll', { since });
        if (since !== Number.MAX_SAFE_INTEGER && res.seq >= since) res.events.forEach(receive);
        since = res.seq;                                   // also resets when the Mac app restarted
      } catch { /* Mac asleep or off this Wi-Fi: keep trying */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
}

if (PLATFORM === 'ipad' && 'serviceWorker' in navigator && isSecureContext && location.hostname !== 'localhost') {   // not while developing
  navigator.serviceWorker.register('sw.js').catch(() => {});   // makes the Home Screen app open offline
}
