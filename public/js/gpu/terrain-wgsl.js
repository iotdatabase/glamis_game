// WGSL version of the terrain shaders in terrain-render.js (for the WebGPU renderer).
// A line-by-line translation of the GLSL: the dunes are generated from the same numbers (DUNE,
// DETAIL_OCTAVES) as dune() in terrain-data.js, so the cars still drive on exactly what you see.
import { DETAIL_OCTAVES, DUNE } from '../terrain-data.js';

const fl = (v) => {
  const s = v.toFixed(10);
  return s.includes('.') ? s : s + '.0';
};
const f1 = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

export const NOISE_WGSL = /* wgsl */`
fn thash(c: vec2<i32>) -> f32 {
  var h: u32 = u32(c.x) * 374761393u + u32(c.y) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967295.0;
}
fn vnoiseD(x: vec2<f32>) -> vec3<f32> {
  let i = floor(x); let f = x - i;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  let ii = vec2<i32>(i);
  let a = thash(ii); let b = thash(ii + vec2<i32>(1, 0)); let c = thash(ii + vec2<i32>(0, 1)); let d = thash(ii + vec2<i32>(1, 1));
  let k1 = b - a; let k2 = c - a; let k4 = a - b - c + d;
  return vec3<f32>(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2<f32>(k1 + k4 * u.y, k2 + k4 * u.x));
}
`;

export const DUNE_WGSL = /* wgsl */`
fn sstepD(e0: f32, e1: f32, x: f32) -> vec2<f32> { let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return vec2<f32>(t * t * (3.0 - 2.0 * t), 6.0 * t * (1.0 - t) / (e1 - e0)); }
fn duneProfile(ph: f32, k: f32) -> vec2<f32> {
  let x = -6.2831853 * ph; let c = cos(x); let sn = sin(x);
  let norm = 1.0 / (2.0 * asin(k));
  return vec2<f32>(0.5 + atan2(k * sn, 1.0 - k * c) * norm, -6.2831853 * (k * c - k * k) / (1.0 - 2.0 * k * c + k * k) * norm);
}
fn duneHD(p: vec2<f32>) -> vec3<f32> {
  let w = vec2<f32>(${fl(DUNE.wind[0])}, ${fl(DUNE.wind[1])});
  var r = vec3<f32>(0.0);
  ${DUNE.sets.map(S => `{
    var n = vnoiseD(p * ${fl(S.fa)} + vec2<f32>(${fl(S.oa[0])}, ${fl(S.oa[1])}));
    let a1 = sstepD(${fl(S.e0)}, ${fl(S.e1)}, n.x); let ga = a1.y * n.yz * ${fl(S.fa)};
    n = vnoiseD(p * ${fl(S.fb)} + vec2<f32>(${fl(S.ob[0])}, ${fl(S.ob[1])}));
    let b0 = sstepD(0.2, 0.75, n.x); let b = 0.35 + 0.65 * b0.x; let gb = 0.65 * b0.y * n.yz * ${fl(S.fb)};
    n = vnoiseD(p * ${fl(S.fw)} + vec2<f32>(${fl(S.ow[0])}, ${fl(S.ow[1])}));
    let W = (n.x - 0.5) * ${fl(S.warp)}; let gW = n.yz * ${fl(S.fw * S.warp)};
    let A = ${fl(S.amp)} * a1.x * b; let gA = ${fl(S.amp)} * (ga * b + a1.x * gb);
    let sph = (dot(p, w) + W) / ${fl(S.lambda)};
    let pr = duneProfile(fract(sph), ${fl(S.skew)}); let P = pr.x; let dP = pr.y;
    let kA = P - 0.5;
    r += vec3<f32>(A * (P - 0.5), gA * kA + A * dP * (w + gW) / ${fl(S.lambda)});
  }`).join('\n  ')}
  return r;
}
`;

