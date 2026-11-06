// WebGPU side of the CDLOD terrain (terrain-render.js): the same uniforms as TSL nodes, the sand
// material as a node material built from the WGSL in terrain-wgsl.js, and the two GPU bakes
// (DEM gradient texture, long-range sun shadows) as full-screen node passes.
import * as THREE from 'three';
import { MeshPhysicalNodeMaterial, NodeMaterial, QuadMesh } from 'three/webgpu';
import { wgslFn, texture, sampler, uniform, uniformArray, attribute, positionLocal, positionWorld, vec3, vec4, float, int, varying, screenCoordinate, transformNormalToView, Fn } from 'three/tsl';
import { TERRAIN_WGSL, VERTEX_WGSL, SAND_WGSL, BAKE_GRAD_WGSL, BAKE_SUN_WGSL } from './terrain-wgsl.js';

const helpers = wgslFn(`fn _terrainHelpers() -> f32 { return 0.0; }\n${TERRAIN_WGSL}`);
const sandHelpers = wgslFn(`fn _sandHelpers() -> f32 { return 0.0; }\n${SAND_WGSL.slice(0, SAND_WGSL.indexOf('fn sandAll'))}`, [helpers]);
// wgslFn takes the first function as the entry point; the rest of the code rides along as includes
const fnWith = (entry, deps) => wgslFn(entry, deps);

function placeholder(type) {
  const t = type === 'float'
    ? new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType)
    : new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}

// turn terrain.uniforms ({ value } objects) into TSL nodes; the rest of the game keeps writing .value
function toNodes(T) {
  const u = T.uniforms, blank = placeholder('float'), white = placeholder('rgba');
  const texKeys = { uFine: null, uCoarse: null, uGradFine: blank, uGradCoarse: blank, uDeform: blank, uDeform2: blank, uSunShadow: white, uSandTex: white, uSandNor: white, uRipTex: white, uRipNor: white };
  const n = {};
  for (const [k, v] of Object.entries(u)) {
    if (k in texKeys) n[k] = texture(v.value || texKeys[k]);
    else if (k === 'uRanges') n[k] = uniformArray(Array.from(v.value), 'float');
    else if (k === 'uLP' || k === 'uLD' || k === 'uLC') n[k] = v;            // read from carLightTex instead
    else n[k] = uniform(v.value);
  }
  // a texture that is still null in the WebGL path keeps its placeholder until the game sets it
  for (const k of Object.keys(texKeys)) {
    const node = n[k];
    if (!node) continue;
    let cur = node.value;
    Object.defineProperty(node, 'value', { get: () => cur, set: (t) => { cur = t || texKeys[k] || cur; if (node.updateVersion !== undefined) node.updateVersion++; }, configurable: true });
  }
  T.uniforms = n;
  return n;
}

