// Terrain height data for the Glamis (Imperial Sand Dunes) map.
// Shared by the renderer (as textures) and the vehicle physics (CPU sampling),
// so both agree on the exact ground surface.
//
// World axes: +X = east, +Z = south, +Y = up. Units are meters.
// Origin is lat 32.955 N, lon 115.11 W, between Gecko Road and Glamis.

export class TerrainData {
  constructor(meta, fineU16, coarseU16) {
    this.meta = meta;
    const s = meta.scale, b = meta.base;
    this.fineN = meta.fine.n;
    this.fineSize = meta.fine.size;
    this.fineCell = this.fineSize / this.fineN;
    this.coarseN = meta.coarse.n;
    this.coarseSize = meta.coarse.size;
    this.coarseCell = this.coarseSize / this.coarseN;
    this.fine = new Float32Array(fineU16.length);
    for (let i = 0; i < fineU16.length; i++) this.fine[i] = fineU16[i] * s + b;
    this.coarse = new Float32Array(coarseU16.length);
    for (let i = 0; i < coarseU16.length; i++) this.coarse[i] = coarseU16[i] * s + b;
    // taller dunes: the relief above the surrounding ground (a ~1 km average) is raised by RELIEF_GAIN
    exaggerate(this.fine, this.fineN, this.fineCell);
    exaggerate(this.coarse, this.coarseN, this.coarseCell);
    // Blend band (meters) at the edge of the detailed area.
    this.blend = 600;
    this._out = { h: 0, dx: 0, dz: 0 };
  }

  static async load(baseUrl, fetchFn = fetch) {
    const meta = await (await fetchFn(baseUrl + 'terrain.json')).json();
    const [f, c] = await Promise.all([
      fetchFn(baseUrl + 'height_fine.u16').then(r => r.arrayBuffer()),
      fetchFn(baseUrl + 'height_coarse.u16').then(r => r.arrayBuffer()),
    ]);
    return new TerrainData(meta, new Uint16Array(f), new Uint16Array(c));
  }

  // Cubic B-spline sample with analytic gradient. Matches the GLSL version.
  _bspline(arr, n, cell, size, x, z, out) {
    const u = (x + size * 0.5) / cell - 0.5;
    const v = (z + size * 0.5) / cell - 0.5;
    const iu = Math.floor(u), iv = Math.floor(v);
    const tu = u - iu, tv = v - iv;
    const wu = bw(tu), wv = bw(tv), du = bd(tu), dv = bd(tv);
    let h = 0, gx = 0, gz = 0;
    for (let j = 0; j < 4; j++) {
      const row = clampi(iv - 1 + j, n) * n;
      let rh = 0, rd = 0;
      for (let i = 0; i < 4; i++) {
        const val = arr[row + clampi(iu - 1 + i, n)];
        rh += wu[i] * val;
        rd += du[i] * val;
      }
      h += wv[j] * rh;
      gx += wv[j] * rd;
      gz += dv[j] * rh;
    }
    out.h = h; out.dx = gx / cell; out.dz = gz / cell;
    return out;
  }

  // Large-scale terrain (DEM) height + slope.
  sampleBase(x, z, out = this._out) {
    const hf = this.fineSize * 0.5;
    const ex = hf - Math.abs(x), ez = hf - Math.abs(z);
    const edge = Math.min(ex, ez);
    if (edge > this.blend) return this._bspline(this.fine, this.fineN, this.fineCell, this.fineSize, x, z, out);
    const c = this._bspline(this.coarse, this.coarseN, this.coarseCell, this.coarseSize, x, z, { h: 0, dx: 0, dz: 0 });
    if (edge <= 0) { out.h = c.h; out.dx = c.dx; out.dz = c.dz; return out; }
    const f = this._bspline(this.fine, this.fineN, this.fineCell, this.fineSize, x, z, { h: 0, dx: 0, dz: 0 });
    let t = edge / this.blend; t = t * t * (3 - 2 * t);
    out.h = c.h + (f.h - c.h) * t; out.dx = c.dx + (f.dx - c.dx) * t; out.dz = c.dz + (f.dz - c.dz) * t;
    return out;
  }

  // Full drivable surface: DEM + medium-scale sand bumps (same as the shader).
  sample(x, z, out = this._out) {
    this.sampleBase(x, z, out);
    const d = detail(x, z);
    out.h += d.h; out.dx += d.dx; out.dz += d.dz;
    const u = dune(x, z);
    out.h += u.h; out.dx += u.dx; out.dz += u.dz;
    return out;
  }