// heights: B-spline over the DEM textures (R32F, read with textureLoad)
export const TERRAIN_WGSL = /* wgsl */`
fn bw0(t: f32) -> f32 { let it = 1.0 - t; return it * it * it / 6.0; }
fn bw1(t: f32) -> f32 { return (3.0 * t * t * t - 6.0 * t * t + 4.0) / 6.0; }
fn bw2(t: f32) -> f32 { return (-3.0 * t * t * t + 3.0 * t * t + 3.0 * t + 1.0) / 6.0; }
fn bw3(t: f32) -> f32 { return t * t * t / 6.0; }
fn bsplineH(tex: texture_2d<f32>, info: vec4<f32>, p: vec2<f32>) -> f32 {
  let n = info.x;
  let uv = (p + info.z * 0.5) / info.y - 0.5;
  let i = floor(uv); let t = uv - i;
  let wx = vec4<f32>(bw0(t.x), bw1(t.x), bw2(t.x), bw3(t.x));
  let wy = vec4<f32>(bw0(t.y), bw1(t.y), bw2(t.y), bw3(t.y));
  let ni = i32(n) - 1;
  let ix = i32(i.x); let iy = i32(i.y);
  var h = 0.0;
  for (var y = 0; y < 4; y++) {
    let yy = clamp(iy - 1 + y, 0, ni);
    let r = vec4<f32>(
      textureLoad(tex, vec2<i32>(clamp(ix - 1, 0, ni), yy), 0).r,
      textureLoad(tex, vec2<i32>(clamp(ix, 0, ni), yy), 0).r,
      textureLoad(tex, vec2<i32>(clamp(ix + 1, 0, ni), yy), 0).r,
      textureLoad(tex, vec2<i32>(clamp(ix + 2, 0, ni), yy), 0).r);
    h += wy[y] * dot(wx, r);
  }
  return h;
}
fn fineBlend(fi: vec4<f32>, p: vec2<f32>) -> f32 {
  let hf = fi.z * 0.5;
  let e = min(hf - abs(p.x), hf - abs(p.y));
  let t = clamp(e / fi.w, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
fn baseHeight(fine: texture_2d<f32>, coarse: texture_2d<f32>, fi: vec4<f32>, ci: vec4<f32>, p: vec2<f32>) -> f32 {
  let b = fineBlend(fi, p);
  var hc = 0.0; var hf = 0.0;
  if (b < 1.0) { hc = bsplineH(coarse, ci, p); }
  if (b > 0.0) { hf = bsplineH(fine, fi, p); }
  return mix(hc, hf, b);
}
${NOISE_WGSL}
${DUNE_WGSL}
fn detailHD(p: vec2<f32>, fade: f32) -> vec3<f32> {
  var r = vec3<f32>(0.0);
  ${DETAIL_OCTAVES.map(o => `{ let n = vnoiseD(p * ${fl(o.f)} + vec2<f32>(${f1(o.ox)}, ${f1(o.oz)}));
    r += vec3<f32>((n.x - 0.5) * ${o.a.toFixed(4)}, n.yz * ${fl(o.f * o.a)}); }`).join('\n  ')}
  return r * fade;
}
// fine rut map near the car, handing over smoothly to the coarse far map
fn deformFineW(di: vec4<f32>, p: vec2<f32>) -> f32 {
  if (di.w < 0.5) { return 0.0; }
  let d = abs(p - di.xy); let half_ = di.z * 0.5; let m = max(d.x, d.y);
  return 1.0 - smoothstep(half_ * 0.75, half_ * 0.95, m);
}
fn deformSample(dt: texture_2d<f32>, ds: sampler, dt2: texture_2d<f32>, ds2: sampler, di: vec4<f32>, di2: vec4<f32>, p: vec2<f32>) -> vec4<f32> {
  let wf = deformFineW(di, p);
  var c = vec4<f32>(0.0);
  // (both maps are read every time: WGSL wants texture reads outside data-dependent branches)
  let far = textureSampleLevel(dt2, ds2, p / di2.z, 0.0);
  let near = textureSampleLevel(dt, ds, p / di.z, 0.0);
  if (wf < 1.0 && di2.w > 0.5) {
    let d = abs(p - di2.xy); let half_ = di2.z * 0.5; let m = max(d.x, d.y);
    if (m < half_ * 0.97) { c = far * (1.0 - smoothstep(half_ * 0.85, half_ * 0.97, m)); }
  }
  if (wf <= 0.0) { return c; }
  return mix(c, near, wf);
}
`;

