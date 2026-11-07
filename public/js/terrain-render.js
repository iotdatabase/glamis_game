// CDLOD terrain renderer: continuous level-of-detail quadtree with vertex
// morphing, so the dunes render out to the horizon with no visible popping and
// with ~12 cm triangles right around the car (enough to show paddle tracks).
import * as THREE from 'three';
import { DETAIL_OCTAVES, DUNE } from './terrain-data.js';

const ROOT_SIZE = 131072; // meters, root quadtree node
const ROOT_HALF = ROOT_SIZE / 2;
// the shader adds the procedural dunes, the sand bumps and the ruts on top of the DEM: the most they can move
// the surface up or down, so the patch boxes (built from the DEM alone) still hold the sand that is drawn
const RELIEF = DUNE.sets.reduce((a, S) => a + S.amp / 2, 0) + DETAIL_OCTAVES.reduce((a, o) => a + o.a / 2, 0) + 0.6;


const NOISE_GLSL = /* glsl */`
float thash(ivec2 c){
  uint h = uint(c.x)*374761393u + uint(c.y)*668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return float(h) / 4294967295.0;
}
vec3 vnoiseD(vec2 x){
  vec2 i = floor(x); vec2 f = x - i;
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  vec2 du = 30.0*f*f*(f*(f-2.0)+1.0);
  ivec2 ii = ivec2(i);
  float a = thash(ii), b = thash(ii+ivec2(1,0)), c = thash(ii+ivec2(0,1)), d = thash(ii+ivec2(1,1));
  float k1=b-a, k2=c-a, k4=a-b-c+d;
  return vec3(a + k1*u.x + k2*u.y + k4*u.x*u.y, du*vec2(k1 + k4*u.y, k2 + k4*u.x));
}
`;

// Procedural dunes, evaluated per vertex (and per pixel for the normal).
// Same math as dune() in terrain-data.js so the physics drive on the same shape.
const fl = (v) => v.toFixed(10);
const DUNE_GLSL = /* glsl */`
vec2 sstepD(float e0, float e1, float x){ float t = clamp((x-e0)/(e1-e0), 0.0, 1.0); return vec2(t*t*(3.0-2.0*t), 6.0*t*(1.0-t)/(e1-e0)); }
vec2 duneProfile(float ph, float k){
  float x = -6.2831853*ph, c = cos(x), sn = sin(x);
  float norm = 1.0/(2.0*asin(k));
  return vec2(0.5 + atan(k*sn, 1.0 - k*c)*norm, -6.2831853*(k*c - k*k)/(1.0 - 2.0*k*c + k*k)*norm);
}
vec3 duneHD(vec2 p){
  vec2 w = vec2(${fl(DUNE.wind[0])}, ${fl(DUNE.wind[1])});
  vec3 r = vec3(0.0);
  ${DUNE.sets.map(S => `{
    vec3 n = vnoiseD(p*${fl(S.fa)} + vec2(${fl(S.oa[0])}, ${fl(S.oa[1])}));
    vec2 a1 = sstepD(${fl(S.e0)}, ${fl(S.e1)}, n.x); vec2 ga = a1.y*n.yz*${fl(S.fa)};
    n = vnoiseD(p*${fl(S.fb)} + vec2(${fl(S.ob[0])}, ${fl(S.ob[1])}));
    vec2 b0 = sstepD(0.2, 0.75, n.x); float b = 0.35 + 0.65*b0.x; vec2 gb = 0.65*b0.y*n.yz*${fl(S.fb)};
    n = vnoiseD(p*${fl(S.fw)} + vec2(${fl(S.ow[0])}, ${fl(S.ow[1])}));
    float W = (n.x-0.5)*${fl(S.warp)}; vec2 gW = n.yz*${fl(S.fw * S.warp)};
    float A = ${fl(S.amp)}*a1.x*b; vec2 gA = ${fl(S.amp)}*(ga*b + a1.x*gb);
    float sph = (dot(p, w) + W)/${fl(S.lambda)};
    vec2 pr = duneProfile(fract(sph), ${fl(S.skew)}); float P = pr.x, dP = pr.y;
    float kA = P - 0.5;
    r += vec3(A*(P-0.5), gA*kA + A*dP*(w + gW)/${fl(S.lambda)});
  }`).join('\n  ')}
  return r;
}
`;

