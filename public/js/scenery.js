// Life on the dunes: creosote and dry scrub on the flats between the dunes (streamed around the
// player, instanced), and camps at Glamis Flats and Osborne Overlook with RVs, shade canopies,
// whip flags, porch lights that come on at night and parked sandrails.
// Scenery is for looks only: the cars drive through it.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PLACES, placeXZ } from './places.js';

const hash = (x, z, s) => { const v = Math.sin(x * 127.1 + z * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };

function bushGeometry(seed, parts, squash) {
  const gs = [];
  for (let i = 0; i < parts; i++) {
    const g = new THREE.IcosahedronGeometry(0.5, 1);
    const a = hash(seed, i, 1) * Math.PI * 2, r = 0.35 * hash(seed, i, 2);
    g.scale(0.7 + 0.5 * hash(seed, i, 3), squash * (0.6 + 0.6 * hash(seed, i, 4)), 0.7 + 0.5 * hash(seed, i, 5));
    g.translate(Math.cos(a) * r, 0.25 + 0.25 * hash(seed, i, 6), Math.sin(a) * r);
    gs.push(g);
  }
  const m = mergeGeometries(gs);
  // lumpy, twiggy silhouette
  const p = m.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 0.7 + 0.6 * hash(x * 9, z * 9, y * 9);
    p.setXYZ(i, x * k, Math.max(0, y * k), z * k);
  }
  m.computeVertexNormals();
  return m;
}

export class Scenery {
  // opts: { budget (max bushes), radius (m), shadows }
  constructor(scene, terrain, opts) {
    this.scene = scene; this.terrain = terrain; this.opts = opts;
    this.group = new THREE.Group(); scene.add(this.group);
    this.center = null; this.enabled = true;
    // two bush kinds: green creosote and pale dry scrub
    const kinds = [
      { geo: bushGeometry(1, 9, 0.9), mat: new THREE.MeshStandardMaterial({ color: 0x3f3f22, roughness: 1 }), share: 0.6, size: [0.8, 1.7] },
      { geo: bushGeometry(2, 6, 0.6), mat: new THREE.MeshStandardMaterial({ color: 0x8a7650, roughness: 1 }), share: 0.4, size: [0.4, 0.9] },
    ];
    this.bushes = kinds.map(k => {
      const n = Math.ceil(opts.budget * k.share);
      const mesh = new THREE.InstancedMesh(k.geo, k.mat, n);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0; mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = false;
      this.group.add(mesh);
      return { mesh, n, size: k.size };
    });
    this.camps = [];
    this.flags = [];
    this.lamps = [];
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3(); this._n = new THREE.Vector3(); this._up = new THREE.Vector3(0, 1, 0);
  }

  slope(x, z) {
    const t = this.terrain, e = 2;
    const dx = (t.height(x + e, z) - t.height(x - e, z)) / (2 * e), dz = (t.height(x, z + e) - t.height(x, z - e)) / (2 * e);
    return Math.hypot(dx, dz);
  }

  // ---------- bushes, re-dealt around the player when they have moved far enough ----------
  updateBushes(x, z) {
    const R = this.opts.radius, C = 40, t = this.terrain;
    const counts = this.bushes.map(() => 0);
    for (let cx = Math.floor((x - R) / C); cx <= Math.floor((x + R) / C); cx++) {
      for (let cz = Math.floor((z - R) / C); cz <= Math.floor((z + R) / C); cz++) {
        for (let i = 0; i < 6; i++) {
          const px = (cx + hash(cx, cz, i * 2)) * C, pz = (cz + hash(cx, cz, i * 2 + 1)) * C;
          const d2 = (px - x) ** 2 + (pz - z) ** 2;
          if (d2 > R * R) continue;
          const h = t.height(px, pz);
          // flats between the dunes: gentle slope and lower than the sand around it
          if (this.slope(px, pz) > 0.16) continue;
          const around = (t.height(px + 22, pz) + t.height(px - 22, pz) + t.height(px, pz + 22) + t.height(px, pz - 22)) * 0.25;
          if (h > around - 0.15) continue;
          const k = hash(cx, cz, i + 40) < 0.6 ? 0 : 1, b = this.bushes[k];
          if (counts[k] >= b.n) continue;
          const s = b.size[0] + (b.size[1] - b.size[0]) * hash(cx, cz, i + 50);
          this._q.setFromAxisAngle(this._up, hash(cx, cz, i + 60) * Math.PI * 2);
          this._s.set(s * (0.8 + 0.4 * hash(cx, cz, i + 70)), s, s * (0.8 + 0.4 * hash(cx, cz, i + 80)));
          this._p.set(px, h - 0.08 * s, pz);
          b.mesh.setMatrixAt(counts[k]++, this._m.compose(this._p, this._q, this._s));
        }
      }
    }
    this.bushes.forEach((b, k) => { b.mesh.count = counts[k]; b.mesh.instanceMatrix.needsUpdate = true; });
  }