// per-vertex terrain: CDLOD morph + DEM + dunes + detail + ruts. Returns (x, height, z, rut depth)
export const VERTEX_WGSL = /* wgsl */`
fn terrainVertex(fine: texture_2d<f32>, coarse: texture_2d<f32>, dt: texture_2d<f32>, ds: sampler, dt2: texture_2d<f32>, ds2: sampler,
                 fi: vec4<f32>, ci: vec4<f32>, di: vec4<f32>, di2: vec4<f32>,
                 inst: vec4<f32>, pos: vec3<f32>, camPos: vec3<f32>, mEnd: f32, leafRes: f32, rootHalf: f32) -> vec4<f32> {
  let M = leafRes * 0.5;
  var wxz = inst.xy + pos.xz * inst.z;
  let spacing = inst.z / M;
  let h0 = baseHeight(fine, coarse, fi, ci, wxz);
  let dist = distance(camPos, vec3<f32>(wxz.x, h0, wxz.y));
  let mStart = mEnd * 0.72;
  let k = clamp((dist - mStart) / (mEnd - mStart), 0.0, 1.0);
  let g = (wxz + rootHalf) / spacing;
  let fr = fract(g * 0.5) * 2.0;
  wxz -= fr * spacing * k;
  let hd = distance(camPos.xz, wxz);
  let detailFade = 1.0 - smoothstep(1500.0, 3000.0, hd);
  let dtl = detailHD(wxz, detailFade);
  let df = deformSample(dt, ds, dt2, ds2, di, di2, wxz);
  let du = duneHD(wxz);
  let dfw = max(deformFineW(di, wxz), 1.0 - smoothstep(0.25, 0.9, spacing));
  let h = baseHeight(fine, coarse, fi, ci, wxz) + du.x + dtl.x + (df.g - df.r) * dfw;
  return vec4<f32>(wxz.x, h, wxz.y, df.r * dfw);
}
`;

