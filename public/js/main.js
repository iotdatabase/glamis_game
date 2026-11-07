// Glamis game - main game loop.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { TerrainData } from './terrain-data.js';
import { TerrainRenderer } from './terrain-render.js';
import { SandDeformer } from './deform.js';
import { tracksFor } from './sand-tracks.js';
import { TrackLog, TrackPen, REC, TILE } from './track-log.js';
import { SandrailPhysics, SANDRAIL_SPEC } from './vehicle-physics.js';
import { SandrailModel } from './sandrail-model.js';
import { SandParticles } from './particles.js';
import { GameRecorder } from './recorder.js';
import { PostFX } from './post.js';
import { Scenery } from './scenery.js';
import { EngineAudio, audioRecordStream, setListener } from './audio.js';
import { NetClient } from './net.js';
import { AIDriver, resolveCarContacts } from './ai-driver.js';
import { Weather } from './weather.js';
import { CarLights } from './car-lights.js';
import { DriverArms } from './driver-arms.js';
import { CockpitLive, LAYER_ARMS, LAYER_MIRROR } from './cockpit-live.js';
import { RESERVED_KEYS, actionForKey, keyName, padName, padValue, isAxis } from './controls.js';
import { makeNightSky, MOON_DIR } from './night-sky.js';
import { PLACES, placeXZ } from './places.js';
import { Radar } from './radar.js';
import { Menu, loadSettings, saveSettings, GLOBAL_KEYS, SCHEMA } from './menu.js';
import { CARS, CAR_IDS, loadCar, GltfSandrail, setLookDaylight, setLookBackend } from './gltf-sandrail.js';

const params = new URLSearchParams(location.search);
const QUALITY = {
  // Tuned for an RTX 5090 class GPU
  ultra: { pixelRatio: Math.min(window.devicePixelRatio || 1, 2), shadow: 8192, shadowBox: 90, patchRes: 128, leafSize: 16, lodRange0: 52, gradRes: 8192, sunShadowRes: 4096, deformRes: 4096, deformTexel: 0.035, farRes: 4096, farTexel: 0.13, grains: 60000, dust: 8000, msaa: true, aniso: 16 },
  high: { pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5), shadow: 4096, shadowBox: 80, patchRes: 64, leafSize: 16, lodRange0: 40, gradRes: 4096, sunShadowRes: 2048, deformRes: 2048, deformTexel: 0.06, farRes: 2048, farTexel: 0.2, grains: 30000, dust: 4500, msaa: true, aniso: 8 },
  low: { pixelRatio: 1, shadow: 2048, shadowBox: 60, patchRes: 32, leafSize: 16, lodRange0: 32, gradRes: 2048, sunShadowRes: 1024, deformRes: 1024, deformTexel: 0.1, farRes: 2048, farTexel: 0.22, grains: 8000, dust: 1200, msaa: false, aniso: 4 },
};
const settings = loadSettings();
const qName = QUALITY[params.get('q')] ? params.get('q') : (QUALITY[settings.quality] ? settings.quality : 'ultra');
const Q = QUALITY[qName];
const SPAWN = { x: 940, z: -800 };

const $ = (id) => document.getElementById(id);
const status = (t) => { const el = $('loading-status'); if (el) el.textContent = t; };

