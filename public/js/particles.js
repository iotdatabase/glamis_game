// Sand roost (thrown sand grains and clumps) and dust clouds.
// CPU-simulated, GPU-instanced soft billboards lit by the sun.
import * as THREE from 'three';

const VS = /* glsl */`
attribute vec4 iPos;    // xyz, size
attribute vec4 iData;   // alpha, shade, rotation, kind
varying vec2 vUv; varying float vAlpha; varying float vShade; varying float vKind;
varying vec3 vWorld;
void main(){
  vUv = position.xy;
  vAlpha = iData.x; vShade = iData.y; vKind = iData.w;
  float c = cos(iData.z), s = sin(iData.z);
  vec2 q = mat2(c,-s,s,c)*position.xy;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = iPos.xyz + (right*q.x + up*q.y)*iPos.w;
  vWorld = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const FS = /* glsl */`
uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uAmbient; uniform vec3 uSand;
uniform vec3 uFogColor; uniform float uFogDensity; uniform vec3 uCam;
uniform vec4 uLP[16]; uniform vec4 uLD[16]; uniform vec3 uLC[16]; uniform int uLN;
varying vec2 vUv; varying float vAlpha; varying float vShade; varying float vKind;
varying vec3 vWorld;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
void main(){
  vec2 p = vUv*2.0;
  float r2 = dot(p,p);
  if (r2 > 1.0) discard;
  vec3 n = normalize(vec3(p, sqrt(1.0 - r2)));
  float a;
  vec3 col;
  if (vKind < 0.5) {
    // grain clump: crisp, lumpy edge
    float lump = 0.75 + 0.25*h(floor(p*3.0 + vShade*10.0));
    a = smoothstep(lump, lump - 0.25, sqrt(r2));
    float diff = max(dot(n, uSunDir)*0.6 + 0.4, 0.0);
    col = uSand*vShade*(uSunColor*diff*0.8 + uAmbient);
  } else {
    // dust puff: soft, back-lit glow when looking toward the sun
    a = (1.0 - r2); a *= a;
    vec3 V = normalize(uCam - vWorld);
    float fwd = pow(max(dot(-V, uSunDir), 0.0), 6.0);
    col = uSand*vShade*(uSunColor*(0.55 + 0.9*fwd) + uAmbient*1.1);
  }
  // car lights: dust glows where a light bar beam or a whip shines through it
  vec3 lsum = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (i >= uLN) break;
    vec3 L = uLP[i].xyz - vWorld; float d2 = dot(L, L);
    float la = uLP[i].w / (d2 + (uLD[i].w > 0.5 ? 16.0 : 1.0));
    if (uLD[i].w > 0.5) { float c = dot(-L*inversesqrt(d2), uLD[i].xyz); la *= smoothstep(0.35, 0.8, c)*0.35 + smoothstep(0.955, 0.992, c)*3.0; }
    lsum += uLC[i]*la;
  }
  col += uSand*vShade*lsum*(vKind < 0.5 ? 0.3 : 0.22);
  float d = distance(uCam, vWorld);
  float fog = 1.0 - exp(-uFogDensity*uFogDensity*d*d);
  col = mix(col, uFogColor, fog);
  gl_FragColor = vec4(col, a*vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

class Pool {
  constructor(n, kind, scene, mat) {
    this.n = n; this.kind = kind; this.count = 0;
    this.p = new Float32Array(n * 3); this.v = new Float32Array(n * 3);
    this.life = new Float32Array(n); this.max = new Float32Array(n);
    this.size = new Float32Array(n); this.grow = new Float32Array(n);
    this.shade = new Float32Array(n); this.rot = new Float32Array(n); this.gy = new Float32Array(n);
    this.alpha0 = new Float32Array(n);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]), 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.iData = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.iPos); geo.setAttribute('iData', this.iData);
    geo.instanceCount = 0;
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = kind === 0 ? 2 : 3;
    scene.add(this.mesh);
  }
  spawn(x, y, z, vx, vy, vz, life, size, grow, shade, gy, alpha) {
    let i;
    if (this.count < this.n) i = this.count++;
    else i = (Math.random() * this.n) | 0; // recycle a random one when full
    const k = i * 3;
    this.p[k] = x; this.p[k + 1] = y; this.p[k + 2] = z;
    this.v[k] = vx; this.v[k + 1] = vy; this.v[k + 2] = vz;
    this.life[i] = 0; this.max[i] = life; this.size[i] = size; this.grow[i] = grow;
    this.shade[i] = shade; this.rot[i] = Math.random() * 6.28; this.gy[i] = gy; this.alpha0[i] = alpha;
  }
  kill(i) {
    const j = --this.count;
    if (i !== j) {
      const ki = i * 3, kj = j * 3;
      for (let c = 0; c < 3; c++) { this.p[ki + c] = this.p[kj + c]; this.v[ki + c] = this.v[kj + c]; }
      this.life[i] = this.life[j]; this.max[i] = this.max[j]; this.size[i] = this.size[j]; this.grow[i] = this.grow[j];
      this.shade[i] = this.shade[j]; this.rot[i] = this.rot[j]; this.gy[i] = this.gy[j]; this.alpha0[i] = this.alpha0[j];
    }
  }
  update(dt, drag, gravity, wind) {
    const P = this.p, Vv = this.v;
    for (let i = this.count - 1; i >= 0; i--) {
      this.life[i] += dt;
      const k = i * 3;
      if (this.life[i] >= this.max[i]) { this.kill(i); continue; }
      const dmp = Math.exp(-drag * dt);
      Vv[k] = (Vv[k] - wind[0]) * dmp + wind[0];
      Vv[k + 1] = Vv[k + 1] * dmp - gravity * dt;
      Vv[k + 2] = (Vv[k + 2] - wind[1]) * dmp + wind[1];
      P[k] += Vv[k] * dt; P[k + 1] += Vv[k + 1] * dt; P[k + 2] += Vv[k + 2] * dt;
      if (this.kind === 0 && P[k + 1] < this.gy[i] - 0.05 && Vv[k + 1] < 0) { this.kill(i); continue; }
      if (this.kind === 1 && P[k + 1] < this.gy[i] + this.size[i] * 0.3) { P[k + 1] = this.gy[i] + this.size[i] * 0.3; Vv[k + 1] = Math.abs(Vv[k + 1]) * 0.2; }
    }
    const a = this.iPos.array, d = this.iData.array;
    for (let i = 0; i < this.count; i++) {
      const t = this.life[i] / this.max[i];
      const k = i * 3, o = i * 4;
      a[o] = P[k]; a[o + 1] = P[k + 1]; a[o + 2] = P[k + 2];
      a[o + 3] = this.size[i] + this.grow[i] * this.life[i];
      const fadeIn = Math.min(1, this.life[i] * (this.kind ? 4 : 30));
      d[o] = this.alpha0[i] * fadeIn * (1 - t * t);
      d[o + 1] = this.shade[i]; d[o + 2] = this.rot[i] + this.life[i] * (this.kind ? 0.2 : 3); d[o + 3] = this.kind;
    }
    this.geo.instanceCount = this.count;
    this.iPos.needsUpdate = true; this.iData.needsUpdate = true;
    this.iPos.clearUpdateRanges(); this.iPos.addUpdateRange(0, this.count * 4);
    this.iData.clearUpdateRanges(); this.iData.addUpdateRange(0, this.count * 4);
  }
}