// procedural sand surface (SAND_GLSL), packed into a mat4:
//   col0 = albedo, roughness   col1 = normal (world), sun visibility   col2 = sparkle, ao, -, -
export const SAND_WGSL = /* wgsl */`
fn fbm3(pIn: vec2<f32>) -> f32 {
  var p = pIn; var a = 0.0; var w = 0.5;
  for (var i = 0; i < 4; i++) { a += w * vnoiseD(p).x; p = mat2x2<f32>(1.6, 1.2, -1.2, 1.6) * p + 7.31; w *= 0.5; }
  return a;
}
fn ripProf(ph: f32) -> vec2<f32> { return duneProfile(fract(ph), 0.62); }
fn ripples(p: vec2<f32>, dpx: vec2<f32>, dpy: vec2<f32>, amount: f32, w: vec2<f32>) -> vec3<f32> {
  let pw = vec2<f32>(-w.y, w.x);
  let LAM = 0.22;
  let fpW = (abs(dot(dpx, w)) + abs(dot(dpy, w))) / LAM;
  if (fpW > 1.2 || amount <= 0.0) { return vec3<f32>(0.0); }
  let u = dot(p, w) / LAM; let v = dot(p, pw) / LAM;
  let nA = vnoiseD(p * 0.9 + 3.1); let nB = vnoiseD(p * 0.23 - 7.7); let nC = vnoiseD(p * 2.6 + 1.3);
  let bend = nB.x * 5.0 + nA.x * 1.4;
  let gBend = (nB.yz * 0.23 * 5.0 + nA.yz * 0.9 * 1.4);
  let wig = 0.34 * sin(v * 1.25 + nA.x * 7.0) + 0.3 * (nC.x - 0.5);
  let gWig = 0.34 * cos(v * 1.25 + nA.x * 7.0) * (pw * 1.25 / LAM + nA.yz * 0.9 * 7.0) + 0.3 * nC.yz * 2.6;
  let ph1 = u + bend + wig;
  let gph1 = w / LAM + gBend + gWig;
  let ph2 = u * 1.13 + v * 0.11 + bend * 0.8 - wig + 0.37;
  let gph2 = (w * 1.13 + pw * 0.11) / LAM + gBend * 0.8 - gWig;
  let fp1 = abs(dot(dpx, gph1)) + abs(dot(dpy, gph1)); let fp2 = abs(dot(dpx, gph2)) + abs(dot(dpy, gph2));
  let fade = 1.0 - smoothstep(0.3, 0.95, max(fp1, fp2));
  if (fade <= 0.0) { return vec3<f32>(0.0); }
  let nM = vnoiseD(p * 0.55 + 17.0);
  let m = smoothstep(0.35, 0.65, nM.x); let gm = 6.0 * m * (1.0 - m) / 0.3 * nM.yz * 0.55;
  let r1 = ripProf(ph1); let r2 = ripProf(ph2);
  let A = 0.016 * amount * fade;
  let h = mix(r1.x, r2.x, m);
  let g = A * (mix(r1.y * gph1, r2.y * gph2, m) + (r2.x - r1.x) * gm);
  return vec3<f32>(g, (h - 0.5) * amount * fade);
}
fn hexHash(v: vec2<i32>, salt: i32) -> vec2<f32> { return vec2<f32>(thash(v * 3 + vec2<i32>(salt, 11)), thash(v * 5 + vec2<i32>(29, salt * 7))); }
fn hexSample(dif: texture_2d<f32>, nor: texture_2d<f32>, smp: sampler, uv: vec2<f32>, dx: vec2<f32>, dy: vec2<f32>, rotRange: f32, avg: f32, salt: i32) -> vec3<f32> {
  let st = uv * 3.4641016;
  let sk = vec2<f32>(st.x - 0.57735027 * st.y, 1.15470054 * st.y);
  let b = vec2<i32>(floor(sk)); let f = fract(sk); let z = 1.0 - f.x - f.y;
  var w: vec3<f32>; var vs: array<vec2<i32>, 3>;
  if (z > 0.0) { w = vec3<f32>(z, f.y, f.x); vs[0] = b; vs[1] = b + vec2<i32>(0, 1); vs[2] = b + vec2<i32>(1, 0); }
  else { w = vec3<f32>(-z, 1.0 - f.y, 1.0 - f.x); vs[0] = b + vec2<i32>(1, 1); vs[1] = b + vec2<i32>(1, 0); vs[2] = b + vec2<i32>(0, 1); }
  var lum: array<f32, 3>; var gr: array<vec2<f32>, 3>;
  for (var i = 0; i < 3; i++) {
    let h = hexHash(vs[i], salt);
    let a = (h.x - 0.5) * rotRange; let c = cos(a); let s = sin(a);
    let R = mat2x2<f32>(c, s, -s, c);
    let u = R * uv + h * 7.31 + h.yx * 3.17;
    let ddx = R * dx; let ddy = R * dy;
    lum[i] = dot(textureSampleGrad(dif, smp, u, ddx, ddy).rgb, vec3<f32>(0.299, 0.587, 0.114)) / avg;
    let n = textureSampleGrad(nor, smp, u, ddx, ddy).xyz * 2.0 - 1.0;
    gr[i] = transpose(R) * (-n.xy / max(n.z, 0.2));
  }
  var wl = w * vec3<f32>(1.0 + 0.6 * lum[0], 1.0 + 0.6 * lum[1], 1.0 + 0.6 * lum[2]);
  wl = pow(wl, vec3<f32>(5.0)); wl /= dot(wl, vec3<f32>(1.0));
  let m = wl.x * lum[0] + wl.y * lum[1] + wl.z * lum[2];
  let k = inverseSqrt(max(dot(wl, wl), 1e-3));
  let outL = 1.0 + (m - 1.0) * mix(1.0, k, 0.8);
  let og = (wl.x * gr[0] + wl.y * gr[1] + wl.z * gr[2]) * mix(1.0, k, 0.5);
  return vec3<f32>(outL, og);
}
fn oldTracks(p: vec2<f32>, footprint: f32) -> vec3<f32> {
  var r = vec3<f32>(0.0);
  let CELLW = 48.0;
  let cb = floor(p / CELLW);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let cid = vec2<i32>(cb) + vec2<i32>(i, j);
      let dens = 0.25 + 0.75 * smoothstep(0.35, 0.75, vnoiseD((vec2<f32>(cid) + 0.5) * CELLW / 450.0 + 3.3).x);
      for (var k = 0; k < 2; k++) {
        let kc = cid * 7 + vec2<i32>(k * 131, k * 57);
        if (thash(kc + vec2<i32>(1, 2)) > dens * select(0.75, 1.0, k == 0)) { continue; }
        let q = (vec2<f32>(cid) + vec2<f32>(thash(kc + vec2<i32>(3, 4)), thash(kc + vec2<i32>(5, 6)))) * CELLW;
        let th = thash(kc + vec2<i32>(7, 8)) * 6.2831853;
        let dir = vec2<f32>(cos(th), sin(th)); let nrm = vec2<f32>(-dir.y, dir.x);
        let kap = (thash(kc + vec2<i32>(9, 10)) - 0.5) * 0.06;
        let halfL = 25.0 + 45.0 * thash(kc + vec2<i32>(11, 12));
        let age = 0.35 + 0.65 * thash(kc + vec2<i32>(13, 14));
        let d = p - q;
        let t = dot(d, dir);
        let along = 1.0 - smoothstep(halfL * 0.75, halfL, abs(t));
        if (along <= 0.0) { continue; }
        let sl = dot(d, nrm) - 0.5 * kap * t * t;
        if (abs(sl) > 2.5) { continue; }
        let dsl = nrm - kap * t * dir;
        let w = mix(0.4, 0.22, age);
        let we = sqrt(w * w + 2.25 * footprint * footprint);
        let A = 0.05 * age * (w / we) * along;
        for (var s = 0; s < 2; s++) {
          let u = (sl - select(0.95, -0.95, s == 0)) / we;
          let pr = exp(-u * u);
          r.x = max(r.x, pr * age * along * (w / we));
          let gy = A * 2.0 * u / we * pr * dsl;
          r.y += gy.x; r.z += gy.y;
        }
      }
    }
  }
  return r;
}
fn sandAll(fine: texture_2d<f32>, coarse: texture_2d<f32>, gradF: texture_2d<f32>, gradC: texture_2d<f32>, gs: sampler,
           dt: texture_2d<f32>, ds: sampler, dt2: texture_2d<f32>, ds2: sampler,
           sunTex: texture_2d<f32>, sunS: sampler, sandTex: texture_2d<f32>, sandNor: texture_2d<f32>, sandS: sampler,
           fi: vec4<f32>, ci: vec4<f32>, di: vec4<f32>, di2: vec4<f32>, texInfo: vec4<f32>, texAvg: vec2<f32>,
           wp: vec3<f32>, deformDepth: f32, camPos: vec3<f32>, sunDir: vec3<f32>, wind: vec2<f32>) -> mat4x4<f32> {
  let p = wp.xz;
  // derivatives first, in uniform control flow
  let dpx = dpdx(p); let dpy = dpdy(p);
  let footprint = max(length(fwidth(p)), 1e-4);
  let camD = distance(camPos, wp);

  // ---- normal ----
  let uvC = (p + ci.z * 0.5) / ci.z; let uvF = (p + fi.z * 0.5) / fi.z;
  let gcS = textureSampleGrad(gradC, gs, uvC, dpx / ci.z, dpy / ci.z).rg;
  let gfS = textureSampleGrad(gradF, gs, uvF, dpx / fi.z, dpy / fi.z).rg;
  let bBlend = fineBlend(fi, p);
  let bgrad = mix(gcS, gfS, bBlend);
  var g = bgrad;
  let detailFade = 1.0 - smoothstep(1500.0, 3000.0, distance(camPos.xz, p));
  let dtl = detailHD(p, detailFade);
  g += dtl.yz;
  let duneV = duneHD(p);
  g += duneV.yz;
  { let n1 = vnoiseD(p * 0.55 + 11.0); g += n1.yz * 0.55 * 0.025 * (1.0 - smoothstep(200.0, 600.0, camD)); }
  { let n2 = vnoiseD(p * 1.7 - 5.0); g += n2.yz * 1.7 * 0.004 * (1.0 - smoothstep(60.0, 200.0, camD)); }

  // tire tracks / churned sand from the deformation map
  let df = deformSample(dt, ds, dt2, ds2, di, di2, p);
  var churn = 0.0;
  {
    var e = select(di2.z / f32(textureDimensions(dt2).x), di.z / f32(textureDimensions(dt).x), deformFineW(di, p) > 0.0);
    e = max(e, footprint * 0.7);
    let dx1 = deformSample(dt, ds, dt2, ds2, di, di2, p + vec2<f32>(e, 0.0)); let dx0 = deformSample(dt, ds, dt2, ds2, di, di2, p - vec2<f32>(e, 0.0));
    let dz1 = deformSample(dt, ds, dt2, ds2, di, di2, p + vec2<f32>(0.0, e)); let dz0 = deformSample(dt, ds, dt2, ds2, di, di2, p - vec2<f32>(0.0, e));
    if (di.w > 0.5 && camD < max(di.z * 0.6, di2.z * 0.55)) {
      let hx = ((dx1.g - dx1.r) - (dx0.g - dx0.r)) / (2.0 * e);
      let hz = ((dz1.g - dz1.r) - (dz0.g - dz0.r)) / (2.0 * e);
      g += vec2<f32>(hx, hz);
      churn = clamp(df.b, 0.0, 1.0);
    }
  }

  // ---- photo-scanned sand textures (test patch or everywhere) ----
  var texW = 0.0; var texLum = 1.0;
  {
    let grain = hexSample(sandTex, sandNor, sandS, p / 1.7, dpx / 1.7, dpy / 1.7, 6.2831853, texAvg.x, 7);
    let finer = hexSample(sandTex, sandNor, sandS, p / 0.55 + 17.3, dpx / 0.55, dpy / 0.55, 6.2831853, texAvg.x, 31);
    if (texInfo.w > 0.5) {
      texW = select(1.0 - smoothstep(texInfo.z * 0.8, texInfo.z, distance(p, texInfo.xy)), 1.0, texInfo.w > 1.5);
      texW *= 1.0 - smoothstep(250.0, 700.0, camD);
      if (texW > 0.0) {
        let nearF = 1.0 - smoothstep(3.0, 10.0, camD);
        let lum = mix(1.0, grain.x, 0.25) * mix(1.0, finer.x, 0.2 * nearF);
        texLum = mix(1.0, lum, texW);
        let strength = texW * (1.0 - churn * 0.6) * (1.0 - smoothstep(30.0, 120.0, camD));
        g += (grain.yz * 0.18 + finer.yz * 0.12 * nearF) * strength;
      }
    }
  }

  let slope = length(g);
  let rippleAmt = (1.0 - smoothstep(0.22, 0.42, slope)) * (1.0 - churn)
                * (0.75 + 0.25 * smoothstep(0.2, 0.8, vnoiseD(p * 0.045).x));
  let rip = ripples(p, dpx, dpy, rippleAmt, wind);
  g += rip.xy;
  let ripShade = rip.z;
  if (churn > 0.0) {
    let c1 = vnoiseD(p * 9.0); let c2 = vnoiseD(p * 23.0 + 4.0);
    let fch = 1.0 - smoothstep(0.03, 0.12, footprint);
    g += (c1.yz * 9.0 * 0.006 + c2.yz * 23.0 * 0.0025) * churn * fch;
  }
  var oldCover = 0.0;
  if (camD < 700.0) {
    let ot = oldTracks(p, footprint);
    let of_ = 1.0 - smoothstep(350.0, 700.0, camD);
    g += ot.yz * of_ * (1.0 - churn);
    oldCover = ot.x * of_ * (1.0 - churn);
  }
  let N = normalize(vec3<f32>(-g.x, 1.0, -g.y));

  // ---- albedo ----
  let sandA = vec3<f32>(0.64, 0.35, 0.16);
  let sandB = vec3<f32>(0.68, 0.375, 0.175);
  let sandDark = vec3<f32>(0.57, 0.315, 0.15);
  let n1 = fbm3(p * 0.004);
  let n2 = fbm3(p * 0.031 + 9.0);
  let n3 = vnoiseD(p * 0.33).x;
  var col = mix(sandA, sandB, smoothstep(0.3, 0.7, n1));
  col *= 0.96 + 0.06 * n2 + 0.02 * n3;
  col *= 1.0 + 0.04 * ripShade;
  col *= clamp(texLum, 0.55, 1.5);
  let hc = bsplineH(coarse, ci, p);
  let hf = baseHeight(fine, coarse, fi, ci, p);
  let hollow = smoothstep(1.0, 9.0, hc - hf) * bBlend;
  let flat_ = (1.0 - smoothstep(0.02, 0.08, length(bgrad + duneV.yz))) * (0.5 + 0.5 * smoothstep(0.4, 0.7, fbm3(p * 0.0015 + 2.0)));
  col = mix(col, sandDark, clamp(hollow * 0.45 + flat_ * 0.35, 0.0, 0.7));
  let slip = smoothstep(0.45, 0.62, slope);
  col = mix(col, col * 1.06, slip);
  col = mix(col, col * vec3<f32>(0.86, 0.82, 0.78), churn);
  col *= 1.0 - 0.1 * oldCover;
  let cavity = clamp(deformDepth * 6.0, 0.0, 1.0);
  let ao = 1.0 - 0.2 * cavity - 0.12 * hollow;
  let rough = mix(0.93, 0.98, churn) - 0.06 * slip;

  // ---- baked long-range dune shadows ----
  var sunVis = 1.0;
  {
    let suv = (p + fi.z * 0.5) / fi.z;
    let bake = textureSampleLevel(sunTex, sunS, suv, 0.0).r;
    if (all(suv > vec2<f32>(0.0)) && all(suv < vec2<f32>(1.0))) {
      let useBake = smoothstep(60.0, 110.0, camD);
      sunVis = mix(1.0, bake, max(useBake, 0.0));
    }
  }

  // ---- sparkle: individual quartz grains catching the sun ----
  var sparkle = 0.0;
  if (camD < 25.0) {
    let cell = floor(p * 400.0);
    let rr = thash(vec2<i32>(cell));
    if (rr > 0.985) {
      let V = normalize(camPos - wp);
      let gN = normalize(vec3<f32>(thash(vec2<i32>(cell) + 7) - 0.5, 0.6, thash(vec2<i32>(cell) + 13) - 0.5));
      let Hh = normalize(sunDir + V);
      let s = pow(max(dot(gN, Hh), 0.0), 400.0);
      sparkle = s * 3.0 * (1.0 - smoothstep(8.0, 25.0, camD)) * (1.0 - churn);
    }
  }
  return mat4x4<f32>(vec4<f32>(col, rough), vec4<f32>(N, sunVis), vec4<f32>(sparkle, ao, 0.0, 0.0), vec4<f32>(0.0));
}
// car lights (LED light bars, whips) on the sand: a 16x3 float texture (pos+intensity, dir+cone, colour)
fn carLights(lt: texture_2d<f32>, n: f32, wp: vec3<f32>, N: vec3<f32>) -> vec3<f32> {
  var lsum = vec3<f32>(0.0);
  for (var i = 0; i < 16; i++) {
    if (f32(i) >= n) { break; }
    let LP = textureLoad(lt, vec2<i32>(i, 0), 0); let LD = textureLoad(lt, vec2<i32>(i, 1), 0); let LC = textureLoad(lt, vec2<i32>(i, 2), 0).rgb;
    var L = LP.xyz - wp; let d2 = dot(L, L); let d = sqrt(d2); L /= d;
    let ndl = max(dot(N, L), 0.0);
    var a = LP.w / (d2 + select(1.0, 16.0, LD.w > 0.5));
    if (LD.w > 0.5) {
      let c = dot(-L, LD.xyz);
      a *= smoothstep(0.35, 0.8, c) * 0.35 + smoothstep(0.955, 0.992, c) * 3.0;
    }
    lsum += LC * a * ndl;
  }
  return lsum;
}
`;