export const TERRAIN_GLSL = /* glsl */`
uniform highp sampler2D uFine;
uniform highp sampler2D uCoarse;
uniform sampler2D uGradFine;
uniform sampler2D uGradCoarse;
uniform vec4 uFineInfo;   // n, cell, size, blend
uniform vec4 uCoarseInfo; // n, cell, size, 0
uniform sampler2D uDeform;
uniform vec4 uDeformInfo; // centerX, centerZ, size, enabled
uniform sampler2D uDeform2;  // coarse rut map reaching much farther out
uniform vec4 uDeformInfo2;

float bw0(float t){ float it=1.0-t; return it*it*it/6.0; }
float bw1(float t){ return (3.0*t*t*t-6.0*t*t+4.0)/6.0; }
float bw2(float t){ return (-3.0*t*t*t+3.0*t*t+3.0*t+1.0)/6.0; }
float bw3(float t){ return t*t*t/6.0; }

float bsplineH(highp sampler2D tex, vec4 info, vec2 p){
  float n = info.x;
  vec2 uv = (p + info.z*0.5)/info.y - 0.5;
  vec2 i = floor(uv); vec2 t = uv - i;
  vec4 wx = vec4(bw0(t.x),bw1(t.x),bw2(t.x),bw3(t.x));
  vec4 wy = vec4(bw0(t.y),bw1(t.y),bw2(t.y),bw3(t.y));
  int ni = int(n) - 1;
  float h = 0.0;
  for (int y=0; y<4; y++){
    int yy = clamp(int(i.y)-1+y, 0, ni);
    vec4 r = vec4(
      texelFetch(tex, ivec2(clamp(int(i.x)-1,0,ni), yy), 0).r,
      texelFetch(tex, ivec2(clamp(int(i.x)  ,0,ni), yy), 0).r,
      texelFetch(tex, ivec2(clamp(int(i.x)+1,0,ni), yy), 0).r,
      texelFetch(tex, ivec2(clamp(int(i.x)+2,0,ni), yy), 0).r);
    h += wy[y]*dot(wx, r);
  }
  return h;
}
float fineBlend(vec2 p){
  float hf = uFineInfo.z*0.5;
  float e = min(hf-abs(p.x), hf-abs(p.y));
  float t = clamp(e/uFineInfo.w, 0.0, 1.0);
  return t*t*(3.0-2.0*t);
}
float baseHeight(vec2 p){
  float b = fineBlend(p);
  float hc = (b < 1.0) ? bsplineH(uCoarse, uCoarseInfo, p) : 0.0;
  float hf = (b > 0.0) ? bsplineH(uFine, uFineInfo, p) : 0.0;
  return mix(hc, hf, b);
}
vec2 baseGrad(vec2 p){
  float b = fineBlend(p);
  vec2 gc = texture(uGradCoarse, (p + uCoarseInfo.z*0.5)/uCoarseInfo.z).rg;
  vec2 gf = texture(uGradFine, (p + uFineInfo.z*0.5)/uFineInfo.z).rg;
  return mix(gc, gf, b);
}
${NOISE_GLSL}
${DUNE_GLSL}
// height + gradient of the shared medium-scale detail (matches terrain-data.js)
vec3 detailHD(vec2 p, float fade){
  vec3 r = vec3(0.0);
  ${DETAIL_OCTAVES.map(o => `{ vec3 n = vnoiseD(p*${o.f.toFixed(10)} + vec2(${o.ox.toFixed(1)},${o.oz.toFixed(1)}));
    r += vec3((n.x-0.5)*${o.a.toFixed(4)}, n.yz*${(o.f * o.a).toFixed(10)}); }`).join('\n  ')}
  return r*fade;
}
// fine rut map near the car, handing over smoothly to the coarse far map
float deformFineW(vec2 p){
  if (uDeformInfo.w < 0.5) return 0.0;
  vec2 d = abs(p - uDeformInfo.xy); float half_ = uDeformInfo.z*0.5; float m = max(d.x, d.y);
  return 1.0 - smoothstep(half_*0.75, half_*0.95, m);
}
vec4 deformSample(vec2 p){
  float wf = deformFineW(p);
  vec4 c = vec4(0.0);
  if (wf < 1.0 && uDeformInfo2.w > 0.5) {
    vec2 d = abs(p - uDeformInfo2.xy); float half_ = uDeformInfo2.z*0.5; float m = max(d.x, d.y);
    if (m < half_*0.97) c = textureLod(uDeform2, p/uDeformInfo2.z, 0.0)*(1.0 - smoothstep(half_*0.85, half_*0.97, m));
  }
  if (wf <= 0.0) return c;
  return mix(c, textureLod(uDeform, p/uDeformInfo.z, 0.0), wf);
}
`;

