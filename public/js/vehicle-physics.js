// Sandrail vehicle dynamics: 6-DOF rigid body, long-travel suspension,
// sand tire model (paddle rears, ribbed fronts) with sinkage and digging,
// 1200 hp big-block V8 through a torque converter and 3-speed automatic.
// Runs at 1000 Hz. Body axes: +X left, +Y up, +Z forward (right-handed). Units SI.
import * as THREE from 'three';
import { tracksFor } from './sand-tracks.js';

const G = 9.81;
// Cars are heavier than the world: their gravity is scaled up (on top of the menu's Gravity) so
// they come back down fast over crests and stay planted. Spring rates scale with it (same ride height).
const WEIGHT = 1.3;
const CL_A = 5.0;                   // downforce coefficient x area (m^2): 0.32 g at 80 mph, nothing at crawling speed
const AERO_DAMP = 0.1;              // pitch / roll damping per (m/s) of airspeed: the car holds its attitude in the air
const _rut = { depth: 0, berm: 0 };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export const SANDRAIL_SPEC = {
  mass: 1180,                       // kg, car + driver + fuel
  inertia: [1700, 1860, 440],       // pitch(x), yaw(y), roll(z) kg m^2
  // Model coordinates: origin = mid-wheelbase on the ground, +Z forward.
  cg: [0, 0.80, -0.65],             // 31 % front / 69 % rear weight
  wheelbase: 3.40,
  wheels: [
    // x, hub y at ride, z, radius, width, travel, sag, front?
    { id: 'FL', x: 1.02, y: 0.38, z: 1.70, r: 0.38, w: 0.25, travel: 0.50, sag: 0.15, front: true },
    { id: 'FR', x: -1.02, y: 0.38, z: 1.70, r: 0.38, w: 0.25, travel: 0.50, sag: 0.15, front: true },
    { id: 'RL', x: 1.00, y: 0.41, z: -1.70, r: 0.41, w: 0.36, travel: 0.60, sag: 0.21, front: false },
    { id: 'RR', x: -1.00, y: 0.41, z: -1.70, r: 0.41, w: 0.36, travel: 0.60, sag: 0.21, front: false },
  ],
  // Engine: supercharged big-block, 1200 hp @ 6800 rpm.
  torqueCurve: [[0, 500], [1000, 720], [2000, 960], [3000, 1170], [4000, 1340], [5000, 1420], [6000, 1395], [6800, 1257], [7500, 1060], [8000, 900]],
  idleRpm: 1000, revLimit: 7500, engineInertia: 0.32,
  converterK: 105,                  // stall ~3800 rpm
  gears: [2.48, 1.48, 1.00], reverse: 2.08, finalDrive: 6.2,
  shiftUp: 7050, shiftDown: 3300, shiftTime: 0.22,
  maxSteer: 0.60,                   // rad (34 deg: ~20 ft turning radius at low speed)
  brakeFront: 2200, brakeRear: 3600,
  cdA: 0.95,
  // Hull points that can hit the ground (model coords)
  hull: [
    [0.72, 1.78, 0.75], [-0.72, 1.78, 0.75], [0.72, 1.78, -1.25], [-0.72, 1.78, -1.25],
    [0, 0.42, 2.45], [0.42, 0.38, 2.15], [-0.42, 0.38, 2.15],
    [0.5, 0.26, 1.0], [-0.5, 0.26, 1.0], [0.55, 0.28, -0.9], [-0.55, 0.28, -0.9],
    [0, 0.62, -2.65], [0.92, 0.95, -2.6], [-0.92, 0.95, -2.6],
    [0.98, 0.85, 0.1], [-0.98, 0.85, 0.1], [0.9, 1.25, 1.35], [-0.9, 1.25, 1.35],
  ],
};