  // ---------- camps ----------
  buildCamps(meta, parkedModel) {
    const t = this.terrain;
    const white = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.5, metalness: 0.1 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1a2128, roughness: 0.15, metalness: 0.6 });
    const tire = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.9 });
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffe2b0, emissive: 0xffc070, emissiveIntensity: 0 });
    const stripes = [0x8a1f1f, 0x1f4f8a, 0x2b2b2b, 0x6b4a1f, 0x1f6b4a];
    const canopyCols = [0xd23b2b, 0x2b62d2, 0xe0a020, 0x2fa04a, 0x8a2fd0];
    const flagCols = [0xff5a10, 0xffd000, 0x18a8ff, 0xff2a6a, 0x30e060];
    const rvBody = new THREE.BoxGeometry(2.5, 3.0, 9.5); rvBody.translate(0, 2.0, 0);
    const rvStripe = new THREE.BoxGeometry(2.52, 0.35, 9.0); rvStripe.translate(0, 1.6, 0);
    const rvWin = new THREE.BoxGeometry(2.54, 0.8, 1.6);
    const rvWheel = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 14); rvWheel.rotateZ(Math.PI / 2);
    const pole = new THREE.CylinderGeometry(0.04, 0.04, 2.6, 6); pole.translate(0, 1.3, 0);
    const roof = new THREE.BoxGeometry(3.2, 0.12, 3.2);
    const whip = new THREE.CylinderGeometry(0.015, 0.02, 4.5, 5); whip.translate(0, 2.25, 0);
    const flagGeo = new THREE.PlaneGeometry(0.9, 0.55); flagGeo.translate(0.45, 0, 0);
    const lampGeo = new THREE.SphereGeometry(0.09, 8, 6);
    const place = (obj, x, z, yaw) => {
      const h = t.height(x, z); t.normal(x, z, this._n);
      obj.position.set(x, h, z);
      obj.quaternion.setFromUnitVectors(this._up, this._n).multiply(this._q.setFromAxisAngle(this._up, yaw));
      return obj;
    };
    const sites = PLACES.filter(p => p.id === 'glamisflats' || p.id === 'osborne');
    let ci = 0;
    for (const site of sites) {
      const c = placeXZ(site, meta);
      const root = new THREE.Group(); this.group.add(root);
      const camp = { root, x: c.x, z: c.z };
      // camps on the flattest spots in a ring around the landmark
      const spots = [];
      for (let i = 0; i < 90 && spots.length < 7; i++) {
        const a = i * 2.39996, r = 45 + (i % 9) * 14;
        const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
        if (this.slope(x, z) > 0.12 || spots.some(s => Math.hypot(s.x - x, s.z - z) < 28)) continue;
        spots.push({ x, z, yaw: Math.atan2(c.x - x, c.z - z) });
      }
      for (const s of spots) {
        const k = ci++;
        const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw), rx = fz, rz = -fx;
        // two RVs side by side, doors facing the middle of the camp
        for (let j = 0; j < 2; j++) {
          const rv = new THREE.Group();
          rv.add(new THREE.Mesh(rvBody, white));
          const st = new THREE.Mesh(rvStripe, new THREE.MeshStandardMaterial({ color: stripes[(k + j) % stripes.length], roughness: 0.5 }));
          rv.add(st);
          for (const wz of [-2.8, 0, 2.8]) { const w = new THREE.Mesh(rvWin, glass); w.position.set(0, 2.55, wz); rv.add(w); }
          for (const wz of [-3.2, -2.2, 2.6]) for (const wx of [-1.15, 1.15]) { const wh = new THREE.Mesh(rvWheel, tire); wh.position.set(wx, 0.42, wz); rv.add(wh); }
          const lamp = new THREE.Mesh(lampGeo, lampMat); lamp.position.set(1.3, 2.9, 1.5); rv.add(lamp);
          rv.traverse(o => { if (o.isMesh) { o.castShadow = !!this.opts.shadows; o.receiveShadow = true; } });
          const off = (j - 0.5) * 7;
          root.add(place(rv, s.x + rx * off - fx * 3, s.z + rz * off - fz * 3, s.yaw + Math.PI / 2 * (j ? 1 : -1) + Math.PI / 2));
        }
        // shade canopy in front
        const can = new THREE.Group();
        const cm = new THREE.MeshStandardMaterial({ color: canopyCols[k % canopyCols.length], roughness: 0.8, side: THREE.DoubleSide });
        for (const [px, pz] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) { const p = new THREE.Mesh(pole, white); p.position.set(px, 0, pz); can.add(p); }
        const rf = new THREE.Mesh(roof, cm); rf.position.y = 2.6; can.add(rf);
        can.traverse(o => { if (o.isMesh) o.castShadow = !!this.opts.shadows; });
        root.add(place(can, s.x + fx * 4, s.z + fz * 4, s.yaw));
        // a whip flag
        const fl = new THREE.Group();
        fl.add(new THREE.Mesh(whip, new THREE.MeshStandardMaterial({ color: 0x222222 })));
        const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: flagCols[k % flagCols.length], roughness: 0.8, side: THREE.DoubleSide }));
        flag.position.y = 4.25; fl.add(flag);
        fl.userData.keep = true;
        root.add(place(fl, s.x + rx * 6 + fx * 6, s.z + rz * 6 + fz * 6, 0));
        this.flags.push({ flag, ph: k * 1.7 });
        this.lamps.push(lampMat);
        // a parked sandrail, when a model is ready
        camp.parked = camp.parked || [];
        if (camp.parked.length < (this.opts.parked ?? 3)) camp.parked.push({ x: s.x - rx * 7 + fx * 5, z: s.z - rz * 7 + fz * 5, yaw: s.yaw + 2.2 + k });
      }
      this.mergeStatic(root);
      this.camps.push(camp);
    }
    this.lampMat = lampMat;
    this.addParked(parkedModel);
  }

  // one draw call per material instead of one per box: bake every static mesh of a camp together
  mergeStatic(root) {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const byMat = new Map(), drop = [];
    for (const child of root.children) {
      if (child.userData.keep) continue;
      child.traverse(o => {
        if (!o.isMesh) return;
        const g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
        const key = o.material.uuid;
        if (!byMat.has(key)) byMat.set(key, { mat: o.material, geos: [], cast: o.castShadow });
        byMat.get(key).geos.push(g.index ? g.toNonIndexed() : g);
      });
      drop.push(child);
    }
    for (const c of drop) root.remove(c);
    for (const { mat, geos, cast } of byMat.values()) {
      const m = new THREE.Mesh(mergeGeometries(geos), mat);
      m.castShadow = cast; m.receiveShadow = true;
      root.add(m);
    }
  }

  // parkedModel(i) -> Object3D or null (a sandrail model); called again as more models arrive
  addParked(parkedModel) {
    if (!parkedModel) return;
    let i = 0;
    for (const camp of this.camps) for (const p of camp.parked || []) {
      const k = i++;
      if (p.obj) continue;
      const o = parkedModel(k);
      if (!o) continue;
      const t = this.terrain;
      o.position.set(p.x, t.height(p.x, p.z), p.z);
      t.normal(p.x, p.z, this._n);
      o.quaternion.setFromUnitVectors(this._up, this._n).multiply(this._q.setFromAxisAngle(this._up, p.yaw));
      o.traverse(m => { if (m.isMesh) m.castShadow = false; });
      camp.root.add(o); p.obj = o;
    }
  }

  setEnabled(on) { this.enabled = on; this.group.visible = on; }

  update(dt, camPos, night) {
    if (!this.enabled) return;
    if (!this.center || Math.hypot(camPos.x - this.center.x, camPos.z - this.center.z) > this.opts.radius * 0.25) {
      this.center = { x: camPos.x, z: camPos.z };
      this.updateBushes(camPos.x, camPos.z);
    }
    for (const c of this.camps) {
      const d = Math.hypot(camPos.x - c.x, camPos.z - c.z);
      c.root.visible = d < 3000;
      for (const p of c.parked || []) if (p.obj) p.obj.visible = d < 900;
    }
    this.time = (this.time || 0) + dt;
    for (const f of this.flags) f.flag.rotation.y = Math.sin(this.time * 3.1 + f.ph) * 0.35 + 0.2;
    if (this.lampMat) this.lampMat.emissiveIntensity = night ? 6 : 0;
  }
}
