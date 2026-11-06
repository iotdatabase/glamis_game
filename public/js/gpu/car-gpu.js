// WebGPU version of the car looks (patchMaterial in gltf-sandrail.js): baked AO on the sky light and
// reflections, separate sky-light (amb) and reflection (env / coat) scaling with desaturation, grazing /
// downward reflection trims, AO on direct light in cavities, the orange tint and daylight lift, and the
// cabin fill lights. The WebGL path patches three's GLSL; here the same steps sit in a lighting model.
import { MeshPhysicalNodeMaterial, PhysicalLightingModel } from 'three/webgpu';
import {
  uniform, attribute, materialColor, materialEmissive, vec3, vec4, float, mix, clamp, smoothstep, max, dot, length,
  normalView, positionViewDirection, reflectVector, normalWorld, positionWorld, select,
} from 'three/tsl';

const PROPS = ['name', 'color', 'map', 'roughness', 'metalness', 'roughnessMap', 'metalnessMap', 'normalMap', 'normalMapType', 'normalScale',
  'emissive', 'emissiveMap', 'emissiveIntensity', 'aoMap', 'aoMapIntensity', 'alphaMap', 'transparent', 'opacity', 'alphaTest', 'side',
  'depthWrite', 'depthTest', 'vertexColors', 'flatShading', 'envMapIntensity', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits',
  'bumpMap', 'bumpScale', 'lightMap', 'lightMapIntensity', 'blending', 'premultipliedAlpha', 'toneMapped', 'visible',
  'clearcoat', 'clearcoatRoughness', 'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap', 'clearcoatNormalScale',
  'sheen', 'sheenColor', 'sheenRoughness', 'sheenColorMap', 'sheenRoughnessMap',
  'specularIntensity', 'specularColor', 'specularIntensityMap', 'specularColorMap', 'ior',
  'transmission', 'transmissionMap', 'thickness', 'attenuationColor', 'attenuationDistance',
  'iridescence', 'iridescenceIOR', 'iridescenceThicknessRange', 'anisotropy', 'anisotropyRotation', 'anisotropyMap'];

const luma = (c) => dot(c, vec3(0.2126, 0.7152, 0.0722));
const desat = (c, s) => mix(vec3(luma(c)), c, s);

class LookLighting extends PhysicalLightingModel {
  constructor(L, ...flags) { super(...flags); this.L = L; }
  direct(args, builder) {
    super.direct({ ...args, lightColor: args.lightColor.mul(this.L.bdir) }, builder);
  }
  indirect(builder) {
    const ctx = builder.context, L = this.L;
    const amb = L.bao.mul(L.amb);
    ctx.irradiance = desat(ctx.irradiance, L.ambSat).mul(amb);
    if (ctx.iblIrradiance) ctx.iblIrradiance = desat(ctx.iblIrradiance, L.ambSat).mul(amb);
    ctx.radiance = desat(ctx.radiance, L.envSat).mul(L.bao.mul(L.spec).mul(L.graze));
    // (the clear coat's sky reflection lives on the lighting model, not in the context)
    if (this.clearcoatRadiance) this.clearcoatRadiance = desat(this.clearcoatRadiance, L.envSat).mul(L.bao.mul(L.coat).mul(L.graze));
    super.indirect(builder);
  }
}

let shared = null;
// CABIN / DAY values are written by cockpit-live.js and setLookDaylight(): their scalars become uniform nodes
function sharedNodes(CABIN, DAY) {
  if (shared) return shared;
  for (const k of ['uCabinDist', 'uCabinDist2']) if (!CABIN[k].isNode) CABIN[k] = uniform(CABIN[k].value);
  if (!DAY.uLookDay.isNode) DAY.uLookDay = uniform(DAY.uLookDay.value);
  shared = {
    cab: [[uniform(CABIN.uCabinPos.value), uniform(CABIN.uCabinCol.value), CABIN.uCabinDist], [uniform(CABIN.uCabinPos2.value), uniform(CABIN.uCabinCol2.value), CABIN.uCabinDist2]],
    day: DAY.uLookDay,
  };
  return shared;
}

function toNodeMaterial(m, S) {
  const nm = new MeshPhysicalNodeMaterial();
  for (const k of PROPS) {
    if (!(k in m) || m[k] === undefined) continue;
    const v = m[k];
    if (v && typeof v.clone === 'function' && !v.isTexture && nm[k] && typeof nm[k].copy === 'function') nm[k].copy(v);
    else nm[k] = v;
  }
  nm.userData = { ...m.userData };
  const u = {};
  for (const [k, v] of Object.entries(m.userData.lookUniforms)) u[k] = uniform(v.value);
  const mc = vec4(materialColor);
  const orange = clamp(mc.r.sub(mc.g.mul(2)).sub(mc.b).div(max(mc.r, 1e-3)), 0, 1).mul(smoothstep(0.02, 0.1, mc.r));
  nm.colorNode = vec4(mc.rgb.mul(mix(vec3(1), u.uTint, orange)), mc.a);
  // baked AO (with a floor for downward-facing surfaces), and how much of it reaches the direct light
  let ao = clamp(attribute('bakedAO', 'float'), 0, 1);
  ao = max(ao, select(normalWorld.y.lessThan(-0.5), u.uAODown, float(0)));
  const bao = mix(float(1), ao, u.uBakedAO);
  const NdotV = clamp(dot(normalView, positionViewDirection), 0, 1);
  const graze = mix(u.uGraze, float(1), smoothstep(u.uGrazeStart, u.uGrazeEnd, NdotV)).mul(mix(float(1), u.uOrangeRefl, orange))
    .mul(mix(float(1), u.uSpecDown, smoothstep(0, -0.35, reflectVector.y)));
  const L = { bao, amb: u.uAmb, ambSat: u.uAmbSat, envSat: u.uEnvSat, spec: u.uSpec, coat: u.uCoat, graze,
    bdir: mix(float(1), smoothstep(0, 0.6, bao), u.uAODirect) };
  nm.setupLightingModel = function () { return new LookLighting(L, this.useClearcoat, this.useSheen, this.useIridescence, this.useAnisotropy, this.useTransmission, this.useDispersion); };
  // cabin fill lights (diffuse only), plus the orange lift by day
  let cabin = vec3(0);
  for (const [[P, C, D], K] of [[S.cab[0], u.uCabinK], [S.cab[1], u.uCabinK2]]) {
    const Lv = P.sub(positionWorld), d = length(Lv), dd = max(d, 0.3);
    const fall = clamp(float(1).sub(dd.div(D).pow(4)), 0, 1);
    const att = float(1).div(max(dd.mul(dd), 0.01)).mul(fall.mul(fall));
    const ndl = max(dot(normalWorld, Lv.div(max(d, 1e-4))), 0);
    cabin = cabin.add(vec3(C).mul(K).mul(att).mul(ndl).mul(select(d.lessThan(D), float(1), float(0))));
  }
  nm.emissiveNode = vec3(materialEmissive).add(mc.rgb.mul(u.uLift.mul(S.day).mul(orange))).add(mc.rgb.mul(1 / Math.PI).mul(cabin));
  return nm;
}

// replace every look-patched material of a car (patchMaterial set userData.lookUniforms) by its node version
export function convertCarLooks(scene, CABIN, DAY) {
  const S = sharedNodes(CABIN, DAY), cache = new Map();
  const conv = (m) => {
    if (!m || !m.userData?.lookUniforms) return m;
    if (!cache.has(m)) cache.set(m, toNodeMaterial(m, S));
    return cache.get(m);
  };
  scene.traverse((o) => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material); });
}