function lerpCurve(c, x) {
  if (x <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) if (x < c[i][0]) {
    const t = (x - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
    return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t;
  }
  return c[c.length - 1][1];
}

// Pacejka-style magic formula, normalized
function mf(s, B, C, E) {
  const bs = B * s;
  return Math.sin(C * Math.atan(bs - E * (bs - Math.atan(bs))));
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _n = new THREE.Vector3();
const _ra = new THREE.Vector3(), _rb = new THREE.Vector3();
const _n2 = new THREE.Vector3();

export class SandrailPhysics {
  constructor(terrain, spec = SANDRAIL_SPEC) {
    this.terrain = terrain;
    this.spec = spec;
    this.m = spec.mass;
    this.I = new THREE.Vector3(...spec.inertia);
    this.cg = new THREE.Vector3(...spec.cg);
    this.pos = new THREE.Vector3();          // CG world
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.angVelB = new THREE.Vector3();      // body frame
    this.force = new THREE.Vector3();
    this.torqueW = new THREE.Vector3();
    this.wheels = spec.wheels.map((w) => {
      const frac = w.front ? (this.cg.z + spec.wheelbase / 2) / spec.wheelbase : (spec.wheelbase / 2 - this.cg.z) / spec.wheelbase;
      const k = (this.m * G * WEIGHT * frac / 2) / w.sag;
      const mCorner = k * w.sag / (G * WEIGHT);
      return {
        ...w,
        k,
        cBump: 2 * 0.45 * Math.sqrt(k * mCorner),
        cReb: 2 * 0.9 * Math.sqrt(k * mCorner),
        top: new THREE.Vector3(w.x, w.y + (w.travel - w.sag), w.z).sub(this.cg), // body coords, full bump
        comp: w.sag, compVel: 0,
        omega: 0, angle: 0, steer: 0,
        inertia: w.front ? 1.4 : 3.2,
        onGround: false, Fz: 0, slipRatio: 0, slipAngle: 0, sink: 0, digSink: 0, staticSink: 0,
        contact: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
        hubW: new THREE.Vector3(), fwdW: new THREE.Vector3(0, 0, 1),
        vLong: 0, vLat: 0, Fx: 0, Fy: 0, trackDist: 0,
        surfSpeed: 0,
        rutOff: 0, rutJolt: 0, // old rut depth + berm just ahead of the tire, and how much it changed (cockpit camera)
      };
    });
    this.hull = spec.hull.map(p => new THREE.Vector3(...p).sub(this.cg));
    // drivetrain
    this.rpm = spec.idleRpm;
    this.engW = spec.idleRpm * Math.PI / 30;
    this.gear = 1;          // 1..3, -1 reverse, 0 neutral
    this.shiftTimer = 0;
    this.axleOmega = 0;     // rear spool
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false, shiftUp: false, shiftDown: false };
    this.autoTrans = true;
    this.wheelieControl = true;
    this.steerAssist = true;
    this.arb = spec.arb ? [...spec.arb] : [9000, 14000]; // anti-roll bar rates front/rear (N/m); a model's spec may retune them
    this.steerAngle = 0;
    this.gravity = G;       // m/s^2, adjustable in the menu
    this.grip = 1;          // sand grip multiplier, adjustable in the menu
    this.softness = 1;      // how soft the sand is (sinkage), adjustable in the menu
    this.tracks = tracksFor(terrain); // ruts every car leaves behind (shared)
    this.leaveTracks = true;
    this.dt = 1 / 1000;
    this.acc = 0;
    this.engineTorqueOut = 0;
    this.time = 0;
    this.hullContact = 0;
  }

  reset(x, z, yaw) {
    const h = this.terrain.height(x, z);
    this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    // align with ground normal
    const n = this.terrain.normal(x, z, new THREE.Vector3());
    const align = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    this.quat.premultiply(align);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    this.pos.set(x, h, z).addScaledVector(up, this.cg.y + 0.05);
    this.vel.set(0, 0, 0); this.angVelB.set(0, 0, 0);
    this.axleOmega = 0; this.gear = 1; this.engW = this.spec.idleRpm * Math.PI / 30;
    for (const w of this.wheels) { w.omega = 0; w.comp = w.sag; w.digSink = 0; w.sink = 0; w.staticSink = 0; }
  }

  bodyToWorld(v, out) { return out.copy(v).applyQuaternion(this.quat).add(this.pos); }

  pointVel(pw, out) {
    // v + w x r
    const wW = _v3.copy(this.angVelB).applyQuaternion(this.quat);
    const r = _v2.copy(pw).sub(this.pos);
    return out.crossVectors(wW, r).add(this.vel);
  }

  addForceAt(F, pw) {
    this.force.add(F);
    const r = _ra.copy(pw).sub(this.pos);
    this.torqueW.add(_rb.crossVectors(r, F));
  }

  get speed() { return this.vel.length(); }
  get forwardSpeed() { return this.vel.dot(_v.set(0, 0, 1).applyQuaternion(this.quat)); }

  update(dt) {
    this.acc += Math.min(dt, 0.05);
    let steps = 0;
    while (this.acc >= this.dt && steps < 60) { this.step(this.dt); this.acc -= this.dt; steps++; }
    if (steps >= 60) this.acc = 0;
  }

  _engineTorque(rpm, throttle) {
    const s = this.spec;
    let thr = throttle;
    if (rpm < s.idleRpm + 60) thr = Math.max(thr, Math.min(0.3, 0.02 + 0.3 * (s.idleRpm + 60 - rpm) / 500));
    if (rpm > s.revLimit) thr = 0;
    const full = lerpCurve(s.torqueCurve, rpm);
    const friction = 25 + 0.018 * rpm + 0.0000035 * rpm * rpm;
    return thr * full - friction * (1 - thr * 0.7);
  }

  step(dt) {
    const s = this.spec, inp = this.input;
    this.time += dt;
    this.force.set(0, -this.gravity * WEIGHT * this.m, 0);
    this.torqueW.set(0, 0, 0);

    const up = _n.set(0, 1, 0).applyQuaternion(this.quat).clone();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat);
    const left = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat);
    const vFwd = this.vel.dot(fwd);

    // ---- steering (speed sensitive, rate limited, Ackermann) ----
    // input steer +1 = turn right. Internally angle > 0 = turn left (toward +X).
    const vAbs = Math.max(Math.abs(vFwd), 1);
    // the lock still narrows with speed (no spin-outs at 80+ mph), but less than before: full lock turns harder
    const steerMax = Math.min(s.maxSteer, s.wheelbase * 44 / (vAbs * vAbs) + 0.07);
    let steerTarget = -inp.steer * steerMax;
    // countersteer assist: steers into a slide like a driver would (toggle with G)
    if (this.steerAssist && Math.abs(vFwd) > 4) {
      const vLatBody = this.vel.dot(_v.set(1, 0, 0).applyQuaternion(this.quat));
      const beta = Math.atan2(vLatBody, Math.abs(vFwd));
      steerTarget += Math.max(-0.35, Math.min(0.35, beta * 0.8)) * Math.sign(vFwd);
    }
    const rate = 5.5 * dt;                // rad/s at the wheels: centre to full lock in ~0.1 s
    this.steerAngle += Math.max(-rate, Math.min(rate, steerTarget - this.steerAngle));
    const sa = this.steerAngle;
    if (Math.abs(sa) > 1e-4) {
      const R = s.wheelbase / Math.tan(Math.abs(sa));
      const inner = Math.atan(s.wheelbase / (R - 1.02)), outer = Math.atan(s.wheelbase / (R + 1.02));
      if (sa > 0) { this.wheels[0].steer = inner; this.wheels[1].steer = outer; }
      else { this.wheels[0].steer = -outer; this.wheels[1].steer = -inner; }
    } else { this.wheels[0].steer = 0; this.wheels[1].steer = 0; }

    // ---- gearbox ----
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    const rpm = this.engW * 30 / Math.PI;
    this.rpm = rpm;
    if (this.autoTrans) {
      // Q / E in automatic: a paddle shift that holds the chosen gear for a few seconds, then the
      // automatic takes over again (never neutral, and it still upshifts at the rev limiter)
      if (this.holdT > 0) this.holdT -= dt;
      if ((inp.shiftUp || inp.shiftDown) && this.gear >= 1) {
        this.gear = Math.min(3, Math.max(1, this.gear + (inp.shiftUp ? 1 : -1)));
        this.shiftTimer = s.shiftTime; this.holdT = 3;
      }
      inp.shiftUp = inp.shiftDown = false;
      if (this.holdT > 0 && this.gear < 3 && rpm > s.revLimit - 100 && this.shiftTimer <= 0) { this.gear++; this.shiftTimer = s.shiftTime; this.holdT = 0; }
      if (this.gear >= 1 && this.shiftTimer <= 0 && !(this.holdT > 0)) {
        // shift on (mostly) ground speed so a wheelspin launch up a dune stays in 1st
        const groundW = Math.abs(vFwd) / this.wheels[2].r * 1.6 + 5;
        const axleRpm = Math.min(this.axleOmega, groundW) * 30 / Math.PI * s.finalDrive;
        if (this.gear < 3 && rpm > s.shiftUp && axleRpm * s.gears[this.gear - 1] > 0.78 * rpm) { this.gear++; this.shiftTimer = s.shiftTime; }
        else if (this.gear > 1 && axleRpm * s.gears[this.gear - 2] < s.shiftDown + inp.throttle * 2600 && axleRpm * s.gears[this.gear - 2] < 6400) { this.gear--; this.shiftTimer = s.shiftTime; }
      }
      // reverse: hold brake when (almost) stopped
      if (this.gear >= 1 && inp.brake > 0.5 && inp.throttle < 0.05 && Math.abs(vFwd) < 1.0 && this._revHold === undefined) this._revHold = 0;
      if (this._revHold !== undefined) {
        if (inp.brake > 0.5 && Math.abs(vFwd) < 1.0) { this._revHold += dt; if (this._revHold > 0.35 && this.gear >= 1) { this.gear = -1; } }
        else if (this.gear >= 1) this._revHold = undefined;
      }
      if (this.gear === -1 && inp.throttle > 0.1 && vFwd > -0.6) { this.gear = 1; this._revHold = undefined; }
    } else {
      if (inp.shiftUp) { if (this.gear === -1) this.gear = 0; else if (this.gear < 3) { this.gear++; this.shiftTimer = s.shiftTime; } inp.shiftUp = false; }
      // below 1st: neutral, then reverse, only when (almost) stopped
      const slow = Math.abs(vFwd) < 1.5;
      if (inp.shiftDown) { if (this.gear > 1) { this.gear--; this.shiftTimer = s.shiftTime; } else if (slow && this.gear === 1) this.gear = 0; else if (slow && this.gear === 0) this.gear = -1; inp.shiftDown = false; }
    }
    // in reverse the brake pedal acts as throttle (arcade convenience)
    let throttle = inp.throttle, brake = inp.brake;
    if (this.gear === -1 && this.autoTrans) { throttle = inp.brake * 0.6; brake = inp.throttle; }
    // driver holds the brake when stopped with no throttle (converter creep); firmer for the heavier car
    // and in high gravity, so it still stays parked on a slip face with the Gravity slider up
    if (throttle < 0.05 && Math.abs(vFwd) < 1.0) brake = Math.max(brake, Math.min(1, 0.5 * WEIGHT * Math.max(1, this.gravity / G)));

    // wheelie control: trims throttle only when the front wheels are off the ground and the
    // nose is high RELATIVE TO THE SLOPE (climbing a steep dune is not a wheelie)
    const gn = this.terrain.normal(this.pos.x, this.pos.z, _n2);
    const pitchUp = Math.asin(Math.max(-1, Math.min(1, fwd.dot(gn))));
    const frontsUp = !this.wheels[0].onGround && !this.wheels[1].onGround;
    if (this.wheelieControl && this.gear >= 1 && frontsUp) {
      // anticipate with pitch rate so the nose hovers instead of looping
      const pitchRate = -this.angVelB.x;
      const p = pitchUp + 0.15 * pitchRate;
      // allowed wheelie height shrinks with speed so the fronts come back down to steer
      const lim = 0.07 + 0.20 / (1 + Math.max(0, vFwd - 6) / 10);
      if (p > lim) throttle *= Math.max(0.2, 1 - (p - lim) / 0.14);
    }
    // steering priority: under hard acceleration the weight comes off the front tires and
    // they can't steer. When you steer, trim power just enough to keep weight on the fronts.
    {
      const fzF = (this.wheels[0].onGround ? this.wheels[0].Fz : 0) + (this.wheels[1].onGround ? this.wheels[1].Fz : 0);
      this._fzF = this._fzF === undefined ? fzF : this._fzF + (fzF - this._fzF) * Math.min(1, dt * 25);
      const steerAmt = Math.abs(inp.steer);
      if (this.wheelieControl && this.gear >= 1 && steerAmt > 0.1 && vFwd > 4) {
        const staticF = (this.wheels[0].k * this.wheels[0].sag + this.wheels[1].k * this.wheels[1].sag) * this.gravity / G;
        const want = staticF * (0.3 + 0.4 * Math.min(1, steerAmt));
        if (this._fzF < want) throttle *= Math.max(0.05, this._fzF / want);
      }
    }
    this.throttleEff = throttle;

    // ---- torque converter ----
    const ratio = this.gear === -1 ? -s.reverse * s.finalDrive : this.gear === 0 ? 0 : s.gears[this.gear - 1] * s.finalDrive;
    const turbW = this.axleOmega * ratio;
    let Timp = 0, Tturb = 0;
    if (ratio !== 0) {
      const ew = Math.max(this.engW, 1);
      const sr = turbW / ew;
      const base = Math.pow(ew * 30 / Math.PI / s.converterK, 2);
      if (sr < 0.85) {
        Timp = base;
        Tturb = Timp * (2.1 - 1.1 * Math.max(sr, 0) / 0.85);
      } else if (sr < 1) {
        Timp = base * (1 - sr) / 0.15; Tturb = Timp;
      } else {
        const tb = Math.pow(turbW * 30 / Math.PI / s.converterK, 2);
        Timp = -tb * Math.min((sr - 1) / 0.15, 3); Tturb = Timp;
      }
      if (this.shiftTimer > 0) { Tturb *= 0.35; Timp *= 0.35; }
    }
    const Teng = this._engineTorque(rpm, throttle);
    this.engineTorqueOut = Teng;
    this.engW += (Teng - Timp) / s.engineInertia * dt;
    if (this.engW < 300 * Math.PI / 30) this.engW = 300 * Math.PI / 30;
    const Taxle = Tturb * ratio * 0.92;

    // ---- wheels ----
    let rearFx = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const topW = this.bodyToWorld(w.top, new THREE.Vector3());
      const down = up.clone().negate();
      // solve wheel centre position along suspension axis touching the ground
      let t = w.travel - w.comp; // current extension
      let hit = false;
      const ground = this.terrain, TR = this.tracks;
      // wheel heading (needed up front to read ruts along the tire's footprint)
      const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
      const wf = _v.copy(fwd).multiplyScalar(cs).addScaledVector(left, sn);
      w.fwdW.copy(wf);
      const hl = Math.hypot(wf.x, wf.z) || 1, hfx = wf.x / hl, hfz = wf.z / hl;
      let cx, cz, gs, nrm = w.normal, gdx = 0, gdz = 0, rutSurf = 0;
      for (let it = 0; it < 2; it++) {
        cx = topW.x + down.x * t; cz = topW.z + down.z * t;
        gs = ground.sample(cx, cz);
        // old ruts and berms: the tire rests on the highest point of its round
        // footprint, so it bridges short holes and climbs out of them smoothly
        rutSurf = -1e9;
        for (let k = -2; k <= 2; k++) {
          const d = k * 0.15;
          const v = TR.surf(cx + hfx * d, cz + hfz * d) - (w.r - Math.sqrt(w.r * w.r - d * d));
          if (v > rutSurf) rutSurf = v;
        }
        // rut walls and berms tilt the contact normal sideways: tires follow ruts
        const side = (TR.surf(cx - hfz * 0.12, cz + hfx * 0.12) - TR.surf(cx + hfz * 0.12, cz - hfx * 0.12)) / 0.24 * 0.6;
        gdx = gs.dx + side * -hfz; gdz = gs.dz + side * hfx;
        const gy = gs.h + (rutSurf >= 0 ? rutSurf - w.sink : Math.min(-w.sink, rutSurf));
        nrm.set(-gdx, 1, -gdz).normalize();
        // (top + t*down - P) . n = r
        const dn = down.dot(nrm);
        const apn = (topW.x - cx) * nrm.x + (topW.y - gy) * nrm.y + (topW.z - cz) * nrm.z;
        // wheel lying nearly flat against the slope (car on its side): the hull handles it
        if (dn > -0.45) { t = w.travel + 1; break; }
        t = (w.r - apn) / dn;
      }
      const slopeTan = gs ? Math.hypot(gs.dx, gs.dz) : 0;
      let comp = w.travel - t;
      if (comp > 0) hit = true;
      const compClamped = Math.max(0, Math.min(comp, w.travel));
      const prevComp = w.comp;
      w.compVel = (compClamped - prevComp) / dt;
      w.comp = hit ? compClamped : Math.max(0, w.comp - 3.0 * dt); // droop under gravity when airborne
      if (!hit) w.compVel = 0;
      w.onGround = hit;
      const hub = w.hubW.copy(topW).addScaledVector(down, w.travel - w.comp);

      if (!hit) {
        w.Fz = 0; w.Fx = 0; w.Fy = 0;
        w.staticSink *= Math.max(0, 1 - dt * 4); w.digSink *= Math.max(0, 1 - dt * 2);
        w.sink = w.staticSink + w.digSink;
        const brakeT = (w.front ? s.brakeFront : s.brakeRear) * brake + (inp.handbrake && !w.front ? 4000 : 0);
        if (w.front) {
          w.omega -= Math.sign(w.omega) * Math.min(Math.abs(w.omega), (brakeT + 5) / w.inertia * dt);
        }
        w.contact.copy(hub).addScaledVector(down, w.r);
        continue;
      }
      // suspension force (progressive spring, position-sensitive bypass damping)
      const x = w.comp / w.travel;
      let Fs = w.k * w.comp * (1 + 1.2 * x * x * x);
      if (x > 0.9) Fs += 350000 * (w.comp - 0.9 * w.travel);
      const bypass = 1 + 3.5 * Math.pow(x, 4);
      Fs += (w.compVel > 0 ? w.cBump : w.cReb) * w.compVel * bypass;
      const mate = this.wheels[i ^ 1];
      Fs += (w.front ? this.arb[0] : this.arb[1]) * (w.comp - mate.comp);
      // hydraulic bump stop: extra bump damping over the last half of the travel soaks up landings
      if (x > 0.5 && w.compVel > 0) Fs += 6 * w.cBump * w.compVel * (x - 0.5) / 0.5;
      if (comp > w.travel) Fs += 600000 * Math.min(comp - w.travel, 0.08) + 8000 * Math.max(w.compVel, 0); // bottomed
      // a tire in sand can't push harder than this before the sand gives way
      Fs = Math.min(Math.max(0, Fs), 100000);
      const contact = w.contact.copy(hub).addScaledVector(nrm, -w.r);
      const Fz = Fs;
      w.Fz = Fz;
      this.addForceAt(nrm.clone().multiplyScalar(Fs), contact);

      // contact frame
      const cf = wf.clone().addScaledVector(nrm, -wf.dot(nrm)).normalize();
      const cside = new THREE.Vector3().crossVectors(nrm, cf); // points left
      const vc = this.pointVel(contact, new THREE.Vector3());
      const vLong = vc.dot(cf), vLat = vc.dot(cside);
      w.vLong = vLong; w.vLat = vLat;

      // sinkage: static (load) + digging (wheelspin)
      // soft sand: tires sink under load, and sink deeper when slow (they plane on top at speed)
      const slow = 1 + 1.3 * Math.exp(-Math.abs(vLong) / 4);
      // past ~30 deg the sand is near its angle of repose (slip faces): it gives way
      // under the tires, so they sink deeper and grip less
      const repose = smooth(0.58, 0.8, slopeTan);
      // dune faces are loose wind-blown sand: softer than the packed flats
      const hill = smooth(0.12, 0.5, slopeTan);
      w.hill = hill;
      const sinkTarget = (w.front ? 0.06 : 0.05) * this.softness * slow * (1 + 0.55 * hill + 0.6 * repose) * Math.min(Math.pow(Math.max(Fz, 0) / ((w.front ? 1600 : 4200) * WEIGHT), 0.6), 1.8);
      w.staticSink += (sinkTarget - w.staticSink) * Math.min(1, dt * 6);
      const staticSink = w.staticSink;
      const spinSlip = Math.abs(w.omega * w.r - vLong);
      if (!w.front && spinSlip > 2.5) w.digSink = Math.min(0.20 + 0.08 * hill, w.digSink + 0.012 * (1 + 0.5 * hill) * (spinSlip - 2.5) * dt * Math.min(Fz / 4000, 1.5));
      w.digSink = Math.max(0, w.digSink - (0.05 + 0.35 * Math.min(Math.abs(vLong) / 6, 1)) * dt);
      w.sink = staticSink + w.digSink;

      // sand ahead of the tire: an old rut there is packed, so it rolls easier
      const dirS = vLong >= 0 ? 1 : -1, lead = Math.sqrt(2 * w.r * Math.max(w.sink, 0.02)) + 0.25;
      const ahead = this.tracks.read(contact.x + hfx * lead * dirS, contact.z + hfz * lead * dirS, _rut).depth;
      // old tire impressions under the front of the tread (rut floor + berms; a front tire's own print is behind it):
      // the cockpit camera reads how much they changed to jolt the driver's head when crossing ruts
      const rutRaw = ahead + _rut.berm;
      w.rutJolt += Math.abs(rutRaw - w.rutOff); w.rutOff = rutRaw;
      const freshSink = Math.max(0, w.sink - ahead * 0.85);
      // press this tire's rut into the shared track map
      w._stampT = (w._stampT || 0) + dt;
      if (this.leaveTracks && w._stampT >= 0.012) {
        w._stampT = 0;
        const halfL = Math.max(0.1, Math.sqrt(2 * w.r * Math.max(w.sink, 0.01)));
        this.tracks.stamp(contact.x, contact.z, hfx, hfz, w.w * 0.46, halfL, w.sink, 0.01 + 0.45 * w.sink);
      }

      // slip
      const vDen = Math.max(Math.abs(vLong), 1.5);
      const kappa = (w.omega * w.r - vLong) / vDen;
      const tanA = -vLat / Math.max(Math.abs(vLong), 2.0);
      w.slipRatio = kappa; w.slipAngle = Math.atan(tanA);

      // tire characteristics on sand
      let muX, muY, kPeak, aPeak, Bx, Cx, By, Cy;
      // Lateral: tires sitting in the sand push a wall of sand sideways, so side grip
      // grows with sinkage and barely falls off once sliding (low Cy = flat top).
      const plow = 1 + Math.min(0.15, w.sink * 2);
      // (ribbed fronts bite harder sideways at low speed: with only ~31 % of the weight on them the spool rear
      // pushed the car wide in tight turns; the extra grip fades out by ~50 mph so fast turns stay stable)
      if (w.front) { muX = 0.55; muY = (1.0 + 0.35 * (1 - smooth(8, 22, Math.abs(vFwd)))) * plow; kPeak = 0.12; aPeak = 0.16; Bx = 9; Cx = 1.5; By = 7.5; Cy = 1.15; }
      else {
        const bite = 1 + 1.4 * (w.digSink / 0.20);
        muX = Math.min(1.12 * bite, 1.45); muY = 0.98 * plow; kPeak = 0.28; aPeak = 0.12; Bx = 4.2; Cx = 1.35; By = 9.5; Cy = 1.12;
      }
      // load sensitivity: a heavily loaded outside tire just pushes deeper and plows,
      // it can't make proportionally more side force (keeps the car from tripping over)
      const fz0 = (w.front ? 1700 : 4000) * WEIGHT;
      muY /= 1 + 0.45 * Math.max(0, Fz / fz0 - 1);
      muY *= this.grip; muX *= Math.min(1.25, 0.6 + 0.4 * this.grip);
      muX *= 1 - 0.3 * repose; muY *= 1 - 0.35 * repose;
      const sx = kappa / kPeak, sy = tanA / aPeak;
      const sl = Math.hypot(sx, sy);
      let Fx = 0, Fy = 0;
      if (w.front) {
        if (sl > 1e-6) {
          Fx = muX * Fz * mf(sl * kPeak, Bx, Cx, 0) * (sx / sl);
          Fy = muY * Fz * mf(sl * aPeak, By, Cy, 0) * (sy / sl);
        }
      } else {
        // Paddles: drive comes from the paddles scooping sand, but the tire is also
        // sitting in a trench it dug, so spinning barely frees it sideways
        // (unlike rubber on pavement). Only a weak friction-circle coupling.
        Fx = muX * Fz * mf(kappa, Bx, Cx, 0);
        const keep = 1 / (1 + 0.12 * Math.max(0, Math.abs(sx) - 1)) + Math.min(0.35, w.digSink * 2.5);
        Fy = muY * Fz * mf(tanA, By, Cy, 0) * Math.min(1, keep);
      }
      // reduced lateral grip while digging (paddles slide sideways when spinning)
      w.Fx = Fx; w.Fy = Fy;
      const Ft = cf.clone().multiplyScalar(Fx).addScaledVector(cside, Fy);
      this.addForceAt(Ft, contact);

      // rolling resistance / bulldozing in soft sand
      const crr = (w.front ? 0.055 : 0.045) + 0.6 * freshSink;
      const Trr = crr * Fz * w.r;

      if (w.front) {
        const brakeT = s.brakeFront * brake;
        let dw = (-Fx * w.r) / w.inertia * dt;
        w.omega += dw;
        const resist = (brakeT + Trr) / w.inertia * dt;
        w.omega -= Math.sign(w.omega) * Math.min(Math.abs(w.omega), resist);
      } else {
        rearFx += Fx;
        w._Trr = Trr;
      }
      w.surfSpeed = w.omega * w.r - vLong;
    }

    // rear spool (both rear wheels share omega)
    {
      const RL = this.wheels[2], RR = this.wheels[3];
      const Iax = RL.inertia + RR.inertia + 1.5;
      const r = RL.r;
      const Fx = (RL.onGround ? RL.Fx : 0) + (RR.onGround ? RR.Fx : 0);
      this.axleOmega += (Taxle - Fx * r) / Iax * dt;
      const brakeT = s.brakeRear * brake + (inp.handbrake ? 6000 : 0) + (RL.onGround ? RL._Trr : 0) + (RR.onGround ? RR._Trr : 0) + 2;
      const dec = brakeT / Iax * dt;
      this.axleOmega -= Math.sign(this.axleOmega) * Math.min(Math.abs(this.axleOmega), dec);
      RL.omega = RR.omega = this.axleOmega;
    }
    for (const w of this.wheels) {
      w.angle += w.omega * dt;
      if (w.angle > 1e4) w.angle -= Math.PI * 2 * 1000;
      if (w.onGround) w.trackDist += Math.abs(w.vLong) * dt;
    }

    // ---- hull contacts (rollovers, bottoming out) ----
    this.hullContact = 0;
    for (const hp of this.hull) {
      const pw = this.bodyToWorld(hp, new THREE.Vector3());
      const gs = this.terrain.sample(pw.x, pw.z);
      const pen = gs.h - pw.y;
      if (pen > 0) {
        const nrm = new THREE.Vector3(-gs.dx, 1, -gs.dz).normalize();
        const depth = pen * nrm.y;
        const vp = this.pointVel(pw, new THREE.Vector3());
        const vn = vp.dot(nrm);
        let Fn = 250000 * depth - 18000 * vn; // damped both ways: the sand doesn't bounce the chassis back up
        Fn = Math.max(Fn, 0);
        const vt = vp.clone().addScaledVector(nrm, -vn);
        const vtl = vt.length();
        const F = nrm.clone().multiplyScalar(Fn);
        if (vtl > 1e-3) F.addScaledVector(vt, -Math.min(0.55 * Fn, 3000 * vtl) / vtl);
        this.addForceAt(F, pw);
        this.hullContact = Math.max(this.hullContact, depth);
      }
    }

    // ---- aero drag ----
    const v2 = this.vel.lengthSq();
    if (v2 > 1e-6) this.force.addScaledVector(this.vel, -0.5 * 1.15 * s.cdA * Math.sqrt(v2));
    // downforce grows with the square of the forward speed: planted when fast, free to crawl when slow
    const vf = Math.max(0, vFwd);
    this.force.addScaledVector(up, -0.5 * 1.15 * CL_A * vf * vf);

    // ---- integrate ----
    this.vel.addScaledVector(this.force, dt / this.m);
    this.pos.addScaledVector(this.vel, dt);
    const qi = _q.copy(this.quat).invert();
    const tauB = this.torqueW.clone().applyQuaternion(qi);
    const w = this.angVelB, I = this.I;
    // Euler's equations: I w' = tau - w x (I w)
    const Iw = new THREE.Vector3(I.x * w.x, I.y * w.y, I.z * w.z);
    const gyro = new THREE.Vector3().crossVectors(w, Iw);
    // aero damping of pitch and roll (not yaw, so slides stay free)
    const ad = AERO_DAMP * (Math.sqrt(v2) + 5);
    tauB.x -= ad * I.x * w.x; tauB.z -= ad * I.z * w.z;
    w.x += (tauB.x - gyro.x) / I.x * dt;
    w.y += (tauB.y - gyro.y) / I.y * dt;
    w.z += (tauB.z - gyro.z) / I.z * dt;
    const wW = w.clone().applyQuaternion(this.quat);
    const dq = new THREE.Quaternion(wW.x * dt * 0.5, wW.y * dt * 0.5, wW.z * dt * 0.5, 0).multiply(this.quat);
    this.quat.x += dq.x; this.quat.y += dq.y; this.quat.z += dq.z; this.quat.w += dq.w;
    this.quat.normalize();
  }

  // Snapshot for rendering / networking
  getState() {
    return {
      p: [this.pos.x, this.pos.y, this.pos.z],
      q: [this.quat.x, this.quat.y, this.quat.z, this.quat.w],
      v: [this.vel.x, this.vel.y, this.vel.z],
      w: this.wheels.map(w => [w.comp, w.angle % (Math.PI * 2), w.steer, w.sink, w.onGround ? 1 : 0, w.surfSpeed, w.slipRatio, w.vLong]),
      rpm: this.rpm, gear: this.gear, thr: this.throttleEff || 0,
    };
  }
}
