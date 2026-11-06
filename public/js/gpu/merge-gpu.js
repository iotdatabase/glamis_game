// Fewer draw calls for the WebGPU renderer (its CPU cost per draw is higher than WebGL's): the parts of a
// car that never move relative to its body are merged into one mesh per material. The moving parts (wheels,
// suspension links, shocks, steering wheel, uprights) are found by posing the car twice and seeing what moved.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const sig = (g) => Object.keys(g.attributes).sort().map(k => { const a = g.attributes[k]; return `${k}:${a.itemSize}:${a.normalized ? 1 : 0}:${a.array.constructor.name}`; }).join('|') + (g.morphAttributes && Object.keys(g.morphAttributes).length ? '|morph' : '');

// model: a GltfSandrail; exclude: meshes that must stay separate (live mirrors, dash screens)
export function mergeStaticParts(model, exclude = new Set()) {
  const root = model.model;
  if (!root || model._merged) return 0;
  model._merged = true;
  const before = new Map();
  root.traverse((o) => before.set(o, o.matrix.clone()));
  const moved = new Set();
  const pose = (comp, steer) => {
    model.update([0, 1, 2, 3].map(() => [comp, 1.3, steer, 0.05, 1, 3, 0, 3]), steer);
    root.traverse((o) => { o.updateMatrix(); if (!o.matrix.equals(before.get(o))) moved.add(o); });
  };
  pose(0.25, 0.45); pose(-0.2, -0.45);
  model.update(null);
  root.updateMatrixWorld(true);
  const animated = (o) => { for (let p = o; p && p !== root; p = p.parent) if (moved.has(p)) return true; return false; };
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map();
  root.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || exclude.has(o) || Array.isArray(o.material) || !o.visible || o.layers.mask !== 1 || animated(o)) return;
    const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}|${o.renderOrder}|${sig(o.geometry)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  });
  let removed = 0;
  for (const meshes of groups.values()) {
    if (meshes.length < 2) continue;
    const indexed = meshes.every(m => m.geometry.index);
    const geos = meshes.map((m) => {
      let g = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
      if (!indexed && g.index) g = g.toNonIndexed();
      g.morphAttributes = {};
      return g;
    });
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const src = meshes[0];
    const mesh = new THREE.Mesh(merged, src.material);
    mesh.castShadow = src.castShadow; mesh.receiveShadow = src.receiveShadow; mesh.renderOrder = src.renderOrder;
    mesh.name = 'merged:' + (src.material.name || '');
    root.add(mesh);
    for (const m of meshes) m.parent.remove(m);
    removed += meshes.length - 1;
  }
  // shadows: shadows ignore materials, so the casting parts are merged into shadow-only meshes, one for the
  // static body and one per moving part (attached to it, so it moves along), on a layer the main camera does
  // not render but the sun's shadow camera does
  const owner = (o) => { for (let p = o.parent; p && p !== root; p = p.parent) if (moved.has(p)) return p; return root; };
  const byOwner = new Map();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.castShadow || o.isSkinnedMesh || exclude.has(o) || Array.isArray(o.material) || !o.visible) return;
    if (o.material.alphaTest > 0 || o.material.transparent || o.material.alphaMap) return;   // cut-outs keep their own shadow
    const ow = owner(o);
    if (!byOwner.has(ow)) byOwner.set(ow, []);
    byOwner.get(ow).push(o);
  });
  const shadowMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  model.shadowProxies = [];
  for (const [ow, casters] of byOwner) {
    if (casters.length < 2) continue;
    const toLocal = new THREE.Matrix4().copy(ow.matrixWorld).invert();
    const geos = casters.map((m) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', m.geometry.attributes.position.clone());
      if (m.geometry.index) g.setIndex(m.geometry.index.clone());
      return g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toLocal, m.matrixWorld));
    });
    const allIdx = geos.every(g => g.index);
    const shadowGeo = mergeGeometries(allIdx ? geos : geos.map(g => (g.index ? g.toNonIndexed() : g)), false);
    if (!shadowGeo) continue;
    const proxy = new THREE.Mesh(shadowGeo, shadowMat);
    proxy.name = 'shadowProxy'; proxy.castShadow = true; proxy.receiveShadow = false;
    proxy.layers.set(SHADOW_LAYER);
    ow.add(proxy);
    for (const m of casters) m.castShadow = false;
    model.shadowProxies.push(proxy);
  }
  return removed;
}
export const SHADOW_LAYER = 7;
