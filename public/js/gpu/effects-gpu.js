// WebGPU versions of the night sky (night-sky.js), the sand / dust billboards (particles.js) and the
// tire-rut maps (deform.js). Same maths as the GLSL, as node materials and WGSL.
import * as THREE from 'three';
import { MeshBasicNodeMaterial, NodeMaterial, StorageInstancedBufferAttribute } from 'three/webgpu';
import {
  wgslFn, texture, uniform, attribute, positionLocal, positionGeometry, positionWorld, modelWorldMatrix, cameraViewMatrix, vec2, vec3, vec4, float,
  varying, normalize, cos, sin, mix, floor, length, select, instanceIndex, storage, If, Discard, dot, Fn,
} from 'three/tsl';
import { SandDeformer } from '../deform.js';

// ---------------------------------------------------------------- night sky
const NIGHT_WGSL = /* wgsl */`
fn nightSky(dIn: vec3<f32>, moon: vec3<f32>, time: f32) -> vec3<f32> {
  let d = normalize(dIn);
  let up = clamp(d.y, -0.2, 1.0);
  var col = mix(vec3<f32>(0.020, 0.030, 0.060), vec3<f32>(0.003, 0.006, 0.016), smoothstep(0.0, 0.6, up));
  col += vec3<f32>(0.05, 0.06, 0.09) * exp(-max(up, 0.0) * 9.0);
  let gal = normalize(vec3<f32>(0.35, 0.25, 0.9));
  let band = exp(-pow(dot(d, gal) / 0.16, 2.0));
  let neb = nh3(floor(d * 60.0)) * 0.5 + nh3(floor(d * 23.0)) * 0.5;
  col += vec3<f32>(0.030, 0.030, 0.042) * band * (0.6 + 0.6 * neb);
  let s = nstars(d, 180.0, 0.985, time) * 1.6 + nstars(d, 420.0, 0.99 - 0.03 * band, time) * 0.9;
  col += vec3<f32>(0.95, 0.97, 1.0) * s * smoothstep(-0.02, 0.08, d.y);
  let md = dot(d, moon);
  let disc = smoothstep(0.99985, 0.99992, md);
  col = mix(col, vec3<f32>(1.25, 1.22, 1.15) * (0.9 + 0.1 * nh3(floor(d * 900.0))), disc);
  col += vec3<f32>(0.20, 0.23, 0.30) * pow(max(md, 0.0), 300.0) + vec3<f32>(0.04, 0.05, 0.07) * pow(max(md, 0.0), 12.0);
  col *= smoothstep(-0.25, 0.0, d.y) * 0.85 + 0.15;
  return col;
}
fn nh3(pIn: vec3<f32>) -> f32 { var p = fract(pIn * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
fn nstars(d: vec3<f32>, scale: f32, thresh: f32, time: f32) -> f32 {
  let c = floor(d * scale); let f = d * scale - c;
  let r = nh3(c);
  if (r < thresh) { return 0.0; }
  let sp = vec3<f32>(nh3(c + 7.1), nh3(c + 3.3), nh3(c + 5.9)) * 0.7 + 0.15;
  let dd = length(f - sp);
  let tw = 0.75 + 0.25 * sin(time * (2.0 + 5.0 * nh3(c + 1.7)) + r * 40.0);
  return smoothstep(0.09, 0.0, dd) * (r - thresh) / (1.0 - thresh) * tw;
}
`;

export function makeNightSkyGPU(moonDir) {
  const uTime = uniform(0), uMoon = uniform(moonDir.clone());
  const mat = new MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  const dir = varying(normalize(modelWorldMatrix.mul(vec4(positionLocal, 0)).xyz));
  mat.colorNode = wgslFn(NIGHT_WGSL)({ dIn: dir, moon: uMoon, time: uTime });
  mat.uniforms = { uTime, uMoon };
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  mesh.scale.setScalar(120000);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.visible = false;
  return mesh;
}

