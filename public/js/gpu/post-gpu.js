// WebGPU version of the screen effects (post.js): bloom, heat shimmer and the golden-hour
// colour grade with vignette, on three's RenderPipeline. Same interface as PostFX; with every effect off
// the scene is drawn straight to the screen.
import * as THREE from 'three';
import { RenderPipeline } from 'three/webgpu';
import { pass, renderOutput, convertToTexture, screenUV, uniform, wgslFn, texture, sampler } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

// display space (after tone mapping). WebGPU screen coordinates run top-down: uHorizon is the horizon's
// screen v from the top, and the far sand is just below it (v a little larger)
const FINAL_WGSL = /* wgsl */`
fn postFinal(t: texture_2d<f32>, s: sampler, uvIn: vec2<f32>, res: vec2<f32>, tm: f32, horizon: f32,
             shimmer: f32, grade: f32, golden: f32, night: f32) -> vec4<f32> {
  var uv = uvIn;
  if (shimmer > 0.0) {
    let d = uv.y - horizon;
    let band = smoothstep(-0.01, 0.012, d) * (1.0 - smoothstep(0.02, 0.11, d));
    if (band > 0.0) {
      let q = vec2<f32>(uv.x * res.x / res.y * 60.0, (1.0 - uv.y) * 140.0 - tm * 2.2);
      let n = pvn(q) + 0.5 * pvn(q * 2.3 + 7.0) - 0.75;
      uv.y -= n * band * shimmer * 0.0022;
      uv.x += (pvn(q.yx * 0.7 + 3.0) - 0.5) * band * shimmer * 0.0010;
    }
  }
  var col = textureSampleLevel(t, s, uv, 0.0).rgb;
  if (grade > 0.0) {
    let l = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
    var g = col;
    g = mix(g, g * g * (3.0 - 2.0 * g), 0.32);
    g = mix(vec3<f32>(l), g, 1.16);
    let warm = vec3<f32>(1.035, 1.0, 0.94) + golden * vec3<f32>(0.05, 0.005, -0.07);
    g *= mix(vec3<f32>(0.985, 0.995, 1.025), warm, smoothstep(0.15, 0.8, l));
    g = mix(g, g * vec3<f32>(0.94, 0.98, 1.08), night * 0.6);
    let v = uvIn - 0.5; let vig = 1.0 - dot(v, v) * 0.55;
    g *= mix(1.0, vig, 0.9);
    col = mix(col, g, grade);
  }
  return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
fn ph21(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
fn pvn(p: vec2<f32>) -> f32 {
  let i = floor(p); var f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(ph21(i), ph21(i + vec2<f32>(1.0, 0.0)), f.x), mix(ph21(i + vec2<f32>(0.0, 1.0)), ph21(i + vec2<f32>(1.0, 1.0)), f.x), f.y);
}
`;
const finalFn = wgslFn(FINAL_WGSL);

export class PostFXGPU {
  constructor(renderer, scene, camera, msaa) {
    this.renderer = renderer; this.scene = scene; this.camera = camera; this.msaa = msaa;
    this.opts = { bloom: true, shimmer: true, grade: true };
    this.u = {
      res: uniform(new THREE.Vector2(1, 1)), tm: uniform(0), horizon: uniform(0.5), shimmer: uniform(0),
      grade: uniform(0), golden: uniform(0), night: uniform(0),
    };
    this.pipeline = new RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;
    this.t = 0; this.built = '';
    this._h = new THREE.Vector3(); this._f = new THREE.Vector3();
  }

  get active() { const o = this.opts; return o.bloom || o.shimmer || o.grade; }
  set(opts) { Object.assign(this.opts, opts); }
  setSize() { /* the pipeline follows the renderer's size */ }

  _build() {
    const key = this.opts.bloom ? 'b' : 'n';
    if (this.built === key) return;
    this.built = key;
    const scenePass = pass(this.scene, this.camera, { samples: this.msaa ? 4 : 0 });
    const color = scenePass.getTextureNode('output');
    let hdr = color;
    if (this.opts.bloom) { this.bloomNode = bloom(color, 0.22, 0.4, 6.0); hdr = color.add(this.bloomNode); } else this.bloomNode = null;
    const ldr = convertToTexture(renderOutput(hdr));
    const u = this.u;
    this.pipeline.outputNode = finalFn({ t: ldr, s: sampler(ldr), uvIn: screenUV, res: u.res, tm: u.tm, horizon: u.horizon,
      shimmer: u.shimmer, grade: u.grade, golden: u.golden, night: u.night });
    this.pipeline.needsUpdate = true;
  }

  render(dt, light, speed, cockpit) {
    if (!this.active) { this.renderer.render(this.scene, this.camera); return; }
    this._build();
    this.t += dt;
    const u = this.u, o = this.opts, day = light.night ? 0 : Math.min(1, Math.max(0, light.el * 180 / Math.PI / 10));
    this.camera.getWorldDirection(this._f); this._f.y = 0;
    if (this._f.lengthSq() < 1e-6) this._f.set(0, 0, 1);
    this._h.copy(this.camera.position).addScaledVector(this._f.normalize(), 5000).project(this.camera);
    u.horizon.value = 0.5 - this._h.y * 0.5;
    u.tm.value = this.t;
    this.renderer.getDrawingBufferSize(u.res.value);
    u.shimmer.value = o.shimmer ? day * Math.min(1, Math.max(0, (light.el * 180 / Math.PI - 12) / 25)) * (cockpit ? 0.7 : 1) : 0;
    u.grade.value = o.grade ? 1 : 0;
    u.golden.value = light.night ? 0 : light.warm;
    u.night.value = light.night ? 1 : 0;
    // glow only at night (LEDs, whips, lamps): by day the bright sky and sand bloomed into a milky haze
    if (this.bloomNode) {
      this.bloomNode.threshold.value = 2.2;
      this.bloomNode.strength.value = light.night ? 0.45 : 0;
    }
    this.pipeline.render();
  }
}