function makeQuadrantGeometry(M) {
  const geo = new THREE.InstancedBufferGeometry();
  const pos = new Float32Array((M + 1) * (M + 1) * 3);
  let k = 0;
  for (let j = 0; j <= M; j++) for (let i = 0; i <= M; i++) { pos[k++] = i / M; pos[k++] = 0; pos[k++] = j / M; }
  const idx = [];
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const a = j * (M + 1) + i, b = a + 1, c = a + M + 1, d = c + 1;
    // alternate diagonals for symmetric morphing
    if ((i + j) & 1) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

export class TerrainRenderer {
  constructor(renderer, data, opts) {
    this.renderer = renderer;
    this.data = data;
    this.opts = opts;
    this.N = opts.patchRes;            // grid cells per node
    this.leaf = opts.leafSize;         // meters
    this.range0 = opts.lodRange0;
    this.levels = Math.round(Math.log2(ROOT_SIZE / this.leaf)) + 1;
    this.ranges = [];
    for (let i = 0; i < this.levels; i++) this.ranges.push(this.range0 * Math.pow(2, i));
    this.maxInstances = 8192;
    this.mmCache = new Map();

    const geo = makeQuadrantGeometry(this.N / 2);
    this.instData = new THREE.InstancedBufferAttribute(new Float32Array(this.maxInstances * 4), 4);
    this.instData.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('instData', this.instData);
    geo.instanceCount = 0;
    this.geometry = geo;

    this._makeTextures();
    this.uniforms = {
      uFine: { value: this.fineTex }, uCoarse: { value: this.coarseTex },
      uGradFine: { value: null }, uGradCoarse: { value: null },
      uFineInfo: { value: new THREE.Vector4(data.fineN, data.fineCell, data.fineSize, data.blend) },
      uCoarseInfo: { value: new THREE.Vector4(data.coarseN, data.coarseCell, data.coarseSize, 0) },
      uDeform: { value: null },
      uDeformInfo: { value: new THREE.Vector4(0, 0, 100, 0) },
      uDeform2: { value: null },
      uDeformInfo2: { value: new THREE.Vector4(0, 0, 400, 0) },
      uCamPos: { value: new THREE.Vector3() },
      uRanges: { value: new Float32Array(16) },
      uLeafRes: { value: this.N },
      uSunShadow: { value: null },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uWind: { value: new THREE.Vector2(0.94, 0.34).normalize() },
      uBounce: { value: new THREE.Color(0, 0, 0) }, // warm light bounced off sunlit sand into shade
      // car lights on the sand (LED light bars, whip lights): pos+intensity, dir+cone kind, color
      uLP: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) },
      uLD: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) },
      uLC: { value: Array.from({ length: 16 }, () => new THREE.Vector3()) },
      uLN: { value: 0 },
      // photo-scanned sand detail (Poly Haven Sand 03 + Aerial Beach 01)
      uSandTex: { value: null }, uSandNor: { value: null }, uRipTex: { value: null }, uRipNor: { value: null },
      uTexInfo: { value: new THREE.Vector4(0, 0, 150, 0) }, // centerX, centerZ, radius, mode (0 off, 1 patch, 2 everywhere)
      uTexAvg: { value: new THREE.Vector2(0.4, 0.5) },       // mean luminance of the two diffuse maps
    };
    for (let i = 0; i < this.levels; i++) this.uniforms.uRanges.value[i] = this.ranges[i];
    if (opts.gpu) {
      // WebGPU renderer: node material + bakes from gpu/terrain-gpu.js (same shapes, in WGSL)
      opts.gpu.setupTerrainGPU(this, ROOT_HALF);
      this.mesh = new THREE.Mesh(geo, this.material);
    } else {
      this._bakeGradients();
      this.material = this._makeMaterial(false);
      this.depthMaterial = this._makeMaterial(true);
      this.mesh = new THREE.Mesh(geo, this.material);
      this.mesh.customDepthMaterial = this.depthMaterial;
    }
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._box = new THREE.Box3();
  }

  _makeTextures() {
    const d = this.data;
    const mk = (arr, n) => {
      const t = new THREE.DataTexture(arr, n, n, THREE.RedFormat, THREE.FloatType);
      t.magFilter = t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false; t.needsUpdate = true;
      return t;
    };
    this.fineTex = mk(d.fine, d.fineN);
    this.coarseTex = mk(d.coarse, d.coarseN);
  }

  _fullscreenPass(material, target) {
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    scene.add(quad);
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.render(scene, cam);
    this.renderer.setRenderTarget(prev);
    quad.geometry.dispose();
  }

  // Analytic B-spline gradient of the DEM, stored as a filterable texture
  // so every pixel gets smooth, full-resolution dune normals.
  _bakeGradients() {
    const mkTarget = (n) => new THREE.WebGLRenderTarget(n, n, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
      anisotropy: 8,
    });
    const make = (which, n) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: { tex: { value: which === 'fine' ? this.fineTex : this.coarseTex }, info: { value: which === 'fine' ? this.uniforms.uFineInfo.value : this.uniforms.uCoarseInfo.value } },
        vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
        fragmentShader: /* glsl */`
          precision highp float; precision highp sampler2D;
          uniform sampler2D tex; uniform vec4 info; varying vec2 vUv;
          float bw0(float t){ float it=1.0-t; return it*it*it/6.0; }
          float bw1(float t){ return (3.0*t*t*t-6.0*t*t+4.0)/6.0; }
          float bw2(float t){ return (-3.0*t*t*t+3.0*t*t+3.0*t+1.0)/6.0; }
          float bw3(float t){ return t*t*t/6.0; }
          float bd0(float t){ float it=1.0-t; return -it*it/2.0; }
          float bd1(float t){ return (3.0*t*t-4.0*t)/2.0; }
          float bd2(float t){ return (-3.0*t*t+2.0*t+1.0)/2.0; }
          float bd3(float t){ return t*t/2.0; }
          void main(){
            vec2 p = vUv*info.z - info.z*0.5;
            vec2 uv = (p + info.z*0.5)/info.y - 0.5;
            vec2 i = floor(uv); vec2 t = uv - i;
            vec4 wx = vec4(bw0(t.x),bw1(t.x),bw2(t.x),bw3(t.x));
            vec4 wy = vec4(bw0(t.y),bw1(t.y),bw2(t.y),bw3(t.y));
            vec4 dx = vec4(bd0(t.x),bd1(t.x),bd2(t.x),bd3(t.x));
            vec4 dy = vec4(bd0(t.y),bd1(t.y),bd2(t.y),bd3(t.y));
            int ni = int(info.x)-1; float gx=0.0, gz=0.0, h=0.0;
            for(int y=0;y<4;y++){
              int yy = clamp(int(i.y)-1+y,0,ni);
              vec4 r = vec4(
                texelFetch(tex, ivec2(clamp(int(i.x)-1,0,ni),yy),0).r,
                texelFetch(tex, ivec2(clamp(int(i.x),0,ni),yy),0).r,
                texelFetch(tex, ivec2(clamp(int(i.x)+1,0,ni),yy),0).r,
                texelFetch(tex, ivec2(clamp(int(i.x)+2,0,ni),yy),0).r);
              gx += wy[y]*dot(dx,r); gz += dy[y]*dot(wx,r); h += wy[y]*dot(wx,r);
            }
            gl_FragColor = vec4(gx/info.y, gz/info.y, h, 1.0);
          }`,
      });
      const target = mkTarget(n);
      this._fullscreenPass(mat, target);
      mat.dispose();
      target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
      return target;
    };
    // Gradient texture at 2x the DEM resolution keeps dune crests crisp.
    this.gradFineRT = make('fine', Math.min(this.data.fineN * 2, this.opts.gradRes));
    this.gradCoarseRT = make('coarse', this.data.coarseN);
    this.uniforms.uGradFine.value = this.gradFineRT.texture;
    this.uniforms.uGradCoarse.value = this.gradCoarseRT.texture;
  }

  // Soft terrain self-shadowing for dunes beyond the real-time shadow map.
  bakeSunShadow(sunDir) {
    if (this.bakeSunShadowGPU) { this.bakeSunShadowGPU(sunDir); return; }
    const n = this.opts.sunShadowRes;
    if (!this.sunRT) {
      this.sunRT = new THREE.WebGLRenderTarget(n, n, {
        type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      });
      this.uniforms.uSunShadow.value = this.sunRT.texture;
    }
    const az = new THREE.Vector2(sunDir.x, sunDir.z);
    const horiz = az.length();
    az.normalize();
    const tanSun = sunDir.y / Math.max(horiz, 1e-4);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uFine: { value: this.fineTex }, info: { value: this.uniforms.uFineInfo.value }, dir: { value: az }, tanSun: { value: tanSun } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float; precision highp sampler2D;
        uniform sampler2D uFine; uniform vec4 info; uniform vec2 dir; uniform float tanSun; varying vec2 vUv;
        ${NOISE_GLSL}
        ${DUNE_GLSL}
        float Hdem(vec2 p);
        float H(vec2 p){ return Hdem(p) + duneHD(p).x; }
        float Hdem(vec2 p){
          vec2 uv = (p + info.z*0.5)/info.y - 0.5; vec2 i=floor(uv); vec2 f=uv-i; int ni=int(info.x)-1;
          ivec2 c = ivec2(i);
          float a=texelFetch(uFine, clamp(c,ivec2(0),ivec2(ni)),0).r;
          float b=texelFetch(uFine, clamp(c+ivec2(1,0),ivec2(0),ivec2(ni)),0).r;
          float cc=texelFetch(uFine, clamp(c+ivec2(0,1),ivec2(0),ivec2(ni)),0).r;
          float d=texelFetch(uFine, clamp(c+ivec2(1,1),ivec2(0),ivec2(ni)),0).r;
          return mix(mix(a,b,f.x), mix(cc,d,f.x), f.y);
        }
        void main(){
          vec2 p = vUv*info.z - info.z*0.5;
          float h0 = H(p) + 0.3;
          float maxT = -1.0; float d = 2.0;
          for (int i=0;i<160;i++){
            vec2 q = p + dir*d;
            maxT = max(maxT, (H(q)-h0)/d);
            d *= 1.035; d += 0.5;
            if (d > 3000.0) break;
          }
          float lit = smoothstep(-0.09, 0.09, tanSun - maxT); // soft penumbra over rounded crests
          gl_FragColor = vec4(lit, lit, lit, 1.0);
        }`,
    });
    this._fullscreenPass(mat, this.sunRT);
    mat.dispose();
  }

  _makeMaterial(depth) {
    const u = this.uniforms;
    const vertexHead = /* glsl */`
      ${TERRAIN_GLSL}
      attribute vec4 instData;
      uniform vec3 uCamPos;
      uniform float uRanges[16];
      uniform float uLeafRes;
      varying vec3 vTerrainWorld;
      varying float vDeformDepth;
    `;
    const vertexBody = /* glsl */`
      float M = uLeafRes*0.5;
      vec2 wxz = instData.xy + position.xz*instData.z;
      float spacing = instData.z / M;
      int lvl = int(instData.w + 0.5);
      float h0 = baseHeight(wxz);
      float dist = distance(uCamPos, vec3(wxz.x, h0, wxz.y));
      float mEnd = uRanges[lvl];
      float mStart = mEnd * 0.72;
      float k = clamp((dist - mStart)/(mEnd - mStart), 0.0, 1.0);
      vec2 g = (wxz + ${ROOT_HALF.toFixed(1)}) / spacing;
      vec2 fr = fract(g*0.5)*2.0;
      wxz -= fr*spacing*k;
      float hd = distance(uCamPos.xz, wxz);
      float detailFade = 1.0 - smoothstep(1500.0, 3000.0, hd);
      vec3 dt = detailHD(wxz, detailFade);
      vec4 df = deformSample(wxz);
      vec3 du = duneHD(wxz);
      // ruts move vertices only where triangles are small enough to show them (normals do the rest)
      float dfw = max(deformFineW(wxz), 1.0 - smoothstep(0.25, 0.9, spacing));
      float h = baseHeight(wxz) + du.x + dt.x + (df.g - df.r)*dfw;
      vDeformDepth = df.r*dfw;
      vTerrainWorld = vec3(wxz.x, h, wxz.y);
      vec3 transformed = vTerrainWorld;
    `;
    const mat = depth
      ? new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
      : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.0 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = vertexHead + shader.vertexShader
        .replace('#include <begin_vertex>', vertexBody)
        .replace('#include <beginnormal_vertex>', `
          vec2 gN = baseGrad(position.xz*0.0 + instData.xy + position.xz*instData.z);
          vec3 objectNormal = normalize(vec3(-gN.x, 1.0, -gN.y));
        `);
      if (!depth) {
        shader.fragmentShader = `
          ${TERRAIN_GLSL}
          uniform vec3 uCamPos;
          uniform sampler2D uSunShadow;
          uniform float uTime;
          uniform vec2 uWind;
          uniform vec3 uSunDir;
          uniform vec3 uBounce;
          uniform vec4 uLP[16]; uniform vec4 uLD[16]; uniform vec3 uLC[16]; uniform int uLN;
          uniform sampler2D uSandTex, uSandNor, uRipTex, uRipNor;
          uniform vec4 uTexInfo; uniform vec2 uTexAvg;
          varying vec3 vTerrainWorld;
          varying float vDeformDepth;
          ${SAND_GLSL}
        ` + shader.fragmentShader
          .replace('#include <color_fragment>', `
            SandSurface ss = sandSurface(vTerrainWorld);
            diffuseColor.rgb = ss.albedo;
          `)
          .replace('#include <roughnessmap_fragment>', `float roughnessFactor = ss.roughness;`)
          .replace('#include <normal_fragment_maps>', `normal = normalize((viewMatrix * vec4(ss.normal, 0.0)).xyz);`)
          .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
            reflectedLight.directDiffuse *= ss.sunVis;
            reflectedLight.directSpecular *= ss.sunVis;
            reflectedLight.directSpecular += ss.sparkle * ss.sunVis * directionalLights[0].color;
            reflectedLight.indirectDiffuse *= ss.ao;
            // matte sand has almost no sheen: the Fresnel sky reflection at grazing angles washed distant dunes out to white
            reflectedLight.indirectSpecular *= 0.3;
            reflectedLight.indirectDiffuse += BRDF_Lambert(diffuseColor.rgb) * uBounce * ss.ao;
            // LED light bars (wide flood + long spot) and whip lights
            {
              vec3 Nw = ss.normal; vec3 lsum = vec3(0.0);
              for (int i = 0; i < 16; i++) {
                if (i >= uLN) break;
                vec3 L = uLP[i].xyz - vTerrainWorld; float d2 = dot(L, L); float d = sqrt(d2); L /= d;
                float ndl = max(dot(Nw, L), 0.0);
                float a = uLP[i].w / (d2 + (uLD[i].w > 0.5 ? 16.0 : 1.0));
                if (uLD[i].w > 0.5) {
                  float c = dot(-L, uLD[i].xyz);
                  a *= smoothstep(0.35, 0.8, c)*0.35 + smoothstep(0.955, 0.992, c)*3.0;
                }
                lsum += uLC[i] * a * ndl;
              }
              reflectedLight.directDiffuse += BRDF_Lambert(diffuseColor.rgb) * lsum;
            }
          `);
      }
    };
    mat.customProgramCacheKey = () => 'cdlod-terrain-' + (depth ? 'd' : 'c');
    return mat;
  }

  _minMax(level, ix, iz, x0, z0, size) {
    const key = level * 1e10 + ix * 1e5 + iz;
    let mm = this.mmCache.get(key);
    if (mm) return mm;
    let lo = Infinity, hi = -Infinity;
    const S = 6;
    for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) {
      const h = this.data.sampleBase(x0 + size * i / S, z0 + size * j / S).h;
      if (h < lo) lo = h; if (h > hi) hi = h;
    }
    const pad = Math.max(2, (hi - lo) * 0.25 + size / (S * 4) * 0.5) + RELIEF;
    mm = [lo - pad, hi + pad];
    this.mmCache.set(key, mm);
    return mm;
  }

  _boxDist2(cp, x0, z0, size, lo, hi) {
    const dx = Math.max(x0 - cp.x, 0, cp.x - (x0 + size));
    const dy = Math.max(lo - cp.y, 0, cp.y - hi);
    const dz = Math.max(z0 - cp.z, 0, cp.z - (z0 + size));
    return dx * dx + dy * dy + dz * dz;
  }

  update(camera, lodCamPos) {
    const cp = lodCamPos || camera.position;
    this.uniforms.uCamPos.value.copy(cp);
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._m);
    this.count = 0;
    this._select(this.levels - 1, 0, 0, -ROOT_HALF, -ROOT_HALF, ROOT_SIZE, cp, true);
    this.geometry.instanceCount = this.count;
    this.updateGPU?.();
    this.instData.needsUpdate = true;
    this.instData.clearUpdateRanges();
    this.instData.addUpdateRange(0, this.count * 4);
  }

  _add(x0, z0, size, level) {
    if (this.count >= this.maxInstances) return;
    const a = this.instData.array, o = this.count * 4;
    a[o] = x0; a[o + 1] = z0; a[o + 2] = size; a[o + 3] = level;
    this.count++;
  }

  // Strugar CDLOD selection. Returns false if node is out of its LOD range.
  _select(level, ix, iz, x0, z0, size, cp, cull) {
    const [lo, hi] = this._minMax(level, ix, iz, x0, z0, size);
    const r = this.ranges[level];
    if (this._boxDist2(cp, x0, z0, size, lo, hi) > r * r) return false;
    if (cull) {
      this._box.min.set(x0, lo, z0); this._box.max.set(x0 + size, hi, z0 + size);
      if (!this.frustum.intersectsBox(this._box)) return true; // handled (culled)
    }
    const h = size / 2;
    if (level === 0) {
      for (let q = 0; q < 4; q++) this._add(x0 + (q & 1) * h, z0 + (q >> 1) * h, h, 0);
      return true;
    }
    const rc = this.ranges[level - 1];
    if (this._boxDist2(cp, x0, z0, size, lo, hi) > rc * rc) {
      for (let q = 0; q < 4; q++) this._add(x0 + (q & 1) * h, z0 + (q >> 1) * h, h, level);
      return true;
    }
    for (let q = 0; q < 4; q++) {
      const cx = ix * 2 + (q & 1), cz = iz * 2 + (q >> 1);
      const qx = x0 + (q & 1) * h, qz = z0 + (q >> 1) * h;
      if (!this._select(level - 1, cx, cz, qx, qz, h, cp, cull)) this._add(qx, qz, h, level);
    }
    return true;
  }
}