// ---------------------------------------------------------------- sand grains and dust puffs
const PARTICLE_WGSL = /* wgsl */`
fn particleColor(vUv: vec2<f32>, shade: f32, kind: f32, wp: vec3<f32>, sunDir: vec3<f32>, sunColor: vec3<f32>, ambient: vec3<f32>, sand: vec3<f32>,
                 fogColor: vec3<f32>, fogDensity: f32, cam: vec3<f32>, lt: texture_2d<f32>, ln: f32) -> vec4<f32> {
  let p = vUv * 2.0;
  let r2 = dot(p, p);
  if (r2 > 1.0) { return vec4<f32>(0.0); }
  let n = normalize(vec3<f32>(p, sqrt(1.0 - r2)));
  var a: f32; var col: vec3<f32>;
  if (kind < 0.5) {
    let lump = 0.75 + 0.25 * phash(floor(p * 3.0 + shade * 10.0));
    a = smoothstep(lump, lump - 0.25, sqrt(r2));
    let diff = max(dot(n, sunDir) * 0.6 + 0.4, 0.0);
    col = sand * shade * (sunColor * diff * 0.8 + ambient);
  } else {
    a = 1.0 - r2; a *= a;
    let V = normalize(cam - wp);
    let fwd = pow(max(dot(-V, sunDir), 0.0), 6.0);
    col = sand * shade * (sunColor * (0.55 + 0.9 * fwd) + ambient * 1.1);
  }
  var lsum = vec3<f32>(0.0);
  for (var i = 0; i < 16; i++) {
    if (f32(i) >= ln) { break; }
    let LP = textureLoad(lt, vec2<i32>(i, 0), 0); let LD = textureLoad(lt, vec2<i32>(i, 1), 0); let LC = textureLoad(lt, vec2<i32>(i, 2), 0).rgb;
    let L = LP.xyz - wp; let d2 = dot(L, L);
    var la = LP.w / (d2 + select(1.0, 16.0, LD.w > 0.5));
    if (LD.w > 0.5) { let c = dot(-L * inverseSqrt(d2), LD.xyz); la *= smoothstep(0.35, 0.8, c) * 0.35 + smoothstep(0.955, 0.992, c) * 3.0; }
    lsum += LC * la;
  }
  col += sand * shade * lsum * select(0.22, 0.3, kind < 0.5);
  let d = distance(cam, wp);
  let fog = 1.0 - exp(-fogDensity * fogDensity * d * d);
  col = mix(col, fogColor, fog);
  return vec4<f32>(col, a);
}
fn phash(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
`;
const particleFn = wgslFn(PARTICLE_WGSL);

// called by SandParticles (opts.makeMaterial) once per pool; its uniforms become TSL nodes the game keeps writing
export function makeParticleMaterialFactory(terrain) {
  return (sp) => {
    if (!sp._nodes) {
      const n = {};
      for (const [k, v] of Object.entries(sp.uniforms)) n[k] = (k === 'uLP' || k === 'uLD' || k === 'uLC' || k === 'uLN') ? v : uniform(v.value);
      sp.uniforms = n; sp._nodes = true;
    }
    const U = sp.uniforms;
    const iPos = attribute('iPos', 'vec4'), iData = attribute('iData', 'vec4');
    const c = cos(iData.z), s = sin(iData.z), px = positionGeometry.x, py = positionGeometry.y;
    // GLSL mat2(c,-s,s,c) * p
    const qx = c.mul(px).add(s.mul(py)), qy = s.negate().mul(px).add(c.mul(py));
    const right = vec3(cameraViewMatrix.element(0).x, cameraViewMatrix.element(1).x, cameraViewMatrix.element(2).x);
    const up = vec3(cameraViewMatrix.element(0).y, cameraViewMatrix.element(1).y, cameraViewMatrix.element(2).y);
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.NormalBlending, fog: false });
    m.positionNode = iPos.xyz.add(right.mul(qx).add(up.mul(qy)).mul(iPos.w));
    const out = particleFn({
      vUv: varying(positionGeometry.xy), shade: varying(iData.y), kind: varying(iData.w), wp: positionWorld,
      sunDir: U.uSunDir, sunColor: U.uSunColor, ambient: U.uAmbient, sand: U.uSand, fogColor: U.uFogColor, fogDensity: U.uFogDensity, cam: U.uCam,
      lt: texture(terrain.carLightTex), ln: terrain.uniforms.uLN,
    }).toVar('pc');
    const alpha = varying(iData.x);
    m.colorNode = out.xyz;
    m.opacityNode = out.w.mul(alpha);
    m.alphaTest = 0.0005;
    return m;
  };
}

