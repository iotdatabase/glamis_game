// Screen effects: bloom (sun, LED light bars, whips), heat shimmer over the distant sand, a little
// speed blur toward the screen edges, and a warm golden-hour colour grade with a soft vignette.
// Each one can be switched in M > Quality; with all of them off the game renders straight to the
// screen exactly as before (no extra passes).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// final pass, in display space (after tone mapping): shimmer + speed blur + grade + vignette
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) },
    uHorizon: { value: 0.5 }, uShimmer: { value: 0 }, uBlur: { value: 0 }, uGrade: { value: 0 }, uGolden: { value: 0 }, uNight: { value: 0 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uRes;
uniform float uHorizon, uShimmer, uBlur, uGrade, uGolden, uNight;
varying vec2 vUv;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
void main(){
  vec2 uv = vUv;
  // heat shimmer: a thin band just below the horizon (the far sand), wavering upward
  if (uShimmer > 0.0) {
    float d = uHorizon - uv.y;                       // > 0 below the horizon
    float band = smoothstep(-0.01, 0.012, d) * (1.0 - smoothstep(0.02, 0.11, d));
    if (band > 0.0) {
      vec2 q = vec2(uv.x * uRes.x / uRes.y * 60.0, uv.y * 140.0 - uTime * 2.2);
      float n = vnoise(q) + 0.5 * vnoise(q * 2.3 + 7.0) - 0.75;
      uv.y += n * band * uShimmer * 0.0022;
      uv.x += (vnoise(q.yx * 0.7 + 3.0) - 0.5) * band * uShimmer * 0.0010;
    }
  }
  vec3 col = texture2D(tDiffuse, uv).rgb;
  // speed blur: radial streaks toward the screen edges (the car in the middle stays sharp)
  if (uBlur > 0.001) {
    vec2 c = uv - 0.5;
    float e = smoothstep(0.18, 0.75, length(c * vec2(uRes.x / uRes.y, 1.0)));
    vec2 stepv = c * uBlur * e * 0.018;
    vec3 acc = col; float w = 1.0;
    for (int i = 1; i <= 7; i++) { float fi = float(i); acc += texture2D(tDiffuse, uv - stepv * fi).rgb * (1.0 - fi * 0.1); w += 1.0 - fi * 0.1; }
    col = acc / w;
  }
  if (uGrade > 0.0) {
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    vec3 g = col;
    // gentle S-curve and a touch more colour
    g = mix(g, g * g * (3.0 - 2.0 * g), 0.22);
    g = mix(vec3(l), g, 1.08);
    // warm highlights, slightly cool shadows; stronger when the sun is low (golden hour)
    vec3 warm = vec3(1.035, 1.0, 0.94) + uGolden * vec3(0.05, 0.005, -0.07);
    g *= mix(vec3(0.985, 0.995, 1.025), warm, smoothstep(0.15, 0.8, l));
    g = mix(g, g * vec3(0.94, 0.98, 1.08), uNight * 0.6);   // moonlight: a little bluer
    // soft vignette
    vec2 v = vUv - 0.5; float vig = 1.0 - dot(v, v) * 0.55;
    g *= mix(1.0, vig, 0.9);
    col = mix(col, g, uGrade);
  }
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`,
};

export class PostFX {
  constructor(renderer, scene, camera, msaa) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: msaa ? 4 : 0 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.setSize(innerWidth, innerHeight);
    this.renderPass = new RenderPass(scene, camera);
    // bloom at half resolution: only very bright things (sun disc, lamps, LEDs) glow
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.22, 0.4, 6.0);
    this.output = new OutputPass();
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
    this.composer.addPass(this.final);
    this.opts = { bloom: true, shimmer: true, grade: true, blur: true };
    this.t = 0; this.blurNow = 0;
    this._h = new THREE.Vector3(); this._f = new THREE.Vector3();
  }

  get active() { const o = this.opts; return o.bloom || o.shimmer || o.grade || o.blur; }
  set(opts) { Object.assign(this.opts, opts); this.bloom.enabled = this.opts.bloom; }

  setSize(w, h) { this.composer.setPixelRatio(this.renderer.getPixelRatio()); this.composer.setSize(w, h); }

  // light: { el (sun elevation, rad), warm (0..1, low sun), night }, speed m/s
  render(dt, light, speed, cockpit) {
    if (!this.active) { this.renderer.render(this.scene, this.camera); return; }
    this.t += dt;
    const u = this.final.uniforms, o = this.opts, day = light.night ? 0 : Math.min(1, Math.max(0, light.el * 180 / Math.PI / 10));
    // horizon on screen: a point far away straight ahead at camera height
    this.camera.getWorldDirection(this._f); this._f.y = 0;
    if (this._f.lengthSq() < 1e-6) this._f.set(0, 0, 1);
    this._h.copy(this.camera.position).addScaledVector(this._f.normalize(), 5000).project(this.camera);
    u.uHorizon.value = this._h.y * 0.5 + 0.5;
    u.uTime.value = this.t;
    this.renderer.getDrawingBufferSize(u.uRes.value);
    // shimmer only in strong sun, a bit less in the cockpit (the windscreen frame is close)
    u.uShimmer.value = o.shimmer ? day * Math.min(1, Math.max(0, (light.el * 180 / Math.PI - 12) / 25)) * (cockpit ? 0.7 : 1) : 0;
    const target = o.blur ? Math.min(1, Math.max(0, (Math.abs(speed) - 22) / 30)) : 0;   // from ~50 mph, full at ~117 mph
    this.blurNow += (target - this.blurNow) * Math.min(1, dt * 3);
    u.uBlur.value = this.blurNow;
    u.uGrade.value = o.grade ? 1 : 0;
    u.uGolden.value = light.night ? 0 : light.warm;
    u.uNight.value = light.night ? 1 : 0;
    // LEDs and whips glow more at night (the scene is darker, exposure higher)
    this.bloom.threshold = light.night ? 2.2 : 6.0;
    this.bloom.strength = light.night ? 0.45 : 0.22;
    this.composer.render(dt);
  }
}