  height(x, z) { return this.sample(x, z).h; }

  normal(x, z, target) {
    const s = this.sample(x, z);
    const nx = -s.dx, ny = 1, nz = -s.dz;
    const l = Math.hypot(nx, ny, nz);
    target.x = nx / l; target.y = ny / l; target.z = nz / l;
    return target;
  }

  // Ray (origin o, unit dir d) vs terrain. Returns distance or -1.
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let t = 0, prev = oy - this.height(ox, oz);
    if (prev < 0) return 0;
    const step = 0.5;
    while (t < maxDist) {
      const nt = Math.min(t + Math.max(step, prev * 0.5), maxDist);
      const h = oy + dy * nt - this.height(ox + dx * nt, oz + dz * nt);
      if (h < 0) {
        let a = t, b = nt;
        for (let i = 0; i < 12; i++) {
          const m = (a + b) * 0.5;
          if (oy + dy * m - this.height(ox + dx * m, oz + dz * m) < 0) b = m; else a = m;
        }
        return (a + b) * 0.5;
      }
      t = nt; prev = h;
      if (nt >= maxDist) break;
    }
    return -1;
  }
}

// ---- Dune height: the real terrain's relief, raised ----
// Each spot's height above the local average ground (a ~1 km wide blur) is multiplied by RELIEF_GAIN,
// so dunes grow 50 % taller while the valleys and the map's overall lie stay put. Faces that would
// end up steeper than SLOPE_CAP grow less, so slip faces stay steep sand slopes instead of walls.
export const RELIEF_GAIN = 1.5;
const RELIEF_RADIUS = 1000;              // m
const SLOPE_CAP = Math.tan(35 * Math.PI / 180);
function blurBox(a, n, r, tmp) {         // in-place separable box blur, clamped edges
  const w = 1 / (2 * r + 1);
  for (let y = 0; y < n; y++) {
    const o = y * n; let acc = 0;
    for (let k = -r; k <= r; k++) acc += a[o + (k < 0 ? 0 : k >= n ? n - 1 : k)];
    for (let x = 0; x < n; x++) { tmp[o + x] = acc * w; const xa = x + r + 1, xs = x - r; acc += a[o + (xa >= n ? n - 1 : xa)] - a[o + (xs < 0 ? 0 : xs)]; }
  }
  for (let x = 0; x < n; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[(k < 0 ? 0 : k >= n ? n - 1 : k) * n + x];
    for (let y = 0; y < n; y++) { a[y * n + x] = acc * w; const ya = y + r + 1, ys = y - r; acc += tmp[(ya >= n ? n - 1 : ya) * n + x] - tmp[(ys < 0 ? 0 : ys) * n + x]; }
  }
}
function min3(a, n, tmp) {                // 3x3 running minimum
  for (let y = 0; y < n; y++) { const o = y * n; for (let x = 0; x < n; x++) { const l = a[o + (x > 0 ? x - 1 : 0)], c = a[o + x], r = a[o + (x < n - 1 ? x + 1 : x)]; tmp[o + x] = l < c ? (l < r ? l : r) : (c < r ? c : r); } }
  for (let y = 0; y < n; y++) { const u = (y > 0 ? y - 1 : 0) * n, o = y * n, d = (y < n - 1 ? y + 1 : y) * n; for (let x = 0; x < n; x++) { const l = tmp[u + x], c = tmp[o + x], r = tmp[d + x]; a[o + x] = l < c ? (l < r ? l : r) : (c < r ? c : r); } }
}
// one row (y) of an m x m grid laid over the n x n one (F cells per grid cell), read bilinearly
function bilinearRow(g, m, F, n, y, out) {
  const s = 1 / F, v = Math.min(m - 1, Math.max(0, (y + 0.5) * s - 0.5)), y0 = Math.floor(v), y1 = Math.min(m - 1, y0 + 1), fy = v - y0;
  const r0 = y0 * m, r1 = y1 * m;
  for (let x = 0; x < n; x++) {
    const u = Math.min(m - 1, Math.max(0, (x + 0.5) * s - 0.5)), x0 = Math.floor(u), x1 = Math.min(m - 1, x0 + 1), fx = u - x0;
    const a = g[r0 + x0] + (g[r0 + x1] - g[r0 + x0]) * fx, b = g[r1 + x0] + (g[r1 + x1] - g[r1 + x0]) * fx;
    out[x] = a + (b - a) * fy;
  }
}
function exaggerate(h, n, cell) {
  // local average ground, worked out on a ~32 m grid (it is very smooth)
  const F = Math.max(1, Math.round(32 / cell)), m = Math.ceil(n / F);
  const lo = new Float32Array(m * m), tmp = new Float32Array(m * m);
  for (let y = 0; y < n; y++) { const r = Math.floor(y / F) * m; for (let x = 0; x < n; x++) lo[r + Math.floor(x / F)] += h[y * n + x]; }
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) lo[y * m + x] /= Math.min(F, n - y * F) * Math.min(F, n - x * F);
  const r = Math.max(1, Math.round(RELIEF_RADIUS / (cell * F) / 2));
  blurBox(lo, m, r, tmp); blurBox(lo, m, r, tmp);       // two box passes: a soft, tent-shaped average
  // gain: full on ordinary slopes; on faces already steep it is held to SLOPE_CAP / slope, so they end
  // up no steeper than the cap. Worked out on a ~8 m grid from the steepest slope in each cell, then
  // spread to the neighbours (min) and smoothed so there are no creases.
  const G = Math.max(1, Math.round(8 / cell)), q = Math.ceil(n / G);
  const gain = new Float32Array(q * q).fill(RELIEF_GAIN), t2 = new Float32Array(q * q), k2 = (SLOPE_CAP * 2 * cell) ** 2, g15 = RELIEF_GAIN * RELIEF_GAIN;
  for (let y = 1; y < n - 1; y++) {
    const gr = Math.floor(y / G) * q;
    for (let x = 1, i = y * n + 1; x < n - 1; x++, i++) {
      const gx = h[i + 1] - h[i - 1], gz = h[i + n] - h[i - n], g2 = gx * gx + gz * gz;
      if (g2 * g15 > k2) { const k = Math.max(1, Math.sqrt(k2 / g2)), j = gr + Math.floor(x / G); if (k < gain[j]) gain[j] = k; }
    }
  }
  min3(gain, q, t2); blurBox(gain, q, 1, t2);
  // h = ground + (h - ground) x gain, both read bilinearly from their grids, one row at a time
  const rowB = new Float32Array(n), rowG = new Float32Array(n);
  for (let y = 0; y < n; y++) {
    bilinearRow(lo, m, F, n, y, rowB); bilinearRow(gain, q, G, n, y, rowG);
    for (let x = 0, i = y * n; x < n; x++, i++) h[i] = rowB[x] + (h[i] - rowB[x]) * rowG[x];
  }
}