// bakes: DEM gradient texture and soft long-range sun shadows. `pix` = pixel position, n = target size.
export const BAKE_GRAD_WGSL = /* wgsl */`
fn bd0(t: f32) -> f32 { let it = 1.0 - t; return -it * it / 2.0; }
fn bd1(t: f32) -> f32 { return (3.0 * t * t - 4.0 * t) / 2.0; }
fn bd2(t: f32) -> f32 { return (-3.0 * t * t + 2.0 * t + 1.0) / 2.0; }
fn bd3(t: f32) -> f32 { return t * t / 2.0; }
fn bakeGrad(tex: texture_2d<f32>, info: vec4<f32>, pix: vec2<f32>, n: f32) -> vec4<f32> {
  let vUv = pix / n;
  let p = vUv * info.z - info.z * 0.5;
  let uv = (p + info.z * 0.5) / info.y - 0.5;
  let i = floor(uv); let t = uv - i;
  let wx = vec4<f32>(bw0(t.x), bw1(t.x), bw2(t.x), bw3(t.x));
  let wy = vec4<f32>(bw0(t.y), bw1(t.y), bw2(t.y), bw3(t.y));
  let dx = vec4<f32>(bd0(t.x), bd1(t.x), bd2(t.x), bd3(t.x));
  let dy = vec4<f32>(bd0(t.y), bd1(t.y), bd2(t.y), bd3(t.y));
  let ni = i32(info.x) - 1; let ix = i32(i.x); let iy = i32(i.y);
  var gx = 0.0; var gz = 0.0; var h = 0.0;
  for (var y = 0; y < 4; y++) {
    let yy = clamp(iy - 1 + y, 0, ni);
    let r = vec4<f32>(
      textureLoad(tex, vec2<i32>(clamp(ix - 1, 0, ni), yy), 0).r,
      textureLoad(tex, vec2<i32>(clamp(ix, 0, ni), yy), 0).r,
      textureLoad(tex, vec2<i32>(clamp(ix + 1, 0, ni), yy), 0).r,
      textureLoad(tex, vec2<i32>(clamp(ix + 2, 0, ni), yy), 0).r);
    gx += wy[y] * dot(dx, r); gz += dy[y] * dot(wx, r); h += wy[y] * dot(wx, r);
  }
  return vec4<f32>(gx / info.y, gz / info.y, h, 1.0);
}
`;