// Procedural sand surface: no textures, so nothing ever tiles.
const SAND_GLSL = /* glsl */`
struct SandSurface { vec3 albedo; vec3 normal; float roughness; float sunVis; float sparkle; float ao; };

float fbm3(vec2 p){
  float a = 0.0, w = 0.5;
  for (int i=0;i<4;i++){ a += w*vnoiseD(p).x; p = mat2(1.6,1.2,-1.2,1.6)*p + 7.31; w *= 0.5; }
  return a;
}
// Wind ripples (Glamis photo): short sinuous crests ~22 cm apart running across
// the wind, with forks where two ripple trains meet. Asymmetric profile: long
// gentle windward side, short steeper lee side. Returns (dh/dx, dh/dz, crest
// shade) band-limited by the pixel footprint so they never shimmer.
vec2 ripProf(float ph){ return duneProfile(fract(ph), 0.62); }
vec3 ripples(vec2 p, vec2 dpx, vec2 dpy, float amount){
  vec2 w = uWind; vec2 pw = vec2(-w.y, w.x);
  const float LAM = 0.22;
  // band limit in ripple periods per pixel, measured across the crests: from the low driver's seat the pixel
  // footprint is long toward the horizon but narrow sideways, and the old isotropic footprint (length(fwidth(p)))
  // faded the ripples out a few metres ahead even where they run toward you and stay resolvable.
  float fpW = (abs(dot(dpx, w)) + abs(dot(dpy, w)))/LAM;
  if (fpW > 1.2 || amount <= 0.0) return vec3(0.0);
  float u = dot(p, w)/LAM, v = dot(p, pw)/LAM;
  // crests wander: slow bends plus a wiggle every ~1 m along the crest
  vec3 nA = vnoiseD(p*0.9 + 3.1), nB = vnoiseD(p*0.23 - 7.7), nC = vnoiseD(p*2.6 + 1.3);
  float bend = nB.x*5.0 + nA.x*1.4;
  vec2 gBend = (nB.yz*0.23*5.0 + nA.yz*0.9*1.4);
  float wig = 0.34*sin(v*1.25 + nA.x*7.0) + 0.3*(nC.x - 0.5);
  vec2 gWig = 0.34*cos(v*1.25 + nA.x*7.0)*(pw*1.25/LAM + nA.yz*0.9*7.0) + 0.3*nC.yz*2.6;
  // two trains with slightly different spacing and angle; where they hand over, crests fork
  float ph1 = u + bend + wig;
  vec2 gph1 = w/LAM + gBend + gWig;
  float ph2 = u*1.13 + v*0.11 + bend*0.8 - wig + 0.37;
  vec2 gph2 = (w*1.13 + pw*0.11)/LAM + gBend*0.8 - gWig;
  // exact: how far each train's phase moves across one pixel (the crests bend, so not just along the wind)
  float fp1 = abs(dot(dpx, gph1)) + abs(dot(dpy, gph1)), fp2 = abs(dot(dpx, gph2)) + abs(dot(dpy, gph2));
  float fade = 1.0 - smoothstep(0.3, 0.95, max(fp1, fp2));
  if (fade <= 0.0) return vec3(0.0);
  vec3 nM = vnoiseD(p*0.55 + 17.0);
  float m = smoothstep(0.35, 0.65, nM.x); vec2 gm = 6.0*m*(1.0-m)/0.3*nM.yz*0.55;
  vec2 r1 = ripProf(ph1), r2 = ripProf(ph2);
  float A = 0.016*amount*fade;          // ~1 cm tall crests
  float h = mix(r1.x, r2.x, m);
  vec2 g = A*(mix(r1.y*gph1, r2.y*gph2, m) + (r2.x - r1.x)*gm);
  return vec3(g, (h - 0.5)*amount*fade);
}

// ---- hex-tiling (Heitz & Neyret 2018 / Mikkelsen 2022) ----
vec2 hexHash(ivec2 v, int salt){ return vec2(thash(v*3 + ivec2(salt, 11)), thash(v*5 + ivec2(29, salt*7))); }
// returns (luminance relative to the map average, height gradient in uv units)
vec3 hexSample(sampler2D dif, sampler2D nor, vec2 uv, float rotRange, float avg, int salt){
  vec2 st = uv * 3.4641016;
  vec2 sk = vec2(st.x - 0.57735027*st.y, 1.15470054*st.y);
  ivec2 b = ivec2(floor(sk)); vec2 f = fract(sk); float z = 1.0 - f.x - f.y;
  vec3 w; ivec2 v1, v2, v3;
  if (z > 0.0) { w = vec3(z, f.y, f.x); v1 = b; v2 = b + ivec2(0,1); v3 = b + ivec2(1,0); }
  else { w = vec3(-z, 1.0 - f.y, 1.0 - f.x); v1 = b + ivec2(1,1); v2 = b + ivec2(1,0); v3 = b + ivec2(0,1); }
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  float lum[3]; vec2 gr[3];
  ivec2 vs[3]; vs[0] = v1; vs[1] = v2; vs[2] = v3;
  for (int i=0;i<3;i++){
    vec2 h = hexHash(vs[i], salt);
    float a = (h.x - 0.5) * rotRange; float c = cos(a), s = sin(a);
    mat2 R = mat2(c, s, -s, c);
    vec2 u = R*uv + h*7.31 + h.yx*3.17;
    vec2 ddx = R*dx, ddy = R*dy;
    lum[i] = dot(textureGrad(dif, u, ddx, ddy).rgb, vec3(0.299, 0.587, 0.114)) / avg;
    vec3 n = textureGrad(nor, u, ddx, ddy).xyz*2.0 - 1.0;
    gr[i] = transpose(R) * (-n.xy / max(n.z, 0.2));
  }
  // sharpen the blend toward the brighter-detail cell (luminance-weighted, Mikkelsen)
  vec3 wl = w * vec3(1.0 + 0.6*lum[0], 1.0 + 0.6*lum[1], 1.0 + 0.6*lum[2]);
  wl = pow(wl, vec3(5.0)); wl /= dot(wl, vec3(1.0));
  // contrast-preserving blend: keep the photo's variance where three cells mix
  float m = wl.x*lum[0] + wl.y*lum[1] + wl.z*lum[2];
  float k = inversesqrt(max(dot(wl, wl), 1e-3));
  float outL = 1.0 + (m - 1.0) * mix(1.0, k, 0.8);
  vec2 og = (wl.x*gr[0] + wl.y*gr[1] + wl.z*gr[2]) * mix(1.0, k, 0.5);
  return vec3(outL, og);
}

// ---- old tire tracks: Glamis is crisscrossed by sandrail tracks ----
// Each 48 m cell may hold a couple of long curving tracks (pairs of tire grooves
// 1.9 m apart). Purely visual, softened by wind (age). Returns (cover, dh/dx, dh/dz).
vec3 oldTracks(vec2 p, float footprint){
  vec3 r = vec3(0.0);
  const float CELLW = 48.0;
  vec2 cb = floor(p / CELLW);
  for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++){
    ivec2 cid = ivec2(cb) + ivec2(i,j);
    float dens = 0.25 + 0.75*smoothstep(0.35, 0.75, vnoiseD((vec2(cid)+0.5)*CELLW/450.0 + 3.3).x);
    for (int k=0;k<2;k++){
      ivec2 kc = cid*7 + ivec2(k*131, k*57);
      if (thash(kc + ivec2(1,2)) > dens*(k==0 ? 1.0 : 0.75)) continue;
      vec2 q = (vec2(cid) + vec2(thash(kc+ivec2(3,4)), thash(kc+ivec2(5,6))))*CELLW;
      float th = thash(kc+ivec2(7,8))*6.2831853;
      vec2 dir = vec2(cos(th), sin(th)), nrm = vec2(-dir.y, dir.x);
      float kap = (thash(kc+ivec2(9,10)) - 0.5) * 0.06;
      float halfL = 25.0 + 45.0*thash(kc+ivec2(11,12));
      float age = 0.35 + 0.65*thash(kc+ivec2(13,14)); // 1 = fresh, lower = wind-softened
      vec2 d = p - q;
      float t = dot(d, dir);
      float along = 1.0 - smoothstep(halfL*0.75, halfL, abs(t));
      if (along <= 0.0) continue;
      float sl = dot(d, nrm) - 0.5*kap*t*t;
      if (abs(sl) > 2.5) continue;
      vec2 dsl = nrm - kap*t*dir;
      float w = mix(0.4, 0.22, age);                 // old grooves get wider and shallower
      float we = sqrt(w*w + 2.25*footprint*footprint);
      float A = 0.05*age * (w/we) * along;
      for (int s=0;s<2;s++){
        float u = (sl - (s==0 ? -0.95 : 0.95))/we;
        float pr = exp(-u*u);
        r.x = max(r.x, pr*age*along*(w/we));
        r.yz += A*2.0*u/we*pr*dsl;
      }
    }
  }
  return r;
}

SandSurface sandSurface(vec3 wp){
  SandSurface o;
  vec2 p = wp.xz;
  float camD = distance(uCamPos, wp);
  float footprint = max(length(fwidth(p)), 1e-4);

  // ---- normal ----
  vec2 g = baseGrad(p);
  float detailFade = 1.0 - smoothstep(1500.0, 3000.0, distance(uCamPos.xz, p));
  vec3 dt = detailHD(p, detailFade);
  g += dt.yz;
  vec3 duneV = duneHD(p);
  g += duneV.yz;
  // visual-only finer undulation
  { vec3 n1 = vnoiseD(p*0.55 + 11.0); g += n1.yz*0.55*0.025*(1.0-smoothstep(200.0,600.0,camD)); }
  { vec3 n2 = vnoiseD(p*1.7 - 5.0); g += n2.yz*1.7*0.004*(1.0-smoothstep(60.0,200.0,camD)); }

  // tire tracks / churned sand from the deformation map
  vec4 df = deformSample(p);
  float churn = 0.0;
  if (uDeformInfo.w > 0.5 && camD < max(uDeformInfo.z*0.6, uDeformInfo2.z*0.55)) {
    float e = deformFineW(p) > 0.0 ? uDeformInfo.z / float(textureSize(uDeform, 0).x) : uDeformInfo2.z / float(textureSize(uDeform2, 0).x);
    e = max(e, footprint*0.7); // wider steps far away: filters the ruts instead of shimmering
    vec4 dx1 = deformSample(p + vec2(e,0.0)), dx0 = deformSample(p - vec2(e,0.0));
    vec4 dz1 = deformSample(p + vec2(0.0,e)), dz0 = deformSample(p - vec2(0.0,e));
    float hx = ((dx1.g-dx1.r) - (dx0.g-dx0.r))/(2.0*e);
    float hz = ((dz1.g-dz1.r) - (dz0.g-dz0.r))/(2.0*e);
    g += vec2(hx, hz);
    churn = clamp(df.b, 0.0, 1.0);
  }

  // ---- photo-scanned sand textures (test patch or everywhere) ----
  float texW = 0.0; float texLum = 1.0;
  if (uTexInfo.w > 0.5) {
    texW = uTexInfo.w > 1.5 ? 1.0 : 1.0 - smoothstep(uTexInfo.z*0.8, uTexInfo.z, distance(p, uTexInfo.xy));
    texW *= 1.0 - smoothstep(250.0, 700.0, camD);
    if (texW > 0.0) {
      // hex-tiling: every cell of a triangle grid gets its own random offset and
      // rotation; the three nearest are blended with a contrast-preserving blend,
      // so the photo never repeats in a pattern the eye can pick up.
      // the photo only adds grain-scale detail; ripples are procedural below
      vec3 grain = hexSample(uSandTex, uSandNor, p/1.7, 6.2831853, uTexAvg.x, 7);
      vec3 fine = hexSample(uSandTex, uSandNor, p/0.55 + 17.3, 6.2831853, uTexAvg.x, 31);
      float nearF = 1.0 - smoothstep(3.0, 10.0, camD);
      float lum = mix(1.0, grain.x, 0.25) * mix(1.0, fine.x, 0.2*nearF);
      texLum = mix(1.0, lum, texW);
      float strength = texW * (1.0 - churn*0.6) * (1.0 - smoothstep(30.0, 120.0, camD));
      g += (grain.yz*0.18 + fine.yz*0.12*nearF) * strength;
    }
  }

  float slope = length(g);
  // ripples cover the gentle slopes and flats; steeper soft faces stay smooth
  float rippleAmt = (1.0 - smoothstep(0.22, 0.42, slope)) * (1.0 - churn)
                  * (0.75 + 0.25*smoothstep(0.2, 0.8, vnoiseD(p*0.045).x));
  vec3 rip = ripples(p, dFdx(p), dFdy(p), rippleAmt);
  g += rip.xy;
  float ripShade = rip.z;
  // churned sand gets lumpy micro-relief
  if (churn > 0.0) {
    vec3 c1 = vnoiseD(p*9.0); vec3 c2 = vnoiseD(p*23.0+4.0);
    float f = 1.0 - smoothstep(0.03, 0.12, footprint);
    g += (c1.yz*9.0*0.006 + c2.yz*23.0*0.0025) * churn * f;
  }
  float oldCover = 0.0;
  if (camD < 700.0) {
    vec3 ot = oldTracks(p, footprint);
    float of = 1.0 - smoothstep(350.0, 700.0, camD);
    g += ot.yz * of * (1.0 - churn);
    oldCover = ot.x * of * (1.0 - churn);
  }
  o.normal = normalize(vec3(-g.x, 1.0, -g.y));

  // ---- albedo ----
  // Glamis sand: pale golden quartz sand; interdune flats a bit darker & browner.
  // measured from Glamis photos: pale peach-cream quartz sand, sRGB ~ (215,178,144) in sun
  vec3 sandA = vec3(0.64, 0.35, 0.16);
  vec3 sandB = vec3(0.68, 0.375, 0.175);
  vec3 sandDark = vec3(0.57, 0.315, 0.15);
  float n1 = fbm3(p*0.004);
  float n2 = fbm3(p*0.031 + 9.0);
  float n3 = vnoiseD(p*0.33).x;
  vec3 col = mix(sandA, sandB, smoothstep(0.3, 0.7, n1));
  col *= 0.96 + 0.06*n2 + 0.02*n3;
  // sun-bleached crests a touch lighter, troughs a touch darker. With a high sun the ripples throw no
  // shading of their own and washed out, so this tone step grows toward midday (golden hour unchanged)
  float noon = smoothstep(0.45, 0.85, uSunDir.y);
  col *= 1.0 + (0.04 + 0.26*noon)*ripShade;
  col *= clamp(texLum, 0.55, 1.5);
  // interdune: coarse terrain sits above local fine terrain in hollows
  float hollow = 0.0;
  {
    float hc = bsplineH(uCoarse, uCoarseInfo, p);
    float hf = baseHeight(p);
    hollow = smoothstep(1.0, 9.0, hc - hf) * fineBlend(p);
  }
  // flats outside the dune belt (little relief) are desert pavement
  float flat_ = (1.0 - smoothstep(0.02, 0.08, length(baseGrad(p) + duneV.yz))) * (0.5 + 0.5*smoothstep(0.4,0.7,fbm3(p*0.0015+2.0)));
  col = mix(col, sandDark, clamp(hollow*0.45 + flat_*0.35, 0.0, 0.7));
  // slip faces: freshly avalanched sand is slightly lighter and smoother
  float slip = smoothstep(0.45, 0.62, slope);
  col = mix(col, col*1.06, slip);
  // churned, damp-ish sand dug up by paddles is darker and more saturated
  // dug-up sand is a little darker and grainier (photos: tracks read as slightly darker lines)
  col = mix(col, col*vec3(0.86, 0.82, 0.78), churn);
  col *= 1.0 - 0.1*oldCover;
  // track floors also slightly shadowed (cavity)
  float cavity = clamp(vDeformDepth*6.0, 0.0, 1.0);
  o.ao = (1.0 - 0.2*cavity - 0.12*hollow) * (1.0 - 0.6*noon*max(0.0, -ripShade));   // ripple troughs see less sky
  o.albedo = col;
  o.roughness = mix(0.93, 0.98, churn) - 0.06*slip;

  // ---- baked long-range dune shadows ----
  o.sunVis = 1.0;
  {
    vec2 suv = (p + uFineInfo.z*0.5)/uFineInfo.z;
    if (all(greaterThan(suv, vec2(0.0))) && all(lessThan(suv, vec2(1.0)))) {
      float bake = texture(uSunShadow, suv).r;
      float useBake = smoothstep(60.0, 110.0, camD);
      o.sunVis = mix(1.0, bake, max(useBake, 0.0));
    }
  }

  // ---- sparkle: individual quartz grains catching the sun ----
  o.sparkle = 0.0;
  if (camD < 25.0) {
    vec2 cell = floor(p*400.0);
    float r = thash(ivec2(cell));
    if (r > 0.985) {
      vec3 V = normalize(uCamPos - wp);
      vec3 gN = normalize(vec3(thash(ivec2(cell)+7)-0.5, 0.6, thash(ivec2(cell)+13)-0.5));
      vec3 Hh = normalize(uSunDir + V);
      float s = pow(max(dot(gN, Hh), 0.0), 400.0);
      o.sparkle = s * 3.0 * (1.0 - smoothstep(8.0, 25.0, camD)) * (1.0-churn);
    }
  }
  return o;
}
`;