// ---------------------------------------------------------------- tire-rut maps
const STAMP_FRAG_WGSL = /* wgsl */`
fn stampFrag(ab: vec2<f32>, world: vec2<f32>, len: f32, ext: f32, p1: vec4<f32>, p2: vec4<f32>, p3: vec2<f32>, win: vec4<f32>, spacing: f32, detail: f32) -> vec4<f32> {
  if (any(world < win.xy) || any(world >= win.zw)) { return vec4<f32>(-1.0); }
  let halfW = p1.x; let bermW = p1.y; let vDepth = p1.z; let vBerm = p1.w;
  let d0 = p2.x; let d1 = p2.y; let paddle = p2.z; let slip = p2.w; let typ = p3.x; let vChurn = p3.y;
  let a = ab.x; let b = ab.y;
  let t = abs(b) / halfW;
  let e = max(max(-a, a - len), 0.0) / ext;
  if (e >= 1.0) { return vec4<f32>(-1.0); }
  let cap = 0.5 + 0.5 * cos(3.14159 * e);
  var depth = 0.0; var berm = 0.0;
  let d = mix(d0, d1, clamp(a / max(len, 1e-4), 0.0, 1.0)) + min(a, 0.0) + max(a - len, 0.0);
  let prof = 0.5 + 0.5 * cos(3.14159 * clamp((t - 0.5) / 0.55, 0.0, 1.0));
  let u = (abs(b) - 0.8 * halfW) / (bermW * 1.3 + 0.25 * halfW);
  if (u > 0.0 && u < 1.0) { let sb = sin(3.14159 * u); berm = vBerm * 1.1 * sb * sb * (1.0 - 0.3 * u); }
  if (t < 1.05) {
    depth = vDepth * prof;
    if (typ < 0.5) {
      let ph = fract(d / spacing);
      let pad = pow(0.5 + 0.5 * cos(6.2831853 * ph), 5.0);
      depth += paddle * prof * mix(mix(pad, 0.55, clamp(slip, 0.0, 1.0)), 0.45, 1.0 - detail);
    } else {
      let x = b / halfW;
      let ridge = exp(-pow((abs(x) - 0.36) / 0.07, 2.0));
      depth -= paddle * ridge * prof * detail;
    }
  }
  depth = max(depth, 0.0) * cap;
  berm *= cap;
  let churn = vChurn * select((1.0 - smoothstep(0.0, 1.0, (abs(b) - halfW) / bermW)) * 0.8, 1.0, t < 1.0) * cap;
  return vec4<f32>(depth * 0.5, berm * 0.5, churn, 1.0);
}
`;
const stampFragFn = wgslFn(STAMP_FRAG_WGSL);
const CAP = 4096;

