// Full-throttle straight-line run: 0-60 time, top speed, and the forces at the end.
//   node tools/speedtest.mjs [flat|real] [seconds]
import fs from 'fs';
import { fileURLToPath } from 'url';
import * as THREE from 'three';
import { TerrainData } from '../public/js/terrain-data.js';
import { SandrailPhysics, SANDRAIL_SPEC } from '../public/js/vehicle-physics.js';
const mode = process.argv[2] || 'real', T = +(process.argv[3] || 40);
let terrain, x0 = 0, z0 = 0;
if (mode === 'flat') terrain = { sample: () => ({ h: 0, dx: 0, dz: 0 }), height: () => 0, normal: (x, z, t) => t.set(0, 1, 0) };
else {
  const base = fileURLToPath(new URL('../public/data/', import.meta.url));
  const meta = JSON.parse(fs.readFileSync(base + 'terrain.json'));
  terrain = new TerrainData(meta, new Uint16Array(fs.readFileSync(base + 'height_fine.u16').buffer.slice(0)), new Uint16Array(fs.readFileSync(base + 'height_coarse.u16').buffer.slice(0)));
  x0 = 2881; z0 = -4127;
}
const spec = process.env.SPEC ? JSON.parse(fs.readFileSync(process.env.SPEC)) : SANDRAIL_SPEC;
const c = new SandrailPhysics(terrain, spec); c.reset(x0, z0, +(process.env.YAW || 0));
const dt = 1 / 60; let t60 = null, t100 = null, vmax = 0;
for (let i = 0; i < 90; i++) c.update(dt);
for (let t = 0; t < T; t += dt) {
  Object.assign(c.input, { throttle: 1, steer: 0, brake: 0, handbrake: false });
  c.update(dt);
  const mph = c.forwardSpeed * 2.237; vmax = Math.max(vmax, mph);
  if (t60 === null && mph >= 60) t60 = t; if (t100 === null && mph >= 100) t100 = t;
  if (Math.round(t / dt) % 120 === 0) console.log(`t${t.toFixed(0).padStart(3)} ${mph.toFixed(0).padStart(4)}mph g${c.gear} rpm${c.rpm.toFixed(0)} thrEff${(c.throttleEff ?? 0).toFixed(2)} Teng${(c.engineTorqueOut || 0).toFixed(0)} slip ${c.wheels.map(w => w.slipRatio.toFixed(2)).join(',')} sink ${c.wheels.map(w => w.sink.toFixed(2)).join(',')} gnd ${c.wheels.map(w => w.onGround ? 1 : 0).join('')}`);
}
console.log(`${mode}: 0-60 ${t60?.toFixed(1)} s, 0-100 ${t100?.toFixed(1) ?? '-'} s, top ${vmax.toFixed(0)} mph`);