export const BAKE_SUN_WGSL = /* wgsl */`
fn hdem(tex: texture_2d<f32>, info: vec4<f32>, p: vec2<f32>) -> f32 {
  let uv = (p + info.z * 0.5) / info.y - 0.5; let i = floor(uv); let f = uv - i; let ni = i32(info.x) - 1;
  let c = vec2<i32>(i);
  let lo = vec2<i32>(0); let hi = vec2<i32>(ni);
  let a = textureLoad(tex, clamp(c, lo, hi), 0).r;
  let b = textureLoad(tex, clamp(c + vec2<i32>(1, 0), lo, hi), 0).r;
  let cc = textureLoad(tex, clamp(c + vec2<i32>(0, 1), lo, hi), 0).r;
  let d = textureLoad(tex, clamp(c + vec2<i32>(1, 1), lo, hi), 0).r;
  return mix(mix(a, b, f.x), mix(cc, d, f.x), f.y);
}
fn bakeSun(tex: texture_2d<f32>, info: vec4<f32>, dir: vec2<f32>, tanSun: f32, pix: vec2<f32>, n: f32) -> vec4<f32> {
  let vUv = pix / n;
  let p = vUv * info.z - info.z * 0.5;
  let h0 = hdem(tex, info, p) + duneHD(p).x + 0.3;
  var maxT = -1.0; var d = 2.0;
  for (var i = 0; i < 160; i++) {
    let q = p + dir * d;
    maxT = max(maxT, (hdem(tex, info, q) + duneHD(q).x - h0) / d);
    d *= 1.035; d += 0.5;
    if (d > 3000.0) { break; }
  }
  let lit = smoothstep(-0.09, 0.09, tanSun - maxT);
  return vec4<f32>(lit, lit, lit, 1.0);
}
`;