export class SandParticles {
  constructor(scene, opts) {
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uAmbient: { value: new THREE.Color(0.35, 0.38, 0.45) },
      uLP: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) }, uLD: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) },
      uLC: { value: Array.from({ length: 16 }, () => new THREE.Vector3()) }, uLN: { value: 0 }, uSand: { value: new THREE.Color(0.80, 0.56, 0.36) }, // Glamis sand (matches the terrain albedo)
      uFogColor: { value: new THREE.Color() }, uFogDensity: { value: 0 }, uCam: { value: new THREE.Vector3() },
    };
    // (opts.makeMaterial: the WebGPU renderer brings its own node material, gpu/effects-gpu.js)
    const mk = opts.makeMaterial ? () => opts.makeMaterial(this) : () => new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VS, fragmentShader: FS,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    this.grains = new Pool(opts.grains, 0, scene, mk());
    this.dust = new Pool(opts.dust, 1, scene, mk());
    this.wind = [1.2, 0.4];
    this.emitScale = opts.emitScale ?? 1;
  }

  // Throw sand from a tire. contact: Vector3, fwd: unit wheel forward (world),
  // surf: tire surface speed relative to ground (m/s, + = spinning forward),
  // carVel: Vector3, side: unit left vector, intensity 0..1, gy: ground height.
  emitWheel(dt, contact, fwd, side, carVel, surf, lateralSlide, isPaddle, gy) {
    const spin = Math.abs(surf);
    const roost = isPaddle ? Math.max(0, spin - 1.5) : 0;
    const slide = Math.max(0, Math.abs(lateralSlide) - 2);
    const speed = carVel.length();
    // grains per second
    const rate = (roost * 1600 + slide * 260 + (speed > 6 ? speed * 8 : 0)) * this.emitScale;
    let n = rate * dt;
    n = Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
    const dir = Math.sign(surf) || 1;
    for (let i = 0; i < n; i++) {
      const throwV = roost > 0 ? spin * (0.4 + Math.random() * 0.6) : 1.0 + Math.random() * 2;
      const up = roost > 0 ? spin * (0.3 + Math.random() * 0.6) : 1 + Math.random() * 2.5;
      const lat = (Math.random() - 0.5) * (1.5 + spin * 0.12) + lateralSlide * 0.4;
      const ox = (Math.random() - 0.5) * 0.3, oz = (Math.random() - 0.5) * 0.3;
      const bx = -fwd.x * dir, bz = -fwd.z * dir;
      this.grains.spawn(
        contact.x + bx * 0.35 + side.x * ox + fwd.x * oz, contact.y + 0.05 + Math.random() * 0.12, contact.z + bz * 0.35 + side.z * ox + fwd.z * oz,
        carVel.x * 0.6 + bx * throwV + side.x * lat, up + Math.random() * 0.5, carVel.z * 0.6 + bz * throwV + side.z * lat,
        0.7 + Math.random() * 1.4, 0.012 + Math.random() * Math.random() * 0.06, 0.0, 0.85 + Math.random() * 0.35, gy, 1.0,
      );
    }
    // dust clouds
    const drate = (roost * 22 + slide * 6 + speed * 0.9) * this.emitScale;
    let m = drate * dt;
    m = Math.floor(m) + (Math.random() < m % 1 ? 1 : 0);
    for (let i = 0; i < m; i++) {
      const bx = -fwd.x * dir, bz = -fwd.z * dir;
      const tv = roost > 0 ? spin * (0.15 + Math.random() * 0.25) : 0.5;
      this.dust.spawn(
        contact.x + bx * 0.6, contact.y + 0.3, contact.z + bz * 0.6,
        carVel.x * 0.35 + bx * tv + (Math.random() - 0.5) * 2, 0.6 + Math.random() * (1 + roost * 0.15), carVel.z * 0.35 + bz * tv + (Math.random() - 0.5) * 2,
        4 + Math.random() * 6, 0.5 + Math.random() * 0.6, 0.7 + Math.random() * 0.8 + roost * 0.05, 0.85 + Math.random() * 0.25, gy, 0.13 + Math.min(roost * 0.012, 0.14),
      );
    }
    // the top of a rooster tail: big slow puffs 2-6 m up behind the car that drift and settle
    if (roost > 4) {
      let k = roost * 1.2 * this.emitScale * dt;
      k = Math.floor(k) + (Math.random() < k % 1 ? 1 : 0);
      for (let i = 0; i < k; i++) {
        const bx = -fwd.x * dir, bz = -fwd.z * dir, back = 1.5 + Math.random() * 3.5;
        this.dust.spawn(
          contact.x + bx * back + (Math.random() - 0.5), contact.y + 1.5 + Math.random() * Math.min(5, roost * 0.25), contact.z + bz * back + (Math.random() - 0.5),
          carVel.x * 0.2 + bx * 2 + (Math.random() - 0.5) * 1.5, 0.3 + Math.random() * 0.6, carVel.z * 0.2 + bz * 2 + (Math.random() - 0.5) * 1.5,
          6 + Math.random() * 7, 1.2 + Math.random() * 1.2, 0.5 + Math.random() * 0.6, 0.9 + Math.random() * 0.2, gy, 0.10 + Math.min(roost * 0.006, 0.08),
        );
      }
    }
  }

  update(dt, camera) {
    this.uniforms.uCam.value.copy(camera.position);
    this.grains.update(dt, 0.25, this.gravity ?? 9.81, this.wind);
    this.dust.update(dt, 1.1, 0.04, this.wind);
  }
}