export function setupTerrainGPU(T, ROOT_HALF) {
  const U = toNodes(T);
  // the WebGPU renderer wants a normal attribute; the real normal comes from the sand shader
  const g = T.geometry, cnt = g.attributes.position.count, nrm = new Float32Array(cnt * 3);
  for (let i = 0; i < cnt; i++) nrm[i * 3 + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));

  // car lights: 16 lights x (pos+intensity, dir+cone, colour) copied into a float texture each frame
  T.carLightData = new Float32Array(16 * 3 * 4);
  T.carLightTex = new THREE.DataTexture(T.carLightData, 16, 3, THREE.RGBAFormat, THREE.FloatType);
  T.carLightTex.magFilter = T.carLightTex.minFilter = THREE.NearestFilter; T.carLightTex.needsUpdate = true;
  T.sunLightColor = uniform(new THREE.Color(1, 1, 1));

  const vertexFn = fnWith(VERTEX_WGSL, [helpers]);
  const sandFn = fnWith(SAND_WGSL.slice(SAND_WGSL.indexOf('fn sandAll')).split('\n// car lights')[0], [sandHelpers]);
  const lightFn = wgslFn(SAND_WGSL.slice(SAND_WGSL.indexOf('fn carLights')));

  const inst = attribute('instData', 'vec4');
  const lvl = int(inst.w.add(0.5));
  const v = vertexFn({
    fine: U.uFine, coarse: U.uCoarse, dt: U.uDeform, ds: sampler(U.uDeform), dt2: U.uDeform2, ds2: sampler(U.uDeform2),
    fi: U.uFineInfo, ci: U.uCoarseInfo, di: U.uDeformInfo, di2: U.uDeformInfo2,
    inst, pos: positionLocal, camPos: U.uCamPos, mEnd: U.uRanges.element(lvl), leafRes: U.uLeafRes, rootHalf: float(ROOT_HALF),
  });
  const m = new MeshPhysicalNodeMaterial({ roughness: 0.92, metalness: 0 });
  m.positionNode = v.xyz;
  const deformDepth = varying(v.w);
  const S = sandFn({
    fine: U.uFine, coarse: U.uCoarse, gradF: U.uGradFine, gradC: U.uGradCoarse, gs: sampler(U.uGradFine),
    dt: U.uDeform, ds: sampler(U.uDeform), dt2: U.uDeform2, ds2: sampler(U.uDeform2),
    sunTex: U.uSunShadow, sunS: sampler(U.uSunShadow), sandTex: U.uSandTex, sandNor: U.uSandNor, sandS: sampler(U.uSandTex),
    fi: U.uFineInfo, ci: U.uCoarseInfo, di: U.uDeformInfo, di2: U.uDeformInfo2, texInfo: U.uTexInfo, texAvg: U.uTexAvg,
    wp: positionWorld, deformDepth, camPos: U.uCamPos, sunDir: U.uSunDir, wind: U.uWind,
  }).toVar('sand');
  const c0 = S.element(0), c1 = S.element(1), c2 = S.element(2);
  const albedo = c0.xyz, N = c1.xyz, sunVis = c1.w, ao = c2.y;
  m.colorNode = vec4(albedo, 1);
  m.roughnessNode = c0.w;
  m.metalnessNode = float(0);
  m.normalNode = transformNormalToView(N);
  m.aoNode = ao;
  m.specularIntensityNode = float(0.3);      // matte sand: hardly any sheen (the WebGL path scales the sky reflection by 0.3)
  m.receivedShadowNode = Fn(([shadow]) => shadow.mul(sunVis));
  const lights = lightFn({ lt: texture(T.carLightTex), n: U.uLN, wp: positionWorld, N });
  m.emissiveNode = albedo.mul(1 / Math.PI).mul(vec3(U.uBounce).mul(ao).add(lights)).add(vec3(T.sunLightColor).mul(c2.x.mul(sunVis)));
  T.material = m;

  // bakes
  T.gpuBake = (rt, fragNode) => {
    const mat = new NodeMaterial(); mat.fragmentNode = fragNode;
    const quad = new QuadMesh(mat);
    const prev = T.renderer.getRenderTarget();
    T.renderer.setRenderTarget(rt); quad.render(T.renderer); T.renderer.setRenderTarget(prev);
    mat.dispose();
  };
  const gradFn = wgslFn(BAKE_GRAD_WGSL.slice(BAKE_GRAD_WGSL.indexOf('fn bakeGrad')), [helpers, wgslFn(BAKE_GRAD_WGSL.slice(0, BAKE_GRAD_WGSL.indexOf('fn bakeGrad')).replace(/^\s*/, '') + '\n')]);
  const mkGrad = (tex, info, n) => {
    const rt = new THREE.RenderTarget(n, n, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, anisotropy: 8 });
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    T.gpuBake(rt, gradFn({ tex: texture(tex), info: uniform(info), pix: screenCoordinate, n: float(n) }));
    return rt;
  };
  T.gradFineRT = mkGrad(T.fineTex, U.uFineInfo.value, Math.min(T.data.fineN * 2, T.opts.gradRes));
  T.gradCoarseRT = mkGrad(T.coarseTex, U.uCoarseInfo.value, T.data.coarseN);
  U.uGradFine.value = T.gradFineRT.texture;
  U.uGradCoarse.value = T.gradCoarseRT.texture;

  const sunFn = wgslFn(BAKE_SUN_WGSL.slice(BAKE_SUN_WGSL.indexOf('fn bakeSun')), [helpers, wgslFn(BAKE_SUN_WGSL.slice(0, BAKE_SUN_WGSL.indexOf('fn bakeSun')))]);
  T.sunDirU = uniform(new THREE.Vector2(1, 0)); T.tanSunU = uniform(1);
  T.bakeSunShadowGPU = (sunDir) => {
    const n = T.opts.sunShadowRes;
    if (!T.sunRT) {
      T.sunRT = new THREE.RenderTarget(n, n, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
      U.uSunShadow.value = T.sunRT.texture;
      T.sunFrag = sunFn({ tex: texture(T.fineTex), info: U.uFineInfo, dir: T.sunDirU, tanSun: T.tanSunU, pix: screenCoordinate, n: float(n) });
    }
    const az = new THREE.Vector2(sunDir.x, sunDir.z), horiz = az.length(); az.normalize();
    T.sunDirU.value.copy(az); T.tanSunU.value = sunDir.y / Math.max(horiz, 1e-4);
    T.gpuBake(T.sunRT, T.sunFrag);
  };

  T.updateGPU = () => {
    const d = T.carLightData, lp = U.uLP.value, ld = U.uLD.value, lc = U.uLC.value;
    for (let i = 0; i < 16; i++) {
      d.set([lp[i].x, lp[i].y, lp[i].z, lp[i].w], i * 4);
      d.set([ld[i].x, ld[i].y, ld[i].z, ld[i].w], 64 + i * 4);
      d.set([lc[i].x, lc[i].y, lc[i].z, 0], 128 + i * 4);
    }
    T.carLightTex.needsUpdate = true;
    if (T.sunLight) T.sunLightColor.value.copy(T.sunLight.color).multiplyScalar(T.sunLight.intensity);
  };
}
