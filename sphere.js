import * as THREE from 'three';
import { FOV_MIN, FOV_MAX, clamp, limits, drag, rubber, eyeUV, sphereArc, deviceQuaternion } from './view-math.js';

const D2R = Math.PI / 180;
const HOME_FOV = 75;

/**
 * The inside of a sphere, looked at from its centre. One render loop (gsap.ticker);
 * one object (`view`) that drags, inertia and recentre all move. FOV alone is smoothed by quickTo.
 */
export class Viewer {
  constructor(host) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); // the video limits detail, not the canvas
    this.renderer.setClearColor(0x000000);
    this.canvas = this.renderer.domElement;
    host.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(HOME_FOV, 1, 0.1, 1100);
    this.camera.rotation.order = 'YXZ';

    this.view = { lon: 0, lat: 0, fov: HOME_FOV };
    this.fovTarget = HOME_FOV;          // where the quickTo zoom is heading
    this.projection = 360;
    this.drifting = true;               // library: the wireframe turns slowly
    this.dragging = false;
    this.release = null;                // inertia / snap-back tween, killed by reference
    this.dirty = 2;
    this.onDoubleClick = () => this.recenter();

    this.grid = makeGrid();
    this.scene.add(this.grid);

    gsap.registerPlugin(InertiaPlugin);
    this.motion = gsap.matchMedia();
    this.motion.add({ reduce: '(prefers-reduced-motion: reduce)', ok: '(prefers-reduced-motion: no-preference)' }, (ctx) => {
      this.reduced = ctx.conditions.reduce;
      this.zoomTo = gsap.quickTo(this.view, 'fov', { duration: this.reduced ? 0 : 0.35, ease: 'power3' });
    });

    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(host);
    this.resize();
    this.bindInput();

    this.tick = this.tick.bind(this);
    gsap.ticker.add(this.tick);
  }

  resize() {
    const w = this.canvas.parentElement.clientWidth, h = this.canvas.parentElement.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.dirty = 2;
  }

  // With motion on, drag is only an offset on top of where the iPad points, so it isn't clamped.
  get limits() { return limits(this.gyro ? 360 : this.projection, this.view.fov, this.camera.aspect); }

  // ---- Content ----

  showGrid(on) {
    this.drifting = on && !this.reduced;
    gsap.to(this.grid.material, { opacity: on ? 1 : 0, duration: this.reduced ? 0 : 0.6, ease: 'power2.out',
      onStart: () => { if (on) this.grid.visible = true; },
      onComplete: () => { this.grid.visible = on; } });
  }

  setVideo(video, layout) {
    this.clearVideo();
    this.video = video;
    this.texture = new THREE.VideoTexture(video);       // GPU-to-GPU upload path in WebKit
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, opacity: 0, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.scene.add(this.mesh);
    this.setLayout(layout);
    this.markFrames = () => { this.dirty = 3; };
    video.addEventListener('seeked', this.markFrames);
    video.addEventListener('loadeddata', this.markFrames);
  }

  setLayout({ projection, stereo }) {
    this.projection = projection;
    if (!this.mesh) return;
    const { phiStart, phiLength } = sphereArc(projection);
    const geo = new THREE.SphereGeometry(500, 96, 64, phiStart, phiLength);
    geo.scale(-1, 1, 1);                                  // inside-out, and not mirrored
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    const uv = eyeUV(stereo);
    this.texture.repeat.set(...uv.repeat);
    this.texture.offset.set(...uv.offset);
    this.dirty = 2;
  }

  fadeVideoIn() {
    if (!this.material) return;
    const t = this.reduced ? 0 : 1.1;
    gsap.to(this.material, { opacity: 1, duration: t * 0.7, ease: 'power2.out', onUpdate: () => { this.dirty = 1; } });
    // The one authored moment: a slow settle from wide into the home view.
    // One owner for the view: no recentre tween racing this one.
    this.release?.kill();
    this.view.lon = 0;
    this.fovTarget = HOME_FOV;
    this.release = gsap.fromTo(this.view, { lat: this.reduced ? 0 : 6, fov: this.reduced ? HOME_FOV : 96 },
      { lat: 0, fov: HOME_FOV, duration: t * 1.3, ease: 'power3.out' });
  }

  clearVideo() {
    if (!this.mesh) return;
    this.video?.removeEventListener('seeked', this.markFrames);
    this.video?.removeEventListener('loadeddata', this.markFrames);
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose(); this.material.dispose(); this.texture.dispose();
    this.mesh = this.material = this.texture = this.video = null;
    this.projection = 360;
    this.dirty = 2;
  }

  // ---- Motion ----

  recenter() {
    this.release?.kill();
    this.gyroYaw = null;                                 // motion: wherever the iPad points becomes the centre
    this.view.lon = ((this.view.lon % 360) + 540) % 360 - 180;   // same view, short way home
    this.release = gsap.to(this.view, { lon: 0, lat: 0, duration: this.reduced ? 0 : 0.6, ease: 'power3.inOut' });
    this.zoomTo(this.fovTarget = HOME_FOV);
  }

  nudge(dLon, dLat) {
    const l = this.limits;
    this.release?.kill();
    this.zoomTo(this.fovTarget);                         // an interrupted intro still lands on the home fov
    this.release = gsap.to(this.view, {
      lon: clamp(this.view.lon + dLon, -l.lon, l.lon), lat: clamp(this.view.lat + dLat, -l.lat, l.lat),
      duration: this.reduced ? 0 : 0.35, ease: 'power2.out',
    });
  }

  /** iPad motion: device orientation drives the camera; a drag adds yaw/pitch on top. */
  setGyro(on) {
    removeEventListener('deviceorientation', this.onOrient);
    this.gyro = on;
    this.orient = null;
    this.gyroYaw = null;
    if (on) {
      this.onOrient = (e) => { if (e.alpha != null) this.orient = e; };
      addEventListener('deviceorientation', this.onOrient);
    }
    this.view.lon = 0; this.view.lat = 0;
    this.camera.quaternion.identity();
    this.dirty = 2;
  }

  zoom(delta) {
    this.release?.kill();                               // zooming takes over from any glide
    this.zoomTo(this.fovTarget = clamp(this.fovTarget + delta, FOV_MIN, FOV_MAX));
  }

  bindInput() {
    const c = this.canvas;
    let last = null, raw = null;
    InertiaPlugin.track(this.view, 'lon,lat');

    let down = null, lastTap = null;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      c.setPointerCapture(e.pointerId);
      c.classList.add('dragging');
      this.release?.kill();
      this.zoomTo(this.fovTarget);
      this.dragging = true;
      this.drifting = false;
      last = { x: e.clientX, y: e.clientY };
      raw = { lon: this.view.lon, lat: this.view.lat };
    });

    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const next = drag(raw, e.clientX - last.x, e.clientY - last.y, this.view.fov, c.clientHeight);
      last = { x: e.clientX, y: e.clientY };
      raw = next;
      const l = this.limits;
      this.view.lon = rubber(next.lon, l.lon);
      this.view.lat = rubber(next.lat, l.lat);
    });

    const end = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      c.classList.remove('dragging');
      if (c.hasPointerCapture?.(e.pointerId)) c.releasePointerCapture(e.pointerId);
      this.settle(true);
      // Touch has no reliable dblclick: two quick taps close together count as one.
      if (e.type === 'pointerup' && e.pointerType === 'touch' && down
          && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 10 && e.timeStamp - down.t < 300) {
        const tap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
        if (lastTap && tap.t - lastTap.t < 350 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 40) {
          lastTap = null;
          this.touchDoubleAt = e.timeStamp;
          this.onDoubleClick();
        } else lastTap = tap;
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    // Safari may also send dblclick for the same double-tap; don't toggle twice.
    c.addEventListener('dblclick', (e) => { if (!(e.timeStamp - (this.touchDoubleAt ?? -1e9) < 600)) this.onDoubleClick(); });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const scale = e.ctrlKey ? 0.25 : e.deltaMode === 1 ? 1.2 : 0.045;   // pinch arrives as ctrl+wheel
      this.zoom(e.deltaY * scale);
    }, { passive: false });

    let gestureStart = HOME_FOV;                          // Safari trackpad pinch
    c.addEventListener('gesturestart', (e) => { e.preventDefault(); this.release?.kill(); gestureStart = this.view.fov; });
    c.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      this.zoomTo(this.fovTarget = clamp(gestureStart / e.scale, FOV_MIN, FOV_MAX));
    });
  }

  /** After a drag: snap back past the edge with an elastic band, otherwise glide to rest. */
  settle(fromRelease) {
    const l = this.limits;
    const over = Math.abs(this.view.lon) > l.lon || Math.abs(this.view.lat) > l.lat;
    if (over) {
      this.release = gsap.to(this.view, {
        lon: clamp(this.view.lon, -l.lon, l.lon), lat: clamp(this.view.lat, -l.lat, l.lat),
        duration: this.reduced ? 0 : 0.9, ease: 'elastic.out(1, 0.6)',
      });
    } else if (fromRelease && !this.reduced) {
      const bounded = (lim) => (Number.isFinite(lim) ? { velocity: 'auto', min: -lim, max: lim } : { velocity: 'auto' });
      this.release = gsap.to(this.view, {
        inertia: { lon: bounded(l.lon), lat: bounded(l.lat), resistance: 260 },
        duration: { min: 0.2, max: 1.6 },
      });
    }
  }

  tick(time, deltaMs) {
    const v = this.view;
    if (this.drifting && !this.dragging) v.lon += (deltaMs / 1000) * 2.5;
    // Zoom can shrink the room left in a 180° world; ease back inside without a jump.
    if (!this.dragging && !this.release?.isActive() && this.projection === 180 && !this.gyro) {
      const l = this.limits;
      const lon = clamp(v.lon, -l.lon, l.lon), lat = clamp(v.lat, -l.lat, l.lat);
      if (lon !== v.lon || lat !== v.lat) { v.lon += (lon - v.lon) * 0.25; v.lat += (lat - v.lat) * 0.25; }
    }
    const cam = this.camera;
    if (this.gyro) return this.tickGyro(cam, v);
    const changed = cam.rotation.y !== -v.lon * D2R || cam.rotation.x !== v.lat * D2R || cam.fov !== v.fov;
    if (changed) {
      cam.rotation.y = -v.lon * D2R;
      cam.rotation.x = v.lat * D2R;
      if (cam.fov !== v.fov) { cam.fov = v.fov; cam.updateProjectionMatrix(); }
    }
    const playing = this.video && !this.video.paused;
    if (changed || playing || this.dirty > 0 || this.drifting) {
      this.renderer.render(this.scene, cam);
      if (this.dirty > 0) this.dirty--;
    }
  }
}