async function main() {
  // ---------- renderer ----------
  // M > Quality > Renderer (or ?renderer=webgpu / ?renderer=webgl) picks three.js's WebGPU renderer
  // (experimental); WebGL2 is the default and the automatic fallback when WebGPU is missing or fails
  let renderer = null, gpu = null, gpuName = 'GPU';
  const wantGPU = (params.get('renderer') || settings.renderer) === 'webgpu';
  if (wantGPU && navigator.gpu) {
    try {
      const W = await import('three/webgpu');
      renderer = new W.WebGPURenderer({ antialias: Q.msaa, powerPreference: 'high-performance' });
      await renderer.init();
      if (!renderer.backend.isWebGPUBackend) throw new Error('no WebGPU backend');
      gpu = { W, terrain: await import('./gpu/terrain-gpu.js'), fx: await import('./gpu/effects-gpu.js'), car: await import('./gpu/car-gpu.js'), merge: await import('./gpu/merge-gpu.js'), post: await import('./gpu/post-gpu.js'), SkyMesh: (await import('three/addons/objects/SkyMesh.js')).SkyMesh };
      setLookBackend(gpu.car.convertCarLooks);
      const info = renderer.backend.adapter?.info || {};
      gpuName = 'WebGPU · ' + (info.description || `${info.vendor || ''} ${info.architecture || ''}`.trim() || 'GPU');
    } catch (e) {
      console.warn('WebGPU unavailable, using WebGL2:', e);
      try { renderer?.dispose(); } catch { /* ignore */ }
      renderer = null; gpu = null;
    }
  }
  if (!renderer) renderer = new THREE.WebGLRenderer({ antialias: Q.msaa, powerPreference: 'high-performance', reversedDepthBuffer: params.get('rd') !== '0', preserveDrawingBuffer: params.has('shot') });
  renderer.setPixelRatio(Q.pixelRatio * (Number(params.get('ss')) || settings.renderScale));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // ACES at 0.53 (the look the sand and sky are tuned for); ?tm=neutral|agx&exp=x tries the others
  const TM = { neutral: [THREE.NeutralToneMapping, 0.8], agx: [THREE.AgXToneMapping, 0.9] }[params.get('tm')] || [THREE.ACESFilmicToneMapping, 0.45];
  const EXPO = Number(params.get('exp')) || TM[1];
  renderer.toneMapping = TM[0];
  renderer.toneMappingExposure = EXPO;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.appendChild(renderer.domElement);
  if (!gpu) {
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'GPU';
  }
  // WebGPU: the sky is three.js's node version (same settings, exposed under the old uniform names)
  const makeSky = () => {
    if (!gpu) return new Sky();
    const s = new gpu.SkyMesh();
    s.material.uniforms = { turbidity: s.turbidity, rayleigh: s.rayleigh, mieCoefficient: s.mieCoefficient, mieDirectionalG: s.mieDirectionalG,
      sunPosition: s.sunPosition, cloudScale: s.cloudScale, cloudSpeed: s.cloudSpeed, cloudCoverage: s.cloudCoverage, cloudDensity: s.cloudDensity,
      cloudElevation: s.cloudElevation, showSunDisc: s.showSunDisc, time: { value: 0 } };
    return s;
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.15, 150000);
  // screen effects (M > Quality); 'auto' follows the preset: all on at Ultra / High, only the colour grade at Low
  const post = gpu ? new gpu.post.PostFXGPU(renderer, scene, camera, Q.msaa) : new PostFX(renderer, scene, camera, Q.msaa);
  const POST_KEYS = { bloom: 'bloom', heatHaze: 'shimmer', colorGrade: 'grade' };
  const postAuto = (k) => qName !== 'low' || k === 'colorGrade';
  function applyPost() { const o = {}; for (const [k, n] of Object.entries(POST_KEYS)) o[n] = settings[k] === 'auto' || settings[k] === undefined ? postAuto(k) : !!settings[k]; post.set(o); }
  applyPost();
  const light = { el: 1, warm: 0, night: false };
  camera.layers.enable(LAYER_ARMS); camera.layers.enable(LAYER_MIRROR);   // the mirror cameras see neither

  status('Loading Glamis elevation data (USGS 3DEP)...');
  const terrainData = await TerrainData.load('data/');

  // ---------- sky + sun ----------
  const sky = makeSky();
  sky.scale.setScalar(140000);
  const su = sky.material.uniforms;
  su.turbidity.value = 2.2; su.rayleigh.value = 1.1; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.86;
  su.cloudCoverage.value = 0.12; su.cloudDensity.value = 0.35; su.cloudScale.value = 0.00012;
  scene.add(sky);
  const nightSky = gpu ? gpu.fx.makeNightSkyGPU(MOON_DIR) : makeNightSky();
  scene.add(nightSky);
  const SUN_I = 7.5;
  const sun = new THREE.DirectionalLight(0xfff1dd, SUN_I);
  sun.castShadow = true;
  sun.shadow.mapSize.set(Q.shadow, Q.shadow);
  const sc = sun.shadow.camera;
  sc.left = -Q.shadowBox; sc.right = Q.shadowBox; sc.top = Q.shadowBox; sc.bottom = -Q.shadowBox;
  sc.near = 1; sc.far = 1200;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xa8c8ff, 0xd9a66e, 0.15); // sky above, light bounced off the bright sand below
  scene.add(hemi);
  scene.fog = new THREE.FogExp2(0xc8d4e2, 0.000032);

  const sunDir = new THREE.Vector3();
  const pmrem = gpu ? new gpu.W.PMREMGenerator(renderer) : new THREE.PMREMGenerator(renderer);
  let envRT = null;
  let timeOfDay = Number(params.get('tod') ?? settings.tod); // hours
  let weather = null;
  function setSun(hours) {
    const night = !!settings.night;
    let el, warm;
    const wx = weather ? weather.p : { sun: 1, env: 1 };
    if (night) {
      // full moon: cool, dim light from high in the sky
      sunDir.copy(MOON_DIR);
      el = Math.asin(MOON_DIR.y); warm = 0;
      su.sunPosition.value.set(0, -1, 0);
      sun.color.setRGB(0.42, 0.58, 1.0);
      sun.intensity = 0.7 * wx.sun;
      hemi.intensity = 0.06 * wx.env;
    } else {
      // simple solar path for Glamis in spring: rises E, sets W, max elevation ~62 deg
      const t = (hours - 6) / 13.6; // 0 sunrise .. 1 sunset
      el = Math.max(-0.05, Math.sin(Math.PI * t)) * 62 * Math.PI / 180;
      const az = (90 + 180 * t) * Math.PI / 180; // from north, clockwise
      sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
      su.sunPosition.value.copy(sunDir);
      warm = 1 - Math.min(1, Math.max(0, (el * 180 / Math.PI - 4) / 45));
      sun.color.setRGB(1, 0.97 - warm * 0.2, 0.92 - warm * 0.38);
      sun.intensity = SUN_I * wx.sun * Math.min(1, Math.max(0.05, el * 180 / Math.PI / 8));
      hemi.intensity = 0.42 * wx.env;
    }
    renderer.toneMappingExposure = night ? EXPO * 0.95 / 0.45 : EXPO;
    light.el = el; light.warm = warm; light.night = night;
    // the cars' orange lift / cabin fill follow the daylight
    setLookDaylight(night ? 0 : Math.min(1, Math.max(0, el * 180 / Math.PI / 8)) * wx.sun);
    // environment for reflections / sky light
    const envScene = new THREE.Scene();
    const sky2 = makeSky(); sky2.scale.setScalar(1000);
    // (very turbid skies render far too bright as a light source; haze is added below as a dust dome)
    sky2.material.uniforms.turbidity.value = Math.min(su.turbidity.value, 3.5);
    sky2.material.uniforms.rayleigh.value = Math.min(su.rayleigh.value, 1.3);
    sky2.material.uniforms.mieCoefficient.value = su.mieCoefficient.value;
    sky2.material.uniforms.mieDirectionalG.value = su.mieDirectionalG.value;
    sky2.material.uniforms.sunPosition.value.copy(sunDir);
    sky2.material.uniforms.showSunDisc.value = 0;
    sky2.material.uniforms.cloudCoverage.value = su.cloudCoverage.value;
    sky2.material.uniforms.cloudDensity.value = su.cloudDensity.value;
    if (!night) envScene.add(sky2);
    else envScene.add(new THREE.Mesh(new THREE.SphereGeometry(800, 32, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.012, 0.018, 0.04), side: THREE.BackSide })));
    if (weather && weather.p.tint > 0) {
      const dome = new THREE.Mesh(new THREE.SphereGeometry(800, 32, 16), new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.78, 0.62, 0.44).multiplyScalar(0.25 + 0.9 * Math.max(0.1, Math.sin(el)) * wx.sun),
        side: THREE.BackSide, transparent: true, opacity: Math.min(0.97, weather.p.tint * 0.97), depthWrite: false }));
      envScene.add(dome);
    }
    // sand-coloured ground hemisphere so chrome reflects the desert floor
    const ground = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.43, 0.30).multiplyScalar(night ? 0.04 : 0.6 + 0.6 * Math.sin(el)), side: THREE.BackSide }));
    envScene.add(ground);
    if (envRT) envRT.dispose();
    envRT = pmrem.fromScene(envScene, 0, 0.1, 2000);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.45 * wx.env;   // less sky in the reflections: black paint stays black
    if (terrain) { terrain.material.envMap = envRT.texture; terrain.material.envMapIntensity = 0.38 * wx.env; terrain.material.needsUpdate = true; }
    // fog colour: a pale blue-grey desert haze, darker than the horizon sky (fogging into the near-white sky turned the far dunes white)
    const fogC = night ? new THREE.Color(0.30, 0.40, 0.62) : new THREE.Color().setRGB(0.50, 0.47, 0.48).lerp(new THREE.Color(0.63, 0.50, 0.37), warm * 0.6);
    if (weather) weather.tintFog(fogC);
    if (night) {
      fogC.multiplyScalar(0.07);
      if (sky.visible) { sky.visible = false; nightSky.visible = true; } else { nightSky.visible = false; scene.background = fogC.clone(); }
    } else nightSky.visible = false;
    scene.fog.color.copy(fogC);
    if (terrain) {
      // sunlit sand all around throws warm light back into the shade
      terrain.uniforms.uBounce.value.setRGB(1.0, 0.8, 0.62).multiply(sun.color).multiplyScalar(sun.intensity * Math.max(0, sunDir.y) * 0.32);
      terrain.uniforms.uSunDir.value.copy(sunDir);
      terrain.bakeSunShadow(sunDir);
    }
    if (particles) {
      particles.uniforms.uSunDir.value.copy(sunDir);
      particles.uniforms.uSunColor.value.copy(sun.color).multiplyScalar(sun.intensity / SUN_I);
      particles.uniforms.uFogColor.value.copy(fogC);
      // dust picks up the colour of the haze it hangs in (tan in a sandstorm, cool blue sky light when clear)
      particles.uniforms.uAmbient.value.setRGB(0.44, 0.40, 0.38).lerp(fogC, weather ? Math.min(1, weather.p.tint * 1.2) : 0).multiplyScalar(0.5 + 0.5 * Math.max(0.2, Math.sin(el)) * (weather ? weather.p.env : 1));
      if (night) {
        // moonlit dust should read as faint sand, not grey smoke: same brightness as the moonlit dunes, warm sand tint
        // warm-neutral so the dust keeps the sand's tan colour (a blue moon tint turned it grey)
        particles.uniforms.uAmbient.value.setRGB(0.03, 0.024, 0.019);
        particles.uniforms.uSunColor.value.setRGB(0.11, 0.085, 0.064);
      }
    }
  }

  // ---------- terrain ----------
  status('Building terrain (CDLOD, gradient + shadow bakes on GPU)...');
  let terrain = null, particles = null;
  terrain = new TerrainRenderer(renderer, terrainData, { patchRes: Q.patchRes, leafSize: Q.leafSize, lodRange0: Q.lodRange0, gradRes: Q.gradRes, sunShadowRes: Q.sunShadowRes, gpu: gpu?.terrain });
  terrain.sunLight = sun;
  if (gpu) sun.shadow.camera.layers.enable(gpu.merge.SHADOW_LAYER);   // the cars' merged shadow casters
  scene.add(terrain.mesh);
  const Deformer = gpu ? gpu.fx.SandDeformerGPU : SandDeformer;
  const deform = new Deformer(renderer, { res: Q.deformRes, texel: Q.deformTexel });
  terrain.uniforms.uDeform.value = deform.texture;
  // a coarser rut map reaching 200+ m out, so tracks are already there before you get close
  const deformFar = new Deformer(renderer, { res: Q.farRes, texel: Q.farTexel, coarse: true });
  terrain.uniforms.uDeform2.value = deformFar.texture;
  const deforms = [deform, deformFar];
  // every rut is kept for 48 hours (stored by the server, shared with all players)
  const tlog = new TrackLog();
  const ruts = tracksFor(terrainData);
  deform.log = tlog; deformFar.log = tlog; ruts.log = tlog;
  tlog.onTile = (t) => { for (const d of deforms) d.replay(t.tx * TILE - 4, t.tz * TILE - 4, (t.tx + 1) * TILE + 4, (t.tz + 1) * TILE + 4); };
  tlog.onRecords = (buf, o, n) => {
    for (let i = 0; i < n; i++) {
      const p = o + i * REC;
      for (const d of deforms) if (d.overlaps(Math.min(buf[p], buf[p + 2]) - 1, Math.min(buf[p + 1], buf[p + 3]) - 1, Math.max(buf[p], buf[p + 2]) + 1, Math.max(buf[p + 1], buf[p + 3]) + 1)) d.stamp(buf, p);
      ruts.stampSeg(buf, p);
    }
  };
  particles = new SandParticles(scene, { grains: Q.grains, dust: Q.dust, makeMaterial: gpu ? gpu.fx.makeParticleMaterialFactory(terrain) : undefined });
  for (const k of ['uLP', 'uLD', 'uLC']) particles.uniforms[k] = terrain.uniforms[k]; // same car lights light the dust
  particles.uniforms.uFogDensity.value = scene.fog.density;
  particles.emitScale = settings.particles;
  // photo-scanned sand textures (assets/textures, CC0 from Poly Haven): test patch around the spawn
  const texLoader = new THREE.TextureLoader();
  const loadTex = (f, srgb) => texLoader.loadAsync('assets/textures/' + f).then((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = Q.aniso; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
  });
  let sandTexReady = false;
  Promise.all([loadTex('sand_03_diff_2k.webp', true), loadTex('sand_03_nor_gl_2k.webp'), loadTex('aerial_beach_01_diff_2k.webp', true), loadTex('aerial_beach_01_nor_gl_2k.jpg')])
    .then(([a, b, c, d]) => {
      const u = terrain.uniforms;
      u.uSandTex.value = a; u.uSandNor.value = b; u.uRipTex.value = c; u.uRipNor.value = d;
      u.uTexAvg.value.set(0.122, 0.25); // mean linear luminance of the two diffuse maps
      sandTexReady = true; applySandTex(settings.sandTex);
    }).catch((e) => console.warn('sand textures not found in assets/textures, using procedural sand only', e));
  function applySandTex(mode) {
    terrain.uniforms.uTexInfo.value.set(SPAWN.x, SPAWN.z, 160, sandTexReady ? ({ off: 0, patch: 1, all: 2 }[mode] ?? 1) : 0);
  }
  weather = new Weather({ scene, sky, particles });
  weather.windScale = settings.wind;
  weather.set(settings.weather);
  setSun(timeOfDay);
  function applyShadows(level) {
    const size = { low: 2048, high: 4096, ultra: Q.shadow }[level];
    sun.castShadow = level !== 'off';
    if (size && sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
  }
  applyShadows(settings.shadows);

  // ---------- local car ----------
  let lightsOn = !!settings.night; // N toggles the light bars and whips (they come on at night)
  // Only your own car is loaded before the game starts. The light models the computer riders drive
  // follow in the background; the big detailed ones (GLX pro, GLX pro 2, Trax) only when someone drives one.
  const templates = {};
  const failed = new Set();
  const onCarLoaded = [];   // (id) => {} once a model has arrived
  function ensureCar(id, onProgress) {
    if (!CARS[id] || templates[id] || failed.has(id)) return Promise.resolve(templates[id] || null);
    return loadCar(id, onProgress).then((t) => { templates[id] = t; for (const f of onCarLoaded) f(id); return t; },
      (e) => { failed.add(id); console.warn('could not load', id, e); return null; });
  }
  const BOT_CARS = CAR_IDS.filter(id => !CARS[id].heavy);
  if (settings.car !== 'classic' && !CARS[settings.car]) settings.car = CAR_IDS[0];
  if (CARS[settings.car]) {
    status('Loading your sandrail...');
    await ensureCar(settings.car, (f) => status(`Loading your sandrail... ${Math.round(f * 100)}%`));
  }
  const availableCars = Object.keys(templates);
  if (!availableCars.length) console.warn('No .glb sandrails found in assets/, using the built-in model');
  // a visual + physics spec for a car id ('classic' or a missing model = the built-in procedural rail)
  // WebGPU: merge the parts that never move into one mesh per material (fewer draw calls); the player's car
  // waits until its live mirrors and dash screens are set up (those stay separate)
  function mergeParts(m) {
    if (!gpu || !(m instanceof GltfSandrail)) return;
    const ex = new Set();
    for (const mi of m.live?.mirrors || []) ex.add(mi.mesh);
    for (const s of Object.values(m.live?.screens || {})) for (const mesh of s.meshes) ex.add(mesh);
    gpu.merge.mergeStaticParts(m, ex);
  }
  function makeVisual(id, tint, player = false) {
    const tpl = templates[id];
    let m;
    if (tpl) m = new GltfSandrail(tpl);
    else { m = new SandrailModel({ tint: tint ?? 0xb00d12 }); m.eye = null; }
    m.lights = new CarLights(m, CARS[id] && tpl ? parseInt(CARS[id].color.slice(1), 16) : (tint ?? 0xb00d12)); // LED light bar + whips (top light in the car's color)
    m.lights.setOn(lightsOn);
    m.setLamps?.(lightsOn);
    if (!player) mergeParts(m);
    return m;
  }
  const specFor = (id) => templates[id]?.spec || SANDRAIL_SPEC;
  if (settings.car !== 'classic' && !templates[settings.car]) settings.car = 'classic';
  status('Building sandrail...');
  let car = new SandrailPhysics(terrainData, specFor(settings.car));
  // face the biggest dune near the spawn bowl
  let bestYaw = 0, bestH = -1e9;
  for (let a = 0; a < 32; a++) {
    const yaw = a / 32 * Math.PI * 2;
    const h = terrainData.height(SPAWN.x + Math.sin(yaw) * 140, SPAWN.z + Math.cos(yaw) * 140);
    if (h > bestH) { bestH = h; bestYaw = yaw; }
  }
  const spawnOffset = (Math.random() - 0.5) * 30;
  car.reset(SPAWN.x + Math.cos(bestYaw) * spawnOffset, SPAWN.z - Math.sin(bestYaw) * spawnOffset, bestYaw);
  let model = makeVisual(settings.car, undefined, true);
  model.arms = DriverArms.for(model);
  // live mirrors, dash and chart plotter, cabin fill (the radar is made further down)
  const makeLive = (m) => (m instanceof GltfSandrail ? new CockpitLive(m, { getRadar: () => radar, getTerrain: () => terrain, mirrorsLive: settings.liveMirrors !== false }) : null);
  model.live = makeLive(model);
  mergeParts(model);
  scene.add(model.root);
  function switchCar(id) {
    const old = car;
    const nc = new SandrailPhysics(terrainData, specFor(id));
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(old.quat);
    nc.reset(old.pos.x, old.pos.z, Math.atan2(f.x, f.z));
    nc.vel.copy(old.vel);
    nc.gravity = old.gravity; nc.grip = old.grip; nc.softness = old.softness;
    nc.autoTrans = old.autoTrans; nc.wheelieControl = old.wheelieControl; nc.steerAssist = old.steerAssist;
    car = nc;
    scene.remove(model.root);
    model.live?.dispose();
    model = makeVisual(id, undefined, true);
    model.arms = DriverArms.for(model);
    model.live = makeLive(model);
    mergeParts(model);
    radarVis();
    scene.add(model.root);
    for (let i = 0; i < 4; i++) prevContact[i] = null;
    net.setCar(id);
    toast((CARS[id]?.label || 'Classic sandrail'));
  }
  car.autoTrans = settings.autoTrans; car.wheelieControl = settings.wheelieControl; car.steerAssist = settings.steerAssist;

  // ---------- computer-driven sandrails ----------
  const bots = [];
  function setBotCount(n) {
    while (bots.length > n) { const b = bots.pop(); scene.remove(b.model.root); b.label.remove(); }
    while (bots.length < n) {
      // each computer car gets one of your models, the others before repeats
      const ready = BOT_CARS.filter(id => templates[id]);
      const pool = ready.filter(id => id !== settings.car);
      const carId = pool.length ? pool[bots.length % pool.length] : (ready[0] || 'classic');
      const b = new AIDriver(terrainData, bots.length, specFor(carId));
      b.carId = carId;
      if (CARS[carId] && templates[carId]) b.tint = parseInt(CARS[carId].color.slice(1), 16);
      b.spawnNear(car.pos.x, car.pos.z, 80, 450);
      b.skill = settings.aiSkill;
      b.car.gravity = settings.gravity; b.car.grip = settings.grip; b.car.softness = settings.softness;
      b.model = makeVisual(carId, b.tint);
      scene.add(b.model.root);
      b.label = document.createElement('div'); b.label.className = 'tag'; document.body.appendChild(b.label);
      b.prevContact = [null, null, null, null]; b.prevDist = [0, 0, 0, 0];
      b.pens = [new TrackPen(), new TrackPen(), new TrackPen(), new TrackPen()];
      bots.push(b);
    }
    updatePlayerList?.();
  }

  // ---------- remote cars ----------
  const remotes = new Map();
  let netRemoteSetting = null, pendingWorld = null;
  const net = new NetClient({
    onStatus: (ok) => { $('net').textContent = ok ? 'Online' : 'Offline (single player)'; tlog.setConnected(ok); },
    onBinary: (f) => {
      if (f[0] === 1) tlog.addRemote(f, 1, Math.floor((f.length - 1) / REC));
      else if (f[0] === 2) tlog.receiveTile(f[1], f[2], f, 3, Math.floor((f.length - 3) / REC));
    },
    onJoin: (id, name, tint, s, carId) => {
      if (remotes.has(id)) return;
      const m = makeVisual(carId, tint);
      scene.add(m.root);
      const label = document.createElement('div'); label.className = 'tag'; label.textContent = name; document.body.appendChild(label);
      remotes.set(id, { model: m, name, tint, carId, buf: [], label, prevContacts: [null, null, null, null], dist: [0, 0, 0, 0] });
      ensureCar(carId);
      if (s) remotes.get(id).buf.push({ t: performance.now(), s });
      updatePlayerList();
    },
    onLeave: (id) => { const r = remotes.get(id); if (!r) return; scene.remove(r.model.root); r.label.remove(); remotes.delete(id); updatePlayerList(); },
    onSetting: (key, v, who) => netRemoteSetting?.(key, v, who),
    onWorld: (world) => { if (netRemoteSetting) for (const [k, v] of Object.entries(world || {})) netRemoteSetting(k, v, null); else pendingWorld = world; },
    onCar: (id, carId) => {
      const r = remotes.get(id); if (!r) return;
      r.carId = carId; ensureCar(carId);
      scene.remove(r.model.root); r.model = makeVisual(carId, r.tint); scene.add(r.model.root);
    },
    onState: (id, s) => { const r = remotes.get(id); if (r) { r.buf.push({ t: performance.now(), s }); if (r.buf.length > 30) r.buf.shift(); } },
  });
  tlog.send = (buf) => net.sendBinary(buf);
  tlog.request = (keys) => net.sendJSON({ t: 'trkReq', keys });
  const playerName = localStorage.getItem('glamis-name') || ('Driver ' + Math.floor(Math.random() * 900 + 100));
  net.world = () => Object.fromEntries(GLOBAL_KEYS.map(k => [k, settings[k]]));
  if (location.protocol.startsWith('http')) net.connect(playerName, settings.car);
  function updatePlayerList() {
    const online = remotes.size ? ` · online: ${[...remotes.values()].map(r => r.name).join(', ')}` : '';
    $('players').textContent = `${playerName}${online}` + (bots.length ? ` · ${bots.length} computer sandrails` : '');
  }
  setBotCount(settings.aiCount);
  updatePlayerList();
  // a model arrived: other players' cars switch to it, computer riders are re-dealt once all light models are in
  onCarLoaded.push((id) => {
    for (const r of remotes.values()) if (r.carId === id) { scene.remove(r.model.root); r.model = makeVisual(id, r.tint); scene.add(r.model.root); }
  });
  // scenery: bushes on the flats, camps with RVs and parked rails at Glamis Flats and Osborne Overlook
  const SCN = { ultra: { budget: 3500, radius: 550, shadows: true, parked: 3 }, high: { budget: 2500, radius: 420, shadows: true, parked: 2 }, low: { budget: 1000, radius: 260, shadows: false, parked: 0 } }[qName];
  const scenery = new Scenery(scene, terrainData, SCN);
  const parkedModel = (k) => { const ready = BOT_CARS.filter(id => templates[id]); return ready.length ? new GltfSandrail(templates[ready[(k + 3) % ready.length]]).root : null; };
  scenery.buildCamps(terrainData.meta, parkedModel);
  scenery.setEnabled(settings.scenery !== false);
  Promise.all(BOT_CARS.map(id => ensureCar(id))).then(() => {
    scenery.addParked(parkedModel);
    if (!bots.length) return;
    const n = bots.length; setBotCount(0); setBotCount(n);
  });

  // ---------- input ----------
  const keys = new Set();
  const input = { steer: 0, throttle: 0, brake: 0 };
  // every action can be rebound in the menu (M > Key bindings)
  let binds = null; // menu.bindings, once the menu exists
  const ACT = {
    camera: () => setSetting('camMode', (camMode + 1) % CAM_MODES.length),
    reset: () => { const f = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quat); car.reset(car.pos.x, car.pos.z, Math.atan2(f.x, f.z)); },
    hud: () => $('hud').classList.toggle('hidden'),
    help: () => setSetting('showHelp', !settings.showHelp),
    shiftUp: () => shift(true), shiftDown: () => shift(false),
    assist: () => { setSetting('steerAssist', !car.steerAssist); toast('Countersteer assist ' + (car.steerAssist ? 'on' : 'off')); },
    wheelie: () => { setSetting('wheelieControl', !car.wheelieControl); toast('Wheelie control ' + (car.wheelieControl ? 'on' : 'off (full send)')); },
    time: () => {
      // 7 AM ... 7 PM, then night, then morning again
      if (settings.night) { setSetting('night', false); setSetting('tod', 7); toast('Time 7:00'); }
      else if (timeOfDay >= 19) { setSetting('night', true); toast('Night (' + keyName(binds.lights.keys[0]) + ' switches the light bars)'); }
      else { setSetting('tod', Math.floor(timeOfDay) + 1); toast('Time ' + Math.floor(timeOfDay) + ':' + String(Math.round((timeOfDay % 1) * 60)).padStart(2, '0')); }
    },
    teleport: () => { tpIndex = (tpIndex + 1) % PLACES.length; teleport(PLACES[tpIndex].id); },
    lights: () => { setLights(!lightsOn); toast('Light bars ' + (lightsOn ? 'on' : 'off')); },
    record: () => toggleRecording(),
    name: () => { const n = prompt('Your driver name', playerName); if (n) { localStorage.setItem('glamis-name', n); location.reload(); } },
  };
  // ---------- video recorder (K / F8): the 3D view + engine sound, saved to Downloads ----------
  const recorder = new GameRecorder(renderer.domElement, () => { audio.start(); return audioRecordStream(); }, (on, t) => {
    const el = $('rec');
    el.classList.toggle('on', on);
    el.textContent = 'REC ' + Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
  });
  recorder.onSaved = (f) => toast(`Saved ${f.name} (${(f.size / 1e6).toFixed(0)} MB) to Downloads`);
  $('rec').addEventListener('click', () => toggleRecording());
  function toggleRecording() {
    if (!GameRecorder.supported()) { toast('This browser cannot record video'); return; }
    if (recorder.active) recorder.stop();
    else if (recorder.start()) toast('Recording (' + keyName(binds.record.keys[0]) + ' stops)');
  }
  function shift(up) {
    // in automatic this is a short paddle-shift override (vehicle-physics.js); the full manual gearbox is in M > Controls
    if (up) car.input.shiftUp = true; else car.input.shiftDown = true;
  }
  addEventListener('keydown', (e) => {
    if (!binds) return;
    if (RESERVED_KEYS.includes(e.code)) { menu.toggle(); keys.clear(); audio.start(); return; }
    if (menu.open) return;
    keys.add(e.code);
    const act = actionForKey(binds, e.code);
    if (act && (e.code === 'F1' || e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Slash' || e.code === 'Tab')) e.preventDefault();
    if (act && ACT[act] && !e.repeat) ACT[act]();
    audio.start();
  });
  // help panel lists the player's own keys
  const KEY_HELP = [['throttle', 'Throttle (1200 hp, feather it)'], ['brake', 'Brake, hold when stopped to reverse'], [['left', 'right'], 'Steer'], ['handbrake', 'Handbrake'],
    ['camera', 'Camera (chase, far, cockpit, hood, side) · drag mouse to look'], ['reset', 'Flip back upright'], ['time', 'Time of day, then night'],
    ['lights', 'LED light bars and whip lights on / off'], ['teleport', 'Teleport to the next hill climb or bowl'], [['shiftDown', 'shiftUp'], 'Shift down / up (automatic takes over again after 3 s)'],
    ['wheelie', 'Wheelie control'], ['assist', 'Countersteer assist'], ['name', 'Set your name'], ['record', 'Record a video (saved to Downloads)'], [['hud', 'help'], 'Hide HUD / this help']];
  function renderHelp() {
    const k = (id) => binds[id].keys.filter(Boolean).map(keyName).join(' or ') || '-';
    const rows = KEY_HELP.map(([ids, d]) => `<div><b>${(Array.isArray(ids) ? ids.map(k).join(' · ') : k(ids)).replace(/</g, '&lt;')}</b>${d}</div>`);
    rows.push('<div><b>M / Esc</b>Menu: key bindings, quality, weather, teleport</div>');
    rows.push(`<div style="opacity:.75">Controller: ${padName(binds.throttle.pad[0])} gas, ${padName(binds.brake.pad[0])} brake, ${padName(binds.handbrake.pad[0])} handbrake, ${padName(binds.camera.pad[0])} camera · Start menu</div>`);
    $('help').innerHTML = rows.join('');
  }
  addEventListener('keyup', (e) => keys.delete(e.code));
  // a key released while the window was in the background never sends keyup
  addEventListener('blur', () => keys.clear());
  addEventListener('pointerdown', () => audio.start());
  let orbitYaw = 0, orbitPitch = 0, dragging = false, camDist = 1;
  renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; renderer.domElement.setPointerCapture(e.pointerId); });
  renderer.domElement.addEventListener('pointerup', () => { dragging = false; });
  renderer.domElement.addEventListener('pointermove', (e) => { if (dragging) { orbitYaw -= e.movementX * 0.005; orbitPitch = Math.max(-0.4, Math.min(1.2, orbitPitch + e.movementY * 0.004 * (settings.invertLook ? -1 : 1))); } });
  renderer.domElement.addEventListener('wheel', (e) => { camDist = Math.max(0.5, Math.min(4, camDist * (1 + Math.sign(e.deltaY) * 0.1))); });

  let flipT = 0; const _upChk = new THREE.Vector3();
  const prevComp = [], prevGround = [], _lf = new THREE.Vector3(), _lu = new THREE.Vector3(); let airT = 0, thumpT = 0, lastGear = 1;
  const padPrev = {};
  function readInput(dt) {
    const k = (id) => binds[id].keys.some(x => x && keys.has(x));
    let steerT = (k('right') ? 1 : 0) - (k('left') ? 1 : 0);
    let thr = k('throttle') ? 1 : 0;
    let brk = k('brake') ? 1 : 0;
    let hb = k('handbrake');
    let analog = false;
    if (menu.open) { steerT = 0; thr = 0; brk = 0; hb = false; }
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp) continue;
      if (gp.buttons[9]?.pressed && !gp._st) menu.toggle(); gp._st = gp.buttons[9]?.pressed;
      if (menu.open) continue;
      const pv = (id) => Math.max(padValue(gp, binds[id].pad[0]), padValue(gp, binds[id].pad[1]));
      const pAxis = (id) => binds[id].pad.some(c => isAxis(c) && padValue(gp, c) > 0);
      const sr = pv('right'), sl = pv('left');
      if (sr > 0 || sl > 0) {
        const v = sr - sl;
        if (pAxis('right') || pAxis('left')) { steerT = Math.sign(v) * Math.abs(v) ** 1.5; analog = true; } else steerT = Math.sign(v);
      }
      const rt = pv('throttle'), lt = pv('brake');
      if (rt > 0.02) thr = rt; if (lt > 0.02) brk = lt;
      if (pv('handbrake') > 0.5) hb = true;
      // one-shot actions fire when the button goes down
      const prevAll = padPrev[gp.index] || (padPrev[gp.index] = {});
      for (const id of Object.keys(ACT)) {
        const on = pv(id) > 0.5;
        if (on && !prevAll[id]) ACT[id]();
        prevAll[id] = on;
      }
      const rx = gp.axes[2] || 0, ry = gp.axes[3] || 0;
      if (Math.abs(rx) > 0.15) orbitYaw -= rx * dt * 2.5; else if (!dragging) orbitYaw *= Math.pow(0.1, dt);
      if (Math.abs(ry) > 0.15) orbitPitch = Math.max(-0.4, Math.min(1.2, orbitPitch + ry * dt * 1.5));
    }
    if (analog) input.steer = steerT;
    else {
      const rate = ((steerT === 0 || Math.sign(steerT) !== Math.sign(input.steer)) ? 7 : 4.2) * settings.steerSens;
      input.steer += Math.max(-rate * dt, Math.min(rate * dt, steerT - input.steer));
    }
    // keyboard throttle ramps in quickly (feathering by tapping still works)
    input.throttle += Math.max(-8 * dt, Math.min(5 * dt, thr - input.throttle));
    input.brake = brk;
    Object.assign(car.input, { steer: input.steer, throttle: input.throttle, brake: input.brake, handbrake: hb });
  }

  // ---------- camera ----------
  const CAM_MODES = ['chase', 'far', 'cockpit', 'hood', 'side'];
  let camMode = settings.camMode;
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  let camInit = false;
  const _f = new THREE.Vector3(), _u = new THREE.Vector3(), _t = new THREE.Vector3(), _qi = new THREE.Quaternion();
  // up: the head's steadied 'up' (gaze stabilisation); j / jV: a stiff head spring kicked by old ruts (x roll, y lift, z pitch)
  const head = { prevVel: new THREE.Vector3(), acc: new THREE.Vector3(), off: new THREE.Vector3(), offV: new THREE.Vector3(), t: 0,
    up: new THREE.Vector3(0, 1, 0), j: new THREE.Vector3(), jV: new THREE.Vector3(), echo: [] };
  const _qs = new THREE.Quaternion(), _ms = new THREE.Matrix4(), _sl = new THREE.Vector3(), _sf = new THREE.Vector3(), _su = new THREE.Vector3();
  function updateCamera(dt) {
    const mode = CAM_MODES[camMode];
    _f.set(0, 0, 1).applyQuaternion(car.quat);
    const yaw = Math.atan2(_f.x, _f.z) + orbitYaw;
    const fov = mode === 'cockpit' ? THREE.MathUtils.clamp(Number(settings.cockpitFov) || 78, 50, 90) : mode === 'hood' ? 70 : 62;
    if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    if (model.arms) { model.arms.setVisible(mode === 'cockpit' && settings.driverArms === true); model.arms.update(car.steerAngle * 5); }
    if (model.live) model.live.setActive(mode === 'cockpit');
    if ((mode === 'cockpit') !== radarVis.cockpit) { radarVis.cockpit = mode === 'cockpit'; radarVis(); }
    if (mode === 'cockpit' || mode === 'hood') {
      const eye = model.eye;
      const local = eye
        ? (mode === 'cockpit' ? new THREE.Vector3(eye.x, eye.y + 0.03, eye.z) : new THREE.Vector3(0, eye.y - 0.02, eye.z + 1.45))
        : (mode === 'cockpit' ? new THREE.Vector3(0.38, 1.38, 0.30) : new THREE.Vector3(0, 1.25, 1.35));
      local.sub(new THREE.Vector3(...car.spec.cg));
      const h = head;
      if (mode === 'cockpit') {
        // the driver's head: lags behind the car's acceleration on the neck. Smooth sand rides smooth (no
        // made-up shake); old tire impressions under the front tires jolt the head, and the rears a wheelbase later
        const sdt = Math.min(dt, 0.05), W = car.wheels;
        if (!camInit) {
          h.prevVel.copy(car.vel); h.acc.set(0, 0, 0); h.off.set(0, 0, 0); h.offV.set(0, 0, 0);
          h.up.set(0, 1, 0).applyQuaternion(car.quat); h.j.set(0, 0, 0); h.jV.set(0, 0, 0); h.echo.length = 0;
          for (const w of W) w.rutJolt = 0;
        }
        _t.copy(car.vel).sub(h.prevVel).divideScalar(Math.max(sdt, 1e-3)); h.prevVel.copy(car.vel);
        _t.applyQuaternion(_qi.copy(car.quat).invert());
        h.acc.lerp(_t, 1 - Math.exp(-sdt * 25));
        const K = 140, C = 2 * Math.sqrt(K) * 0.55;
        _u.copy(h.off).multiplyScalar(-K).addScaledVector(h.offV, -C).addScaledVector(h.acc, -1);
        h.offV.addScaledVector(_u, sdt); h.off.addScaledVector(h.offV, sdt);
        h.off.x = THREE.MathUtils.clamp(h.off.x, -0.07, 0.07); h.off.y = THREE.MathUtils.clamp(h.off.y, -0.06, 0.05); h.off.z = THREE.MathUtils.clamp(h.off.z, -0.07, 0.05);
        // rut jolts (vehicle-physics rutJolt: change of old rut depth + berm ahead of each tire; a dead band drops sand grain noise)
        h.t += sdt;
        const dead = 0.35 * sdt, jl = Math.max(0, (W[0].rutJolt || 0) - dead), jr = Math.max(0, (W[1].rutJolt || 0) - dead);
        for (const w of W) w.rutJolt = 0;
        const ws = car.spec.wheels, wb = Math.abs(ws[0].z - ws[2].z) || 3;
        if (jl + jr > 0) h.echo.push([h.t + wb / Math.max(car.speed, 1), jl * 0.8, jr * 0.8]);
        let el = 0, er = 0;
        while (h.echo.length && h.echo[0][0] <= h.t) { const e = h.echo.shift(); el += e[1]; er += e[2]; }
        if (h.echo.length > 64) h.echo.shift();
        const kl = jl + el, kr = jr + er;
        if (kl + kr > 0) {
          h.jV.y += Math.min(0.8, (kl + kr) * 12);
          h.jV.x += THREE.MathUtils.clamp((kl - kr) * 8, -0.5, 0.5);
          h.jV.z += THREE.MathUtils.clamp((jl + jr - el - er) * 12, -0.6, 0.6); // fronts lift the nose, rears drop it
        }
        // 7 Hz is too stiff for one Euler step at low frame rates (it blew up below ~40 fps): sub-step it
        const JW = 2 * Math.PI * 7, JZ = 0.35, jn = Math.ceil(sdt / 0.004), jdt = sdt / jn;
        for (let i = 0; i < jn; i++) {
          _u.copy(h.j).multiplyScalar(-JW * JW).addScaledVector(h.jV, -2 * JZ * JW);
          h.jV.addScaledVector(_u, jdt); h.j.addScaledVector(h.jV, jdt);
        }
        h.j.clampScalar(-0.03, 0.03);
        local.add(h.off); local.y += h.j.y;
        // gaze stabilisation: the eyes hold the horizon steadier than the chassis over small fast bumps (up lags ~0.1 s);
        // the view still looks straight ahead along the car
        _su.set(0, 1, 0).applyQuaternion(car.quat);
        h.up.lerp(_su, camInit ? 1 - Math.exp(-sdt / 0.1) : 1).normalize();
        _sf.set(0, 0, 1).applyQuaternion(car.quat);
        _su.copy(h.up);
        _sl.crossVectors(_su, _sf).normalize();
        _su.applyAxisAngle(_sl, -h.j.z).applyAxisAngle(_sf, h.j.x);
        _sf.addScaledVector(_su, -_sf.dot(_su)).normalize();
        _sl.crossVectors(_su, _sf);
        _qs.setFromRotationMatrix(_ms.makeBasis(_sl, _su, _sf));
      }
      camera.position.copy(local).applyQuaternion(car.quat).add(car.pos);
      // the driver's seat looks straight ahead over the hood, locked to the car
      const ly = mode === 'cockpit' ? 0 : orbitYaw, qv = mode === 'cockpit' ? _qs : car.quat;
      const look = new THREE.Vector3(Math.sin(ly) * 10, mode === 'cockpit' ? -1.0 : -0.6 - orbitPitch * 4, Math.cos(ly) * 10).applyQuaternion(qv);
      camera.up.set(0, 1, 0).applyQuaternion(qv);
      camera.lookAt(camera.position.clone().add(look));
      camInit = mode === 'cockpit';
      return;
    }
    camera.up.set(0, 1, 0);
    const dist = (mode === 'far' ? 15 : mode === 'side' ? 9 : 8.2) * camDist;
    const height = (mode === 'far' ? 5.5 : mode === 'side' ? 2.2 : 2.9) * camDist + orbitPitch * dist * 0.6;
    const yawC = mode === 'side' ? yaw + Math.PI / 2 : yaw;
    _t.set(car.pos.x - Math.sin(yawC) * dist, car.pos.y + height, car.pos.z - Math.cos(yawC) * dist);
    const gh = terrainData.height(_t.x, _t.z) + 0.8;
    if (_t.y < gh) _t.y = gh;
    if (!camInit) { camPos.copy(_t); camLook.copy(car.pos); camInit = true; }
    const k = 1 - Math.exp(-dt * (mode === 'side' ? 6 : 5));
    camPos.lerp(_t, k);
    camLook.lerp(_u.copy(car.pos).add(new THREE.Vector3(0, 0.6, 0)).addScaledVector(car.vel, 0.05), 1 - Math.exp(-dt * 12));
    camera.position.copy(camPos);
    const g2 = terrainData.height(camPos.x, camPos.z) + 0.5;
    if (camera.position.y < g2) camera.position.y = g2;
    camera.lookAt(camLook);
  }

  // ---------- tracks ----------
  const prevContact = [null, null, null, null];
  const prevDist = [0, 0, 0, 0];
  const pens = [new TrackPen(), new TrackPen(), new TrackPen(), new TrackPen()];
  const _rec = new Float32Array(REC);
  // pen: our own cars log their ruts for 48 h (other players log their own)
  function stampWheel(idx, contact, fwd, sink, surf, vLat, onGround, front, dist, prev, prevD, halfW, pen, hill = 0) {
    if (!onGround) { if (pen) { const r = pen.lift(); if (r) tlog.addOwn(r); } return false; }
    let x0 = contact.x, z0 = contact.z, d0 = dist;
    if (prev && Math.hypot(prev.x - contact.x, prev.z - contact.z) < 4) { x0 = prev.x; z0 = prev.z; d0 = prevD; }
    const slip = Math.min(1, Math.max(0, (Math.abs(surf) - 0.6) / 3));
    const turnDig = Math.min(0.05, Math.abs(vLat) * 0.012);
    const soft = 1 + 0.5 * hill; // loose sand on dune faces takes deeper prints
    const r = _rec;
    r[0] = x0; r[1] = z0; r[2] = contact.x; r[3] = contact.z;
    r[4] = halfW; r[5] = (front ? 0.12 : 0.20) * soft;
    r[6] = (front ? 0.03 : 0.045) + sink * 1.25 * soft + turnDig + slip * 0.05;
    r[7] = 0.02 + (sink + turnDig) * 0.5 * soft + slip * 0.03;
    r[8] = d0; r[9] = dist;
    r[10] = front ? 0.012 : 0.025 + slip * 0.03; r[11] = slip; r[12] = front ? 1 : 0;
    r[13] = front ? Math.min(1, 0.25 + Math.abs(vLat) * 0.08) : Math.min(1, 0.35 + slip);
    r[14] = sink; r[15] = 0;
    for (const d of deforms) if (d.inWindow(contact.x, contact.z)) d.stamp(r);
    if (pen) { const out = pen.feed(r, pen === pens[idx] ? 1.0 : 1.5); if (out) tlog.addOwn(out); }
    return true;
  }

  // ---------- teleport to famous Glamis spots ----------
  let tpIndex = -1;
  const H = (x, z) => terrainData.height(x, z);
  function teleportPose(p) {
    if (p.kind === 'start') return { x: SPAWN.x, z: SPAWN.z, yaw: bestYaw };
    const c = placeXZ(p, terrainData.meta);
    if (p.kind === 'hill') {
      // the summit near the landmark, then down its steepest face to the bottom of the climb
      let top = c, th = -1e9;
      for (let j = -30; j <= 30; j++) for (let i = -30; i <= 30; i++) {
        if (i * i + j * j > 900) continue;
        const x = c.x + i * 10, z = c.z + j * 10, h = H(x, z);
        if (h > th) { th = h; top = { x, z }; }
      }
      let best = null;
      for (let a = 0; a < 24; a++) {
        const dx = Math.sin(a / 24 * Math.PI * 2), dz = Math.cos(a / 24 * Math.PI * 2);
        // walk downhill until the slope flattens out
        let d = 10, prev = th;
        for (; d < 400; d += 5) { const h = H(top.x + dx * d, top.z + dz * d); if (prev - h < 5 * 0.08) break; prev = h; }
        const drop = th - prev;
        if (!best || drop > best.drop) best = { drop, x: top.x + dx * (d + 15), z: top.z + dz * (d + 15), dx, dz };
      }
      return { x: best.x, z: best.z, yaw: Math.atan2(-best.dx, -best.dz) };
    }
    if (p.kind === 'bowl') {
      let lo = c, lh = 1e9;
      for (let j = -20; j <= 20; j++) for (let i = -20; i <= 20; i++) {
        if (i * i + j * j > 400) continue;
        const x = c.x + i * 10, z = c.z + j * 10, h = H(x, z);
        if (h < lh) { lh = h; lo = { x, z }; }
      }
      // face the tallest wall of the bowl
      let ya = 0, hb = -1e9;
      for (let a = 0; a < 24; a++) { const yaw = a / 24 * Math.PI * 2, h = H(lo.x + Math.sin(yaw) * 70, lo.z + Math.cos(yaw) * 70); if (h > hb) { hb = h; ya = yaw; } }
      return { x: lo.x, z: lo.z, yaw: ya };
    }
    // camp: park on it, facing the dunes (the highest ground nearby)
    let ya = 0, hb = -1e9;
    for (let a = 0; a < 24; a++) { const yaw = a / 24 * Math.PI * 2, h = H(c.x + Math.sin(yaw) * 200, c.z + Math.cos(yaw) * 200); if (h > hb) { hb = h; ya = yaw; } }
    return { x: c.x, z: c.z, yaw: ya };
  }
  function teleport(id) {
    const p = PLACES.find(q => q.id === id); if (!p) return;
    tpIndex = PLACES.indexOf(p);
    const t = teleportPose(p);
    car.reset(t.x, t.z, t.yaw);
    for (let i = 0; i < 4; i++) { prevContact[i] = null; const r = pens[i].lift(); if (r) tlog.addOwn(r); }
    // bring the computer sandrails along
    for (const b of bots) { b.spawnNear(t.x, t.z, 80, 400); b.prevContact = [null, null, null, null]; for (const pn of b.pens) pn.lift(); }
    camInit = false;
    menu.toggle(false);
    toast(p.name);
  }

  // ---------- lights ----------
  function setLights(on) {
    lightsOn = on;
    model.lights?.setOn(on); model.setLamps?.(on);
    for (const b of bots) { b.model.lights?.setOn(on); b.model.setLamps?.(on); } // computer sandrails follow yours
  }
  const _lp = new THREE.Vector3(), _ld = new THREE.Vector3(), _wind = new THREE.Vector3(), _rv = new THREE.Vector3();
  const BAR_C = new THREE.Color(1.0, 0.96, 0.9), _wc = new THREE.Color();
  // light the sand: light bars of the nearest cars, whip glow of the closest few
  function updateCarLights(dt, list) {
    _wind.set(Math.sin(weather.windDir), 0, Math.cos(weather.windDir)).multiplyScalar(weather.windSpeed);
    for (const it of list) it.model.lights?.update(dt, it.vel, it.model.root.quaternion, it.d, _wind, it.rough || 0);
    const U = terrain.uniforms;
    let n = 0;
    // in daylight the sun drowns the LEDs out; they show at dusk and at night
    const dark = settings.night ? 1 : Math.max(0.03, Math.min(1, (0.25 - sunDir.y) / 0.25));
    const lit = list.filter(it => it.model.lights?.on).sort((a, b) => a.d - b.d);
    for (const it of lit) {
      if (n >= 10) break;
      it.model.lights.barWorld(_lp, _ld);
      U.uLP.value[n].set(_lp.x, _lp.y, _lp.z, 1100 * dark);
      U.uLD.value[n].set(_ld.x, _ld.y, _ld.z, 1);
      U.uLC.value[n].set(BAR_C.r, BAR_C.g, BAR_C.b);
      n++;
    }
    for (const it of lit) {
      if (n >= 16 || it.d > 120) break;
      for (let i = 0; i < 2 && n < 16; i++) {
        it.model.lights.whipWorld(i, _lp);
        U.uLP.value[n].set(_lp.x, _lp.y, _lp.z, 1.6 * dark);
        U.uLD.value[n].set(0, 0, 0, 0);
        _wc.set(0xffffff).lerp(it.model.lights.color, 0.3);
        U.uLC.value[n].set(_wc.r, _wc.g, _wc.b);
        n++;
      }
    }
    U.uLN.value = n; particles.uniforms.uLN.value = n;
  }

  // ---------- HUD ----------
  const audio = new EngineAudio();
  let toastTimer = 0;
  function toast(t) { const el = $('toast'); el.textContent = t; el.style.opacity = 1; toastTimer = 2.2; }
  $('gpu').textContent = `${gpuName} · ${qName.toUpperCase()} quality`;
  // the nearest bot's engine (uses assets/audio/nearby.* once that file exists); remote players
  // could get the same voice from the nearest r.buf state in the remote-cars loop
  // the two nearest other cars (computer riders or players) are heard in 3D around the camera
  const otherVoices = [new EngineAudio({ nearby: true, spatial: true }), new EngineAudio({ nearby: true, spatial: true })];
  const botAudio = otherVoices[0];
  audio.setVolume(settings.volume); for (const v of otherVoices) v.setVolume(0);
  window.__audio = { player: audio, bot: botAudio, others: otherVoices }; // tests: __audio.player.debug()
  // the engine sound follows the driver's pedal, not throttleEff: wheelie control and steering
  // priority trim the engine torque all the time, and the recording should not drop out while W is held
  const pedal = (c) => c.gear === -1 && c.autoTrans ? c.input.brake : c.input.throttle;
  const _audioStart = audio.start.bind(audio);
  audio.start = () => { _audioStart(); for (const v of otherVoices) v.start(); };

  // the HUD minimap is hidden in the cockpit view (it would cover the chart plotter and the right
  // mirror; the DuneNav screen in the dash shows the map there)
  // optional: in the cockpit of a car with a live chart plotter (DuneNav) show the radar only on that screen
  function radarOnDash() { return !!(settings.radarCockpit === 'dash' && radarVis.cockpit && model?.live?.screens?.lowrance); }
  function radarVis() { $('radarwrap').classList.toggle('hidden', !settings.radar || radarOnDash()); }

  // ---------- menu (M) ----------
  status('Drawing radar map...');
  const radar = new Radar($('radar'), terrainData);
  radar.range = settings.radarRange;
  function applySetting(key, v) {
    switch (key) {
      case 'autoTrans': car.autoTrans = v; if (v && car.gear < 1) car.gear = 1; break;
      case 'wheelieControl': car.wheelieControl = v; break;
      case 'steerAssist': car.steerAssist = v; break;
      case 'camMode': camMode = v; camInit = false; break;
      case 'volume': audio.setVolume(v); break;
      case 'quality': {
        const u = new URL(location.href); u.searchParams.delete('q'); location.href = u.toString(); break;
      }
      case 'renderer': {
        const u = new URL(location.href); u.searchParams.delete('renderer'); location.href = u.toString(); break;
      }
      case 'renderScale': renderer.setPixelRatio(Q.pixelRatio * v); renderer.setSize(innerWidth, innerHeight); post.setSize(innerWidth, innerHeight); break;
      case 'bloom': case 'heatHaze': case 'colorGrade': applyPost(); break;
      case 'scenery': scenery.setEnabled(v !== false); break;
      case 'shadows': applyShadows(v); break;
      case 'particles': particles.emitScale = v; break;
      case 'weather': weather.set(v); setSun(timeOfDay); break;
      case 'tod': timeOfDay = v; setSun(v); break;
      case 'night': setSun(timeOfDay); setLights(!!v); break;
      case 'wind': weather.windScale = v; weather.applyWind(); break;
      case 'aiCount': setBotCount(v); break;
      case 'car': {
        const go = () => { if (settings.car !== v) return; switchCar(v); setBotCount(0); setBotCount(settings.aiCount); };
        if (!CARS[v] || templates[v]) go();
        else { toast('Loading ' + CARS[v].label + '...'); ensureCar(v, (f) => toast(`Loading ${CARS[v].label}... ${Math.round(f * 100)}%`)).then(go); }
        break;
      }
      case 'gravity': car.gravity = v; for (const b of bots) b.car.gravity = v; particles.gravity = v; break;
      case 'sandTex': applySandTex(v); break;
      case 'softness': car.softness = v; for (const b of bots) b.car.softness = v; break;
      case 'grip': car.grip = v; for (const b of bots) b.car.grip = v; break;
      case 'aiSkill': for (const b of bots) b.skill = v; break;
      case 'radar': case 'radarCockpit': radarVis(); break;
      case 'liveMirrors': model.live?.setMirrorsLive(v); break;
      case 'radarRange': radar.range = v; break;
      case 'showHelp': $('help').classList.toggle('hidden', !v); break;
    }
  }
  // change from a hotkey: apply, save and keep the menu in sync
  // shared settings go to the server, which passes them to every player
  function shareSetting(key, v) { if (GLOBAL_KEYS.includes(key)) net.sendSetting(key, v); }
  function setSetting(key, v) { settings[key] = v; saveSettings(settings); applySetting(key, v); menu.refresh(key); shareSetting(key, v); }
  // a setting someone else changed (or the world's settings when we join)
  function remoteSetting(key, v, who) {
    if (!GLOBAL_KEYS.includes(key) || settings[key] === v) return;
    settings[key] = v; saveSettings(settings); applySetting(key, v); menu.refresh(key);
    if (who) {
      const it = SCHEMA.flatMap(t => t.items).find(i => i.key === key);
      const shown = it?.type === 'choice' ? it.options.find(o => o[0] === v)?.[1] : it?.fmt ? it.fmt(v) : v;
      toast(`${who} set ${it?.label?.toLowerCase() || key}: ${shown}`);
    }
  }
  netRemoteSetting = remoteSetting;
  if (pendingWorld) { for (const [k, v] of Object.entries(pendingWorld)) remoteSetting(k, v, null); pendingWorld = null; }
  const menu = new Menu($('menu'), settings, (key, v) => { applySetting(key, v); shareSetting(key, v); });
  binds = menu.bindings;
  renderHelp();
  menu.onBindings = renderHelp;
  menu.onAction = (key, id) => { if (key === 'tp') teleport(id); else if (key === 'rec') { menu.toggle(false); toggleRecording(); } };
  for (const k of ['gravity', 'grip', 'softness']) applySetting(k, settings[k]);
  applySetting('radar', settings.radar);
  applySetting('showHelp', settings.showHelp);

  // ---------- loop ----------
  status('Ready');
  $('loading').classList.add('done');
  setTimeout(() => $('loading').remove(), 1200);
  let lastT = performance.now();
  let fpsAcc = 0, fpsN = 0;
  const tmpV = new THREE.Vector3(), tmpS = new THREE.Vector3();
  const upW = new THREE.Vector3();
  const remoteTmp = { hub: new THREE.Vector3() };
  const _carsXZ = []; let expireT = 0; const _lightList = [];

  const dayLight = () => (settings.night ? 0 : Math.min(1, sun.intensity / SUN_I));
  function frame() {
    const nowT = performance.now();
    const dt = Math.min((nowT - lastT) / 1000, 0.05);
    lastT = nowT;
    readInput(dt);
    car.update(dt);
    // rolled over or stuck on its side: put it back on its wheels after a moment
    {
      const upY = _upChk.set(0, 1, 0).applyQuaternion(car.quat).y;
      if (upY < 0.35 && car.speed < 3) flipT += dt; else flipT = 0;
      if (flipT > 2.5) {
        const f = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quat);
        car.reset(car.pos.x, car.pos.z, Math.atan2(f.x, f.z));
        flipT = 0; toast('Flipped back onto your wheels (R does it any time)');
      }
    }
    const st = car.getState();

    model.root.position.copy(car.pos);
    model.root.quaternion.copy(car.quat);
    model.update(st.w, car.steerAngle);

    updateCamera(dt);
    deform.follow(car.pos.x, car.pos.z);
    if (deform.center) terrain.uniforms.uDeformInfo.value.set(deform.center.x, deform.center.y, deform.W, 1);
    deformFar.follow(car.pos.x, car.pos.z);
    if (deformFar.center) terrain.uniforms.uDeformInfo2.value.set(deformFar.center.x, deformFar.center.y, deformFar.W, 1);

    // local wheels: tracks + roost
    upW.set(1, 0, 0).applyQuaternion(car.quat);
    let roostAmt = 0;
    car.wheels.forEach((w, i) => {
      if (stampWheel(i, w.contact, w.fwdW, w.sink, w.surfSpeed, w.vLat, w.onGround, w.front, w.trackDist, prevContact[i], prevDist[i], w.w * 0.5 * 0.92, pens[i], w.hill || 0)) {
        prevContact[i] = (prevContact[i] || new THREE.Vector3()).copy(w.contact); prevDist[i] = w.trackDist;
      } else prevContact[i] = null;
      if (w.onGround) {
        particles.emitWheel(dt, w.contact, w.fwdW, upW, car.vel, w.front ? 0 : w.surfSpeed, w.vLat, !w.front, w.contact.y);
        if (!w.front) roostAmt += Math.abs(w.surfSpeed);
      }
    });

    // computer sandrails
    let nearBot = null, nearD = 1e9;
    for (const b of bots) {
      b.update(dt, car);
      const bc = b.car, bst = bc.getState();
      b.model.root.position.copy(bc.pos);
      b.model.root.quaternion.copy(bc.quat);
      b.model.update(bst.w, bc.steerAngle);
      const dCam = camera.position.distanceTo(bc.pos);
      if (dCam < nearD) { nearD = dCam; nearBot = b; }
      tmpS.set(1, 0, 0).applyQuaternion(bc.quat);
      bc.wheels.forEach((w, i) => {
        if (stampWheel(i, w.contact, w.fwdW, w.sink, w.surfSpeed, w.vLat, w.onGround, w.front, w.trackDist, b.prevContact[i], b.prevDist[i], w.w * 0.5 * 0.92, b.pens[i], w.hill || 0)) {
          b.prevContact[i] = (b.prevContact[i] || new THREE.Vector3()).copy(w.contact); b.prevDist[i] = w.trackDist;
        } else b.prevContact[i] = null;
        if (w.onGround && dCam < 450) particles.emitWheel(dt, w.contact, w.fwdW, tmpS, bc.vel, w.front ? 0 : w.surfSpeed, w.vLat, !w.front, w.contact.y);
      });
      placeLabel(b.label, bc.pos, settings.labels && dCam < Math.min(450, 1.3 / scene.fog.density), `${b.name} · ${Math.round(dCam)} m`);
    }
    if (bots.length) resolveCarContacts([car, ...bots.map(b => b.car)], dt);
    // engines of the two nearest other cars, placed where they are (the panner does the distance)
    {
      const cands = [];
      for (const b of bots) cands.push({ d: camera.position.distanceTo(b.car.pos), p: b.car.pos, rpm: b.car.rpm, thr: pedal(b.car) });
      for (const r of remotes.values()) { const s = r.buf.length ? r.buf[r.buf.length - 1].s : null; if (s) cands.push({ d: camera.position.distanceTo(r.model.root.position), p: r.model.root.position, rpm: s.rpm || 1000, thr: s.thr || 0 }); }
      cands.sort((a, b) => a.d - b.d);
      otherVoices.forEach((v, i) => {
        if (!v.enabled) return;
        const c = cands[i];
        if (!c || c.d > 600) { v.setVolume(0); return; }
        v.setVolume(settings.volume * 0.9);
        v.setPosition(c.p);
        v.update(c.rpm, c.thr, 0, 0);
      });
      _lf.set(0, 0, -1).applyQuaternion(camera.quaternion); _lu.set(0, 1, 0).applyQuaternion(camera.quaternion);
      setListener(camera.position, _lf, _lu);
    }
    weather.update(dt, camera, terrainData);
    sky.material.uniforms.time.value = nowT / 1000;

    // remote cars
    const now = performance.now();
    for (const [id, r] of remotes) updateRemote(r, now, dt);

    // light bars and whips
    {
      const list = _lightList; list.length = 0;
      let rough = 0; for (const w of car.wheels) rough += Math.abs(w.compVel || 0);
      list.push({ model, vel: car.vel, d: camera.position.distanceTo(car.pos), rough: Math.min(400, rough * 60) });
      for (const b of bots) list.push({ model: b.model, vel: b.car.vel, d: camera.position.distanceTo(b.car.pos), rough: 0 });
      for (const r of remotes.values()) {
        const sb = r.buf[r.buf.length - 1]?.s;
        if (sb) { r.model.lights?.setOn(!!sb.lt); r.vel = (r.vel || new THREE.Vector3()).set(...sb.v); }
        list.push({ model: r.model, vel: r.vel || _rv, d: camera.position.distanceTo(r.model.root.position), rough: 0 });
      }
      updateCarLights(dt, list);
    }
    nightSky.position.copy(camera.position);
    nightSky.material.uniforms.uTime.value = nowT / 1000;

    // 48-hour track log: load stored tracks around our cars, press them into the rut grid
    _carsXZ.length = 0; _carsXZ.push(car.pos); for (const b of bots) _carsXZ.push(b.car.pos);
    tlog.update(dt, _carsXZ);
    let rasterBudget = 2;
    for (const t of tlog.tiles.values()) {
      if (rasterBudget <= 0) break;
      if (t.state !== 2 || t.raster) continue;
      const cx = (t.tx + 0.5) * TILE, cz = (t.tz + 0.5) * TILE;
      if (!_carsXZ.some(p => Math.abs(p.x - cx) < 260 && Math.abs(p.z - cz) < 260)) continue;
      for (let i = 0; i < t.n; i++) ruts.stampSeg(t.a, i * REC);
      t.raster = true; rasterBudget--;
    }
    expireT += dt;
    if (expireT > 300) { expireT = 0; if (tlog.expire()) { deform._clearAll = true; deformFar._clearAll = true; ruts.chunks.clear(); for (const t of tlog.tiles.values()) t.raster = false; } }
    deform.flush();
    deformFar.flush();
    particles.update(dt, camera);

    // shadows follow the car
    sun.position.copy(car.pos).addScaledVector(sunDir, 500);
    sun.target.position.copy(car.pos);
    // keep shadow texels stable (snap to texel grid in light space)
    // (the camera was moved this frame but its world matrix is only rebuilt inside render(): without this the
    // terrain patches were frustum culled with last frame's view, so at speed, turning or over bumps the sand at
    // the edges of the driver's view was missing for a frame and popped in late)
    camera.updateMatrixWorld();
    terrain.update(camera);

    // landings and big suspension hits thump, gear changes clunk, flying sand patters on the body
    let hit = 0;
    car.wheels.forEach((w, i) => {
      const dc = (w.comp - (prevComp[i] ?? w.comp)) / Math.max(dt, 1e-3); prevComp[i] = w.comp;
      if (w.onGround && !prevGround[i] && airT > 0.25) hit = Math.max(hit, Math.min(1, airT * 0.6 + Math.abs(car.vel.y) * 0.08));
      if (dc > 2.5) hit = Math.max(hit, Math.min(0.7, (dc - 2.5) * 0.12));
      prevGround[i] = w.onGround;
    });
    airT = car.wheels.some(w => w.onGround) ? 0 : airT + dt;
    thumpT -= dt;
    if (hit > 0.08 && thumpT <= 0) { audio.thump(hit); thumpT = 0.14; }
    if (car.gear !== lastGear) { if (car.gear >= 1 && lastGear >= 1) audio.shiftClunk(car.gear > lastGear); lastGear = car.gear; }
    const slideAmt = car.wheels.reduce((a, w) => a + (w.onGround ? Math.max(0, Math.abs(w.vLat) - 2) : 0), 0);
    audio.update(car.rpm, pedal(car), roostAmt * 0.5, car.speed, Math.min(1, roostAmt / 40 + slideAmt / 25), settings.wind ?? 1);
    net.update(dt, () => { const st = car.getState(); st.lt = lightsOn; return st; });

    // HUD
    const mph = Math.abs(car.forwardSpeed) * 2.23694;
    $('speed').textContent = Math.round(mph);
    $('gear').textContent = (car.gear === -1 ? 'R' : car.gear === 0 ? 'N' : car.gear) + (car.autoTrans ? '' : 'M');
    $('rpmbar').style.width = Math.min(100, car.rpm / 7500 * 100) + '%';
    $('rpmbar').style.background = car.rpm > 7000 ? '#ff3b30' : '#ffb000';
    $('rpm').textContent = Math.round(car.rpm / 10) * 10;
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { $('fps').textContent = Math.round(fpsN / fpsAcc) + ' fps'; fpsAcc = 0; fpsN = 0; }
    if (settings.radar && !radarOnDash() && (fpsN & 1) === 0) {
      _f.set(0, 0, 1).applyQuaternion(car.quat);
      const blips = bots.map(b => ({ x: b.car.pos.x, z: b.car.pos.z, color: '#' + new THREE.Color(b.tint).getHexString(), kind: 'bot' }));
      for (const r of remotes.values()) blips.push({ x: r.model.root.position.x, z: r.model.root.position.z, color: '#7cf', kind: 'player' });
      radar.draw({ x: car.pos.x, z: car.pos.z, fx: _f.x, fz: _f.z }, blips);
      const inRange = blips.filter(b => Math.hypot(b.x - car.pos.x, b.z - car.pos.z) <= radar.range).length;
      $('radarinfo').textContent = `${inRange} of ${blips.length} in range · ${radar.range >= 1000 ? radar.range / 1000 + ' km' : radar.range + ' m'}`;
    }
    if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $('toast').style.opacity = 0; }

    if (model.live) {
      _f.set(0, 0, 1).applyQuaternion(car.quat);
      model.live.update({ dt, speed: car.forwardSpeed, gear: car.gear, rpm: car.rpm, throttle: car.throttleEff || 0, pos: car.pos, fwd: _f, tod: settings.night ? 22 : timeOfDay, day: dayLight(), cockpit: radarVis.cockpit });
      if (radarVis.cockpit) model.live.renderMirrors(renderer, scene, camera);
    }
    scenery.update(dt, camera.position, light.night);
    post.render(dt, light, car.forwardSpeed, CAM_MODES[camMode] === 'cockpit');
    if (params.has('shot')) window.__frames = (window.__frames || 0) + 1;
    requestAnimationFrame(frame);
  }

  const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  function updateRemote(r, now, dt) {
    const T = now - 120; // render 120 ms in the past for smooth interpolation
    const b = r.buf;
    if (!b.length) return;
    while (b.length > 2 && b[1].t <= T) b.shift();
    let a = b[0], c = b[1] || b[0];
    const u = c === a ? 0 : Math.min(1, Math.max(0, (T - a.t) / (c.t - a.t)));
    const sa = a.s, sb = c.s;
    const p = r.model.root.position.set(
      sa.p[0] + (sb.p[0] - sa.p[0]) * u, sa.p[1] + (sb.p[1] - sa.p[1]) * u, sa.p[2] + (sb.p[2] - sa.p[2]) * u);
    _q1.set(...sa.q); _q2.set(...sb.q);
    r.model.root.quaternion.copy(_q1).slerp(_q2, u);
    const ws = sa.w.map((wa, i) => wa.map((v, j) => j === 1 ? v + angDiff(v, sb.w[i][1]) * u : v + (sb.w[i][j] - v) * u));
    r.model.update(ws, 0);
    // label
    placeLabel(r.label, p, settings.labels, r.name);
    // remote tracks + roost
    const vel = new THREE.Vector3(...sb.v);
    const left = new THREE.Vector3(1, 0, 0).applyQuaternion(r.model.root.quaternion);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(r.model.root.quaternion);
    r.model.wheelRigs.forEach((rig, i) => {
      const wsI = ws[i];
      const hub = rig.hub.getWorldPosition(remoteTmp.hub);
      const gy = terrainData.height(hub.x, hub.z);
      const onGround = wsI[4] > 0.5 && hub.y - rig.spec.r < gy + 0.25;
      const contact = new THREE.Vector3(hub.x, gy - wsI[3], hub.z);
      const wf = fwd.clone().multiplyScalar(Math.cos(wsI[2])).addScaledVector(left, Math.sin(wsI[2]));
      r.dist[i] += Math.abs(wsI[7]) * dt;
      if (onGround) { const hl = Math.hypot(wf.x, wf.z) || 1; tracksFor(terrainData).stamp(contact.x, contact.z, wf.x / hl, wf.z / hl, rig.spec.w * 0.46, 0.15, wsI[3], 0.01 + 0.45 * wsI[3]); }
      if (stampWheel(i, contact, wf, wsI[3], wsI[5], 0, onGround, rig.spec.front, r.dist[i], r.prevContacts[i], r.prevD?.[i] ?? 0, rig.spec.w * 0.46)) {
        r.prevContacts[i] = contact; (r.prevD ||= [0, 0, 0, 0])[i] = r.dist[i];
      } else r.prevContacts[i] = null;
      if (onGround && camera.position.distanceTo(contact) < 400) particles.emitWheel(dt, contact, wf, left, vel, rig.spec.front ? 0 : wsI[5], 0, !rig.spec.front, gy);
    });
  }
  function placeLabel(label, p, show, text) {
    tmpV.copy(p); tmpV.y += 2.2; tmpV.project(camera);
    const vis = show && tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.1;
    label.style.display = vis ? 'block' : 'none';
    if (!vis) return;
    if (label.textContent !== text) label.textContent = text;
    label.style.transform = `translate(${(tmpV.x * 0.5 + 0.5) * innerWidth}px, ${(-tmpV.y * 0.5 + 0.5) * innerHeight}px)`;
  }
  function angDiff(a, b) { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    post.setSize(innerWidth, innerHeight);
  });
  // test hooks
  window.__game = { teleport, get car() { return car; }, get model() { return model; }, tlog, ruts, templates, bots, menu, settings, setSetting, weather, radar, camera, renderer, scene, terrain, deform, particles, setSun, input, keys, sun, sky, hemi, sunDir, setCam: (m) => { camMode = m; }, setOrbit: (y, p, d) => { orbitYaw = y; orbitPitch = p; camDist = d; camInit = false; } };
  frame();
}

main().catch((e) => { console.error(e); status('Error: ' + e.message); });