function clampi(i, n) { return i < 0 ? 0 : i >= n ? n - 1 : i; }
const _w = [0, 0, 0, 0], _d = [0, 0, 0, 0], _w2 = [0, 0, 0, 0], _d2 = [0, 0, 0, 0];
let flip = false;
function bw(t) {
  flip = !flip; const w = flip ? _w : _w2;
  const t2 = t * t, t3 = t2 * t, it = 1 - t;
  w[0] = it * it * it / 6; w[1] = (3 * t3 - 6 * t2 + 4) / 6; w[2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6; w[3] = t3 / 6;
  return w;
}
let flipd = false;
function bd(t) {
  flipd = !flipd; const d = flipd ? _d : _d2;
  const t2 = t * t, it = 1 - t;
  d[0] = -it * it / 2; d[1] = (3 * t2 - 4 * t) / 2; d[2] = (-3 * t2 + 2 * t + 1) / 2; d[3] = t2 / 2;
  return d;
}

// ---- Medium-scale sand detail, shared with GLSL (see terrain-render.js) ----
// Integer hash value noise with analytic derivatives.
function hash2(ix, iy) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}
const _n = { v: 0, dx: 0, dy: 0 };
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  const k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  _n.v = a + k1 * ux + k2 * uy + k4 * ux * uy;
  _n.dx = dux * (k1 + k4 * uy);
  _n.dy = duy * (k2 + k4 * ux);
  return _n;
}
const _det = { h: 0, dx: 0, dz: 0 };
// Two octaves: ~16 m hummocks (0.24 m) and ~6 m bumps (0.06 m).
export const DETAIL_OCTAVES = [
  { f: 1 / 16, a: 0.24, ox: 17.0, oz: 3.0 },
  { f: 1 / 6.0, a: 0.06, ox: -41.0, oz: 29.0 },
];
export function detail(x, z) {
  let h = 0, dx = 0, dz = 0;
  for (const o of DETAIL_OCTAVES) {
    const n = vnoise(x * o.f + o.ox, z * o.f + o.oz);
    h += (n.v - 0.5) * o.a; dx += n.dx * o.f * o.a; dz += n.dy * o.f * o.a;
  }
  _det.h = h; _det.dx = dx; _det.dz = dz;
  return _det;
}