const qDevice = new THREE.Quaternion(), qYaw = new THREE.Quaternion(), qPitch = new THREE.Quaternion();
const AXIS_Y = new THREE.Vector3(0, 1, 0), AXIS_X = new THREE.Vector3(1, 0, 0), fwd = new THREE.Vector3();

Viewer.prototype.tickGyro = function (cam, v) {
  if (this.orient) {
    const o = this.orient;
    const screenAngle = screen.orientation?.angle ?? window.orientation ?? 0;
    qDevice.set(...deviceQuaternion(o.alpha, o.beta, o.gamma, screenAngle));
    if (this.gyroYaw == null) {                          // turn the world so the video's centre is ahead
      fwd.set(0, 0, -1).applyQuaternion(qDevice);
      this.gyroYaw = -Math.atan2(-fwd.x, -fwd.z);
    }
    qYaw.setFromAxisAngle(AXIS_Y, this.gyroYaw - v.lon * D2R);
    qPitch.setFromAxisAngle(AXIS_X, v.lat * D2R);
    cam.quaternion.copy(qYaw).multiply(qDevice).multiply(qPitch);
  }
  if (cam.fov !== v.fov) { cam.fov = v.fov; cam.updateProjectionMatrix(); }
  this.renderer.render(this.scene, cam);
};

/** Lat/long lines every 15°, horizon a little brighter. */
function makeGrid() {
  const R = 480, pts = [], seg = 96;
  const p = (lat, lon) => {
    const a = lat * D2R, b = lon * D2R;
    return [R * Math.cos(a) * Math.sin(b), R * Math.sin(a), -R * Math.cos(a) * Math.cos(b)];
  };
  for (let lat = -75; lat <= 75; lat += 15) {
    for (let i = 0; i < seg; i++) pts.push(...p(lat, (i / seg) * 360), ...p(lat, ((i + 1) / seg) * 360));
  }
  for (let lon = 0; lon < 360; lon += 15) {
    for (let i = 0; i < seg / 2; i++) pts.push(...p(-90 + (i / (seg / 2)) * 180, lon), ...p(-90 + ((i + 1) / (seg / 2)) * 180, lon));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xede8e0, transparent: true, opacity: 1, depthWrite: false });
  const lines = new THREE.LineSegments(geo, mat);
  lines.material.color.multiplyScalar(0.1);           // faint, without alpha sorting games
  return lines;
}
