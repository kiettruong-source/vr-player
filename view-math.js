// Pure view maths for the sphere. Degrees throughout.
// lon > 0 looks right, lat > 0 looks up. Tested by test/view-math.test.mjs.

export const FOV_MIN = 35, FOV_MAX = 100, PITCH_MAX_360 = 85;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Horizontal field of view from the camera's vertical one. */
export const hfov = (vfov, aspect) => deg(2 * Math.atan(Math.tan(rad(vfov) / 2) * aspect));

/** How far the view centre may travel before the frame edge leaves the video. */
export function limits(projection, vfov, aspect) {
  if (projection !== 180) return { lon: Infinity, lat: PITCH_MAX_360 };
  return {
    lon: Math.max(0, 90 - hfov(vfov, aspect) / 2),
    lat: Math.max(0, Math.min(PITCH_MAX_360, 90 - vfov / 2)),
  };
}

/** Grab-style drag: the image follows the pointer. Degrees per pixel ≈ vfov / height. */
export function drag(view, dx, dy, vfov, heightPx) {
  const k = vfov / heightPx;
  return { lon: view.lon - dx * k, lat: view.lat + dy * k };
}

/** Past a limit, motion meets resistance (the rubber band), never a hard wall. */
export function rubber(v, limit, give = 0.35) {
  if (!Number.isFinite(limit) || Math.abs(v) <= limit) return v;
  return Math.sign(v) * (limit + (Math.abs(v) - limit) * give);
}

/** Texture repeat/offset that shows the left eye (VideoTexture.flipY = true, so v=1 is the frame top). */
export function eyeUV(stereo) {
  if (stereo === 'sbs') return { repeat: [0.5, 1], offset: [0, 0] };
  if (stereo === 'tb') return { repeat: [1, 0.5], offset: [0, 0.5] };
  return { repeat: [1, 1], offset: [0, 0] };
}

/** SphereGeometry phiStart/phiLength (radians) so the frame centre faces the default camera (-Z). */
export function sphereArc(projection) {
  const len = projection === 180 ? Math.PI : 2 * Math.PI;
  return { phiStart: -Math.PI / 2 - len / 2, phiLength: len };
}

/** 1:02:03 / 4:05 */
export function clock(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? `${h}:` : '') + `${mm}:${String(x).padStart(2, '0')}`;
}


/** Same rules as guessLayout in Media.swift, minus the SSIM check (the iPad has no ffmpeg):
 *  filename hints win; a square eye is 180°, a 2:1 eye is 360°. */
export function guessLayout(name, width, height) {
  const n = name.toLowerCase();
  const has = (t) => t.some((s) => n.includes(s));
  const nameProjection = has(['180']) ? 180 : has(['360']) ? 360 : null;
  const nameStereo = has(['_lr', '-lr', ' lr', 'sbs', '3dh', 'half-sbs', 'fullsbs']) ? 'sbs'
    : has(['_tb', '-tb', '_ou', '-ou', 'overunder', 'over-under', '3dv']) ? 'tb'
    : has(['_mono', '-mono', ' mono']) ? 'mono' : null;
  const aspect = height > 0 ? width / height : 2;
  let stereo = Math.abs(aspect - 1) < 0.1 ? 'tb' : Math.abs(aspect - 4) < 0.2 ? 'sbs' : 'mono';
  stereo = nameStereo ?? stereo;
  const eye = (aspect / (stereo === 'sbs' ? 2 : 1)) * (stereo === 'tb' ? 2 : 1);
  return { projection: nameProjection ?? (Math.abs(eye - 1) < 0.1 ? 180 : 360), stereo };
}

/** Camera orientation [x, y, z, w] from a deviceorientation event (degrees) and the screen angle,
 *  as three.js's former DeviceOrientationControls did: Euler(beta, alpha, -gamma, 'YXZ'),
 *  then -90° about X (the camera looks out of the back of the device), then -screen about Z. */
export function deviceQuaternion(alpha, beta, gamma, screenAngle = 0) {
  const r = Math.PI / 180;
  const [x, y, z] = [beta * r / 2, alpha * r / 2, -gamma * r / 2];
  const [c1, c2, c3, s1, s2, s3] = [Math.cos(x), Math.cos(y), Math.cos(z), Math.sin(x), Math.sin(y), Math.sin(z)];
  let q = [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
  q = qmul(q, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  const o = (-screenAngle * r) / 2;
  return qmul(q, [0, 0, Math.sin(o), Math.cos(o)]);
}

export function qmul([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [ax * bw + aw * bx + ay * bz - az * by, ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz];
}

/** Rotate a vector by a quaternion. */
export function qrotate([x, y, z, w], [vx, vy, vz]) {
  const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