// ---- Procedural dunes (same math as DUNE_GLSL in terrain-render.js) ----
// Transverse/barchanoid ridges built across the prevailing wind: a long gentle
// windward (stoss) slope up to a sharp brink, then a ~30 deg slip face on the
// downwind side. Crests wander (domain warp), break up into crescents
// (amplitude noise along the crest) and fade in and out over the map.
export const DUNE = {
  wind: [0.94 / Math.hypot(0.94, 0.34), 0.34 / Math.hypot(0.94, 0.34)],
  sets: [
    // spacing (m), max height (m), amp noise freq/offset, break-up freq/offset, warp m / freq / offset
    { lambda: 225, amp: 18, fa: 1 / 700, oa: [5.3, -2.1], fb: 1 / 230, ob: [-7.7, 3.9], warp: 45, fw: 1 / 320, ow: [1.1, 8.4], e0: 0.12, e1: 0.55, skew: 0.55 },
    { lambda: 70, amp: 3.9, fa: 1 / 260, oa: [-3.3, 12.7], fb: 1 / 90, ob: [9.1, -4.4], warp: 14, fw: 1 / 110, ow: [-6.2, -1.7], e0: 0.2, e1: 0.7, skew: 0.4 },
  ],
};
function sstep(e0, e1, x) { // smoothstep and its derivative
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return [t * t * (3 - 2 * t), 6 * t * (1 - t) / (e1 - e0)];
}
// Cross-section of one dune: a smooth, lopsided wave (the Fourier series of a
// sawtooth, sum k^n sin(n x)/n, summed in closed form). Every part of it is
// rounded: crest, slip face and valley floor. k sets how lopsided it is
// (0 = plain sine, near 1 = sharp sawtooth). Returns [P 0..1, dP/dphase].
const _pr = [0, 0];
export function duneProfile(ph, k) {
  const x = -6.283185307179586 * ph, c = Math.cos(x), sn = Math.sin(x);
  const norm = 1 / (2 * Math.asin(k));
  _pr[0] = 0.5 + Math.atan2(k * sn, 1 - k * c) * norm;
  _pr[1] = -6.283185307179586 * (k * c - k * k) / (1 - 2 * k * c + k * k) * norm;
  return _pr;
}
const _dune = { h: 0, dx: 0, dz: 0 };
export function dune(x, z) {
  const [wx, wz] = DUNE.wind;
  let h = 0, gx = 0, gz = 0;
  for (const S of DUNE.sets) {
    let n = vnoise(x * S.fa + S.oa[0], z * S.fa + S.oa[1]);
    const [a1, da1] = sstep(S.e0, S.e1, n.v); const a1x = da1 * n.dx * S.fa, a1z = da1 * n.dy * S.fa;
    n = vnoise(x * S.fb + S.ob[0], z * S.fb + S.ob[1]);
    const [b0, db0] = sstep(0.2, 0.75, n.v); const b = 0.35 + 0.65 * b0, bx = 0.65 * db0 * n.dx * S.fb, bz = 0.65 * db0 * n.dy * S.fb;
    n = vnoise(x * S.fw + S.ow[0], z * S.fw + S.ow[1]);
    const W = (n.v - 0.5) * S.warp, Wx = n.dx * S.fw * S.warp, Wz = n.dy * S.fw * S.warp;
    const A = S.amp * a1 * b, Ax = S.amp * (a1x * b + a1 * bx), Az = S.amp * (a1z * b + a1 * bz);
    const sph = (x * wx + z * wz + W) / S.lambda;
    const [P, dP] = duneProfile(sph - Math.floor(sph), S.skew);
    const kA = P - 0.5;
    h += A * (P - 0.5);
    gx += Ax * kA + A * dP * (wx + Wx) / S.lambda;
    gz += Az * kA + A * dP * (wz + Wz) / S.lambda;
  }
  _dune.h = h; _dune.dx = gx; _dune.dz = gz;
  return _dune;
}