// same CPU side as SandDeformer; the GPU side reads the segments from storage buffers by instance
// (WebGPU has no per-instance step rate) and draws with the y axis flipped, so the texture rows
// line up with how the terrain shader samples them
export class SandDeformerGPU extends SandDeformer {
  constructor(renderer, opts) {
    super(null, { ...opts, deferGPU: true });
    this.renderer = renderer;
    this.rt = new THREE.RenderTarget(this.res, this.res, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    });
    this.rt.texture.wrapS = this.rt.texture.wrapT = THREE.RepeatWrapping;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quadPos = new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', quadPos); g.setIndex([0, 1, 2, 2, 1, 3]); g.instanceCount = 0;
    this.segGeo = g;
    this.aSeg = new StorageInstancedBufferAttribute(new Float32Array(CAP * 4), 4);
    this.aP1 = new StorageInstancedBufferAttribute(new Float32Array(CAP * 4), 4);
    this.aP2 = new StorageInstancedBufferAttribute(new Float32Array(CAP * 4), 4);
    this.aP3 = new StorageInstancedBufferAttribute(new Float32Array(CAP * 2), 2);
    const uW = uniform(this.W), uWin = uniform(this.win), uSpacing = uniform(2 * Math.PI * 0.41 / 18), uDetail = uniform(opts.coarse ? 0 : 1);
    const idx = instanceIndex.div(4);
    const seg = storage(this.aSeg, 'vec4', CAP).toReadOnly().element(idx), p1 = storage(this.aP1, 'vec4', CAP).toReadOnly().element(idx);
    const p2 = storage(this.aP2, 'vec4', CAP).toReadOnly().element(idx), p3 = storage(this.aP3, 'vec2', CAP).toReadOnly().element(idx);
    const o = seg.xy, e = seg.zw.sub(seg.xy), len = length(e);
    const ax = select(len.greaterThan(1e-4), e.div(len.max(1e-6)), vec2(1, 0));
    const bx = vec2(ax.y.negate(), ax.x);
    const ext = select(p3.x.greaterThan(0.5), float(0.14), float(0.18));
    const bw = p1.x.mul(1.05).add(p1.y.mul(1.3));
    const a = mix(ext.negate(), len.add(ext), positionGeometry.x), b = mix(bw.negate(), bw, positionGeometry.y);
    const world = o.add(ax.mul(a)).add(bx.mul(b));
    const cp = instanceIndex.bitAnd(3);
    const off = vec2(float(cp.bitAnd(1)), float(cp.shiftRight(1)));
    const uvv = world.div(uW).sub(floor(uWin.xy.div(uW))).sub(off);
    const segMat = new NodeMaterial();
    segMat.vertexNode = vec4(uvv.x.mul(2).sub(1), uvv.y.mul(2).sub(1).negate(), 0, 1);
    const vAB = varying(vec2(a, b)), vW = varying(world), vLen = varying(len), vExt = varying(ext), vP1 = varying(p1), vP2 = varying(p2), vP3 = varying(p3);
    segMat.fragmentNode = Fn(() => {
      const res = stampFragFn({ ab: vAB, world: vW, len: vLen, ext: vExt, p1: vP1, p2: vP2, p3: vP3, win: uWin, spacing: uSpacing, detail: uDetail }).toVar('st');
      If(res.w.lessThan(0), () => { Discard(); });
      return res;
    })();
    Object.assign(segMat, {
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendEquationAlpha: THREE.MaxEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this.segMesh = new THREE.Mesh(g, segMat);
    this.segMesh.frustumCulled = false;
    this.scene.add(this.segMesh);
    this.n = 0;
    // clears: a quad over a world strip, drawn at the 4 wrap positions
    const cq = new THREE.InstancedBufferGeometry();
    cq.setAttribute('position', quadPos); cq.setIndex([0, 1, 2, 2, 1, 3]); cq.instanceCount = 4;
    this.clearPool = [];
    for (let i = 0; i < 4; i++) {
      const uOrigin = uniform(new THREE.Vector2()), uRange = uniform(new THREE.Vector4());
      const cw = uOrigin.add(vec2(mix(uRange.x, uRange.y, positionGeometry.x), mix(uRange.z, uRange.w, positionGeometry.y)));
      const coff = vec2(float(instanceIndex.bitAnd(1)), float(instanceIndex.shiftRight(1)));
      const cuv = cw.div(uW).sub(floor(uWin.xy.div(uW))).sub(coff);
      const mat = new NodeMaterial();
      mat.vertexNode = vec4(cuv.x.mul(2).sub(1), cuv.y.mul(2).sub(1).negate(), 0, 1);
      mat.fragmentNode = vec4(0);
      Object.assign(mat, { blending: THREE.NoBlending, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      mat.uniforms = { uOrigin, uRange };
      const mesh = new THREE.Mesh(cq, mat);
      mesh.frustumCulled = false; mesh.visible = false;
      this.scene.add(mesh);
      this.clearPool.push(mesh);
    }
  }
}
