// Sandrails built in Blender (assets/*/sandcar.glb) and the Trax rail (Godot export).
// Loads each .glb once, clones it per car, and poses wheels, suspension links,
// shocks and the steering wheel from the physics state every frame. Also builds a
// physics spec that matches each model's real wheel positions and tire sizes.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SANDRAIL_SPEC } from './vehicle-physics.js';

// family 'sandcar': glTF axes (+X right, -Z forward), rigged with Link_*/Shock_* nodes + physics.json
// family 'trax':    Godot axes (+X left, +Z forward), rigged with Arm*/Shock*/HP_* nodes
export const CARS = {
  flamerail: { label: 'Flame rail (red)', file: 'assets/flamerail/sandcar.glb', family: 'sandcar', color: '#c0141a' },
  black: { label: 'Black', file: 'assets/black_sandrail/sandcar.glb', family: 'sandcar', color: '#202020' },
  blue: { label: 'Blue', file: 'assets/blue__sandrail/sandcar.glb', family: 'sandcar', color: '#2f6fe0' },
  green: { label: 'Green', file: 'assets/green__sandrail/sandcar.glb', family: 'sandcar', color: '#39b54a' },
  silver: { label: 'Silver', file: 'assets/silver_sandrail/sandcar.glb', family: 'sandcar', color: '#c8ccd2' },
  yellow: { label: 'Yellow', file: 'assets/yellow_sandrail/sandcar.glb', family: 'sandcar', color: '#e8c060' },
  trax: { label: 'Trax (green)', file: 'assets/trax_sandrail/sandrail.glb', family: 'trax', color: '#5fe04a', heavy: true },
  // keepRoll: anti-roll bars retuned so the narrower real track (1.84 / 1.93 m) keeps the roll stiffness
  // the physics was tuned with (base track 2.04 / 2.00 m), and the CG lowered in proportion to the narrower
  // track / shorter wheelbase so the car is no easier to tip or wheelie than the tuned one.
  // stretchFront: move the front wheels, front suspension and nose forward by this much (m); see stretchFront below
  // sightNotch: lower the bodywork in the driver's sightlines to the front tyre tops (see sightNotch below)
  // maxSteerVis: visual cap (rad) of a front wheel's
  // steer when its suspension is compressed: at full lock (inner wheel 0.62 rad) and full bump the tyre would
  // touch the nose by ~9 mm; at ride height it clears by 36 mm, so the cap fades in from 5 to 20 cm of bump
  pro: { label: 'GLX pro (orange)', file: 'assets/pro_sandrail/sandcar.glb', family: 'sandcar', color: '#ff5a0d', look: 'trx', heavy: true, keepRoll: true, maxSteerVis: 0.52, sightNotch: true, stretchFront: 0.25 },
  // an earlier GLX pro build (assets/pro_sandrail2), same sandcar contract, added for side-by-side testing
  pro2: { label: 'GLX pro 2 (orange)', file: 'assets/pro_sandrail2/sandcar.glb', family: 'sandcar', color: '#ff7a2d', heavy: true, keepRoll: true, sightNotch: true },
};

// ---------- look: baked ambient occlusion + per-car material tuning ----------
// A model baked by trx-build/tools/bake_ao.py carries a per-vertex `_AO` attribute (three.js: `_ao`,
// 0 = enclosed .. 1 = open sky). It darkens the indirect light only (hemisphere + environment diffuse,
// environment and clearcoat reflections), like an aoMap, so the cockpit, wheel wells and engine bay
// stop glowing with sky light. Direct sun is left to the shadow map. Models without it are untouched.
// LOOKS: per-car material overrides by glTF material name (colours are sRGB hex). `env` scales the
// environment reflections of the base layer, `coat` those of the clear coat (defaults to `env`), `amb`
// the indirect diffuse light (hemisphere + environment), `envSat` / `ambSat` desaturate them (1 = sky
// blue as is, 0 = grey), `ao` = baked AO strength, `direct` lets the AO also take a little of the direct
// light in deep cavities (the low-res sun shadow map leaks light into the cockpit). Material values
// multiply the car-wide ones. `tint` [r, g, b] and `lift` (emissive, daylight only) act on the saturated
// orange texels of a material only: ACES turns sunlit #ff5a0d brick red and shaded orange rust brown,
// this brings back the vivid orange of the photos without touching the black / grey parts of a decal.
// `cabin`: a warm fill light in the cockpit (glTF frame of the model), evaluated in the car's shaders
// only (a THREE.PointLight there would also light the sand under the car); a material's `cabin`
// scales how much of it that material takes. `cabin2`: a second, weaker fill (a material's `cabin2`, default its
// `cabin`). `nightCabin`: the dim lamp that takes the first one's place (position, colour, range blended over) as
// the daylight goes, so the wheel and the dash do not go black at night; the second one fades out with the daylight. `nodes`: overrides for one
// node's meshes (its materials are cloned). `lamps`: emissive intensity of the lamp lenses with the car
// lights on (night); they stay dark by day. A lamp given as { glow, i } lights the whole lens in that colour at
// radiance i instead of its emissive map (LED dot maps: ~1 % lit texels average out to nothing past a few metres).
// ORANGE: measured in game (ACES 0.53) the livery sides read (150,45,15) median / (221,83,30) at best;
// this takes them to about (185,50,18) / (240,95,35) - the sunlit target of the photos is (240,85,10)
const ORANGE = { tint: [1.6, 1.4, 1.0], lift: 0.12 };
const COCKPIT = { amb: 3.0, ao: 0.6, direct: 0.2 };
export const LOOKS = {
  trx: {
    ao: 1.0, amb: 0.8, env: 0.8, envSat: 0.3, ambSat: 0.45, direct: 0.35,
    // (r5: neutral fill - the warm 0xffe2c4 turned the gunmetal centre post and A-pillar feet ivory)
    // glTF [0, .70, -.60] = Blender (0, .60, .70): low and ahead of the dash face (y .48-.52) - it draws the lit side and
    // the highlight of the cockpit tubes and the sheen of the door quilting, but cannot reach the rear-facing dash faces
    // (r6: moving it between the seats lit the centre stack but flattened the tubes: centre post lit / shade 100 / 52 ->
    // 57 / 48, streak 166 -> 69)
    cabin: { pos: [0, 0.70, -0.60], color: 0xf2f0ec, intensity: 3.0, distance: 1.6 },
    // (r6) between the seats at shoulder height, Blender (0, -.05, 1.12): lights the rear-facing dash faces (radio,
    // keypad, DCX plate, stereo - RGB 0 before), the belts and the seat fronts
    cabin2: { pos: [0, 1.12, 0.05], color: 0xf2f0ec, intensity: 1.2, distance: 1.6 },
    // (r6) at night (or dusk, daylight < .2) a dim cool map lamp under the roof above the wheel, Blender (-.30, .25, 1.38)
    // (wheel centre (-.36, .30, .955), eye (-.36, -.25, 1.255)): the wheel rim, spokes and dash brow stay readable
    // instead of going black round the lit screens. (At the dash face, Blender (-.15, .45, 1.0), it lit only the
    // wheel's front: rim / spokes / brow L 0)
    nightCabin: { pos: [-0.30, 1.38, -0.25], color: 0x9fb8ff, intensity: 2.0, distance: 1.4 },
    mats: {
      // gunmetal tubes: medium grey in the sun with long sky streaks, still grey (not black) under the
      // roof where they only get bounce light - so less occluded than the glTF material; the cockpit tubes
      // take extra cabin fill (the rear tubes are out of its range, so the outside look is unchanged)
      // (r4: the glTF carries the photo grey #7d8187 / #8a8e94 now - no colour override; a little rougher and
      // less metallic than the glTF so the sky draws soft streaks, not mirror lines)
      // (after r4: the photos' cage is dark charcoal gunmetal - tube bodies sRGB ~20-60 with grey highlights - darker
      // than the bare arms and bumper; the r4 look read light silver outside and ivory in the cockpit)
      // (r5: roughness .32 so the sky draws a crisp streak along each tube as in the photos. The glTF carries #484b50 /
      // #868a92, metallic .6, rough .25 and a .6 / .5 clear coat. Measured at the 78 deg cockpit view (game_r5c): amb
      // 1.3 / cabin 1.0 left the tubes' shade side at L 25-37 (near black); amb 3 / cabin 1.3 gave lit side L 95-115
      // (B >= R), shade side 38-51, streaks 170-185 (3.4: a little more on the shade side) - and from the chase cam the
      // cage (L ~50) stays half as bright as the arms (~96). 'Arm gunmetal' keeps its lighter albedo - arms,
      // uprights and (r5) the front / rear bumper tubes)
      // (r6) cabin2: 0 - the second fill sits right under the roof tube above the eye and lit its underside into a
      // fluorescent-tube streak across the top of the 78 deg view (L 25 -> 148, max 247)
      'Cage gunmetal': { color: 0x45484d, metalness: 0.55, roughness: 0.32, env: 0.7, envSat: 0.12, amb: 3.4, ambSat: 0.15, ao: 0.3, cabin: 1.3, cabin2: 0 },
      'Arm gunmetal': { metalness: 0.5, roughness: 0.32, env: 0.8, envSat: 0.12, amb: 1.4, ambSat: 0.15, ao: 0.35 },
      'Tatum arm plate': { env: 0.6, ao: 0.7 },
      'Chrome': { ao: 0.5 },
      'Gusset gray paint': { color: 0x5f6368, metalness: 0.2, roughness: 0.5 },
      'Bumper plate': { metalness: 0.35, roughness: 0.45 },
      // (r6: the chassis' r6 perf mesh carries its own metal / roughness; 'Bumper plate plain' is no longer exported)
      'Bumper perf mesh': { alphaTest: 0.5 },
      'Dark steel': { metalness: 0.5, roughness: 0.5, env: 0.6 },
      // clear-coated panels: a thin, low-saturation base reflection keeps the paint deep black; the
      // glassy coat draws the crisp sky-to-sand horizon line on the doors and the hood (also over the
      // orange vinyl, as in the photos)
      // (r5: deeper gloss - stronger base and coat reflections; `orangeRefl`: the orange vinyl texels take 35 % of
      // the sky reflections so they keep their saturation, black and carbon keep them all)
      // (game_r5c: env 1 / coat 2 takes the side panel from L 13-27 to 23-62 (shoulder streak ~100), black blades
      // still darker than the carbon fields, orange (228,93,29); game_r5h: env 1.6 / coat 3.2 -> door bands 37/33/35
      // under an 80 shoulder, orange (228,96,34); 2.1 / 4.2 starts to read milky grey)
      // (r6, surface critic A/B: env 1.6 / coat 3.2 made the sunlit side panels read silver-chrome (p75 155) - the
      // grey sky band over the whole door. env .56 / coat 1.12 with near-grey reflections (envSat .08): gloss black
      // with one crisp horizon line, the livery readable (p75 ~117). Measured in game (default spawn chase_side, where
      // 1.6 / 3.2 read p75 138): .56 / 1.12 -> p75 72-83, orange (232,103,41); x1.5 -> 89; x2 -> 102 but orange (232,110,56).
      // -> env 1 / coat 2 for the panels with the orange vinyl taking 22 % of the reflections (was 35 %) to keep its colour)
      'Gloss black': { env: 0.75, coat: 1.25, envSat: 0.08, clearcoat: 1, clearcoatRoughness: 0.03 },
      'Livery': { env: 1.0, coat: 2.0, envSat: 0.08, clearcoat: 1, clearcoatRoughness: 0.03, amb: 1.6, ao: 0.4, orangeRefl: 0.22, ...ORANGE, tint: [1.7, 1.6, 1.0], lift: 0.14 },
      // (coat 0.5: seen over the dash at a grazing angle the hood orange no longer washes out to grey)
      // graze: seen nearly edge-on (the hood over the dash from the driver's seat) the sky reflections fade (to 5 %),
      // so the orange shows there as in the photos; the chase-cam highlights are unchanged
      // (r6: env .15 / coat .3 left the hood, beak and wings dead flat black from the chase cam: env .5 / coat 1 gives
      // them a gloss sheen. From the seat the hood is seen at N.V ~.05-.2, where graze .25 (ramp .05-.4) still let
      // ~40 % through: its black read L 155 (r5 26) - a grey glare sheet. graze .05 ramped over N.V .2-.45: seat L 46,
      // chase f3q black median 33 / p75 43 (r5 16 / 24, ramp .05-.4: 34 / 53))
      'Livery top': { env: 0.5, coat: 1.0, envSat: 0.08, clearcoat: 1, clearcoatRoughness: 0.03, amb: 1.3, graze: 0.05, grazeStart: 0.2, grazeEnd: 0.45, orangeRefl: 0.2, ...ORANGE },
      // roof / light bar / nose / dash top carbon (one material): base env 0.6 rather than 0.9 so the roof
      // stops flashing white from the chase cam; the coat carries the gloss
      // (r4: the glTF normal scale is 0.3 already; aoDown: the undersides facing the cockpit keep some
      // bounce light instead of going pure black)
      // (r6) cabin 3: the dash brow takes more of the night lamp (L 4 -> 18; the day fill 1 is below it, so no change by
      // day); cabin2 1 keeps the day look
      'Carbon gloss': { env: 0.35, coat: 0.5, envSat: 0.15, clearcoat: 1, clearcoatRoughness: 0.05, aoDown: 0.35, cabin: 3, cabin2: 1 },
      // the roof's cockpit side: dark carbon with a faint weave and sheen under the cabin fill
      // (r5: at the 78 deg view it fills the top of the frame: less fill (most of its light was the cabin fill, not the
      // ambient), a stronger coat and weave relief so the carbon shows)
      // (r6: the drive_cockpit shot read L 88 blue-grey - the coat mirrored the bright ground and the cabin fill, now
      // 30 cm under it, would flood it: weak env / coat / fill, a little more of the AO on the direct light; target
      // L 25-45 in both the static and the driving cockpit view, faint weave, no streak along the top of the view)
      // (r6) roof liner: its baked AO is near 0 and it faces down, so amb 1.6 read L 8-9 (photo 25-45): amb 12 -> L 23-28, 15 -> ~29;
      // specDown .2: its curved beams mirrored the environment's ground as a bright tube streak (drive_cockpit max 244)
      'Roof liner carbon': { env: 0.3, coat: 0.3, envSat: 0.15, amb: 15.0, ambSat: 0.15, ao: 0.4, direct: 0.7, cabin: 0.3, cabin2: 0.1, normalScale: 3.0, specDown: 0.2 },
      'Satin black': { env: 0.4 },
      // the throat under the hood's rear edge (r5: the rest of the dash top is 'Carbon gloss'): dark, not a black void
      'Interior dash recess black': { env: 0.7, envSat: 0.15, amb: 3.0, ao: 0.3, cabin: 1.0 },
      // small orange parts (often in shade, glossy or metallic): a stronger tint than the livery so they
      // match it instead of reading brick red (r4: plenum measured (192,73,41) in the sun, hue 13)
      'Interior firewall orange': { env: 0.3, amb: 1.4, tint: [1.9, 1.6, 1.0], lift: 0.2 },
      'Plenum orange': { env: 0.6, amb: 1.3, tint: [2.0, 1.7, 1.0], lift: 0.2 },
      'Orange gloss': { amb: 1.2, tint: [1.9, 1.6, 1.0], lift: 0.18 },
      'Orange anodized': { amb: 1.3, tint: [2.2, 1.8, 1.0], lift: 0.25 },
      'Silicone orange': { amb: 1.3, tint: [2.0, 1.7, 1.0], lift: 0.2 },
      // cockpit trim: a floor for the (occluded) bounce light so the dash livery, the door quilting and
      // the orange stitching read under the roof like in the photos; the cabin fill does the rest
      // (the decal orange shares the carbon's strong fill: toned down so it stays near the photo's (248,104,8); r5:
      // orangeRefl .15 keeps the clear coat's sky / cabin-fill highlights off the orange strokes)
      'Interior dash carbon': { env: 0.35, amb: 6.0, ambSat: 0.25, ao: 0.35, direct: 0.2, tint: [0.9, 0.76, 0.0], lift: 0.0, orangeRefl: 0.15, cabin: 1.35 },
      'Interior door quilt': { amb: 2.4, ao: 0.8, direct: 0.2 },
      'Interior leather black': { amb: 2.4, ao: 0.8, direct: 0.2 },
      'Interior suede': { amb: 2.4, ao: 0.8, direct: 0.2 },
      'Interior seat shell fabric': { amb: 2.4, ao: 0.8, direct: 0.2 },
      'Interior seat grey suede': { amb: 2.4, ao: 0.8, direct: 0.2 },
      'Interior seat back': { amb: 2.4, ao: 0.8, direct: 0.2 },
      'Interior seat leather': { amb: 2.4, ao: 0.8, direct: 0.2 },
      'Interior floor mat': { amb: 2.4, ao: 0.8, direct: 0.2 },
      'Stitch orange': { amb: 2.4, ao: 0.8, direct: 0.2, tint: [1.12, 1.2, 1.0], lift: 0.08 },
      'Interior black anodized': { env: 0.7, ...COCKPIT },
      'Polished aluminum': { ...COCKPIT },
      'Interior perforated aluminum': { ...COCKPIT },
      'Interior slot black': { ...COCKPIT },
      'Tire rubber': { ...COCKPIT },
      // (r6) the centre stack and the belts: their baked AO is 0.00-0.15 (deep in the dash / under the roof), so with
      // the car-wide amb .8 they rendered RGB 0 (radio face, keypad). A strong floor for the occluded bounce light and
      // the full cabin fill (now behind them) - photo: radio LCD L ~84, keypad body L ~59 with light glyphs
      ...Object.fromEntries(['Interior switch panel', 'Interior stereo face', 'Interior lowrance bezel',
        'Interior harness webbing', 'Interior harness pad', 'Interior harness label', 'Interior hex mesh dark']
        .map(n => [n, { amb: 5.0, ao: 0.35, direct: 0.2, cabin: 1.35 }])),
      // radio LCD: more of the second fill (it faces it squarely) - L 54 -> 63 (p75 88)
      'Interior race radio face': { amb: 5.0, ao: 0.35, direct: 0.2, cabin: 1.35, cabin2: 2.0 },
      // the bright parts of the stack: amb 3 + the full fills read DCX 163 / red (197,5,36) -> DCX ~137, red ~(157,2,30)
      ...Object.fromEntries(['Interior PCI plate', 'Interior escutcheon satin aluminum'].map(n => [n, { amb: 2.0, ao: 0.4, cabin: 0.7, cabin2: 0.7 }])),
      ...Object.fromEntries(['Interior red button', 'Interior blue button'].map(n => [n, { amb: 2.0, ao: 0.4, cabin: 0.7, cabin2: 0.5 }])),
      // (r6: satin floor plate, not a bright blue-grey mirror: photo L 48-64 in the sun, game read 126-178)
      'Floor pan satin alu': { color: 0x55585e, metalness: 0.4, roughness: 0.55, env: 0.3, amb: 1.4, ao: 0.7 },
      // satin sheen of the tyres in the sun; more bounce light so ribs, lettering and paddles read
      // (the glTF rubber is #171717, tuned for the Cycles studio: x2 albedo here so it reads as sunlit rubber)
      // (r5: x5.5 / x4.5 - at x2 the sunlit rubber read L 20-37 against the sand's 200, ribs and lettering lost; x3.5
      // still 25-51; x5-6 gives sunlit tread L 63-71, shaded sidewalls 33-41 (game_r5c))
      'Tire tread': { colorMul: 5.5, env: 0.7, envSat: 0.2, amb: 1.8, ao: 0.5 },
      'Tire sidewall front': { colorMul: 5.5, env: 0.7, envSat: 0.2, amb: 1.8, ao: 0.5 },
      'Tire sidewall rear': { colorMul: 5.5, env: 0.7, envSat: 0.2, amb: 1.8, ao: 0.5 },
      'Tire paddle': { colorMul: 4.5, env: 0.7, envSat: 0.2, amb: 1.8, ao: 0.5 },
      'Tire groove': { colorMul: 2.5, env: 0.5, envSat: 0.2, amb: 1.8, ao: 0.5 },
      'Wheel barrel black': { env: 0.5 },
      // older builds: the hex grilles came as alpha BLEND
      // (r6: the cowl vents read L ~230 in the sun against the photo's 120-150: a darker satin grey)
      'Hex mesh': { color: 0x9a9ea3, alphaTest: 0.5 },
      // (r6) the light bar's glossy face catches the sky band like the photos (car-wide env is .8)
      'Light bar face': { env: 1.0 / 0.8 },
    },
    nodes: {
      // the wheel in the driver's hands: suede rim and satin black anodised spokes that catch the sky
      SteeringWheel_Mesh: {
        // (r6) colorMul 5: the suede texture averages sRGB 11 (linear .0035, under ACES's black cut-off at night even when
        // lit); black Alcantara is ~.015-.02: day rim L 2-3 -> ~25, and the night lamp can draw it
        'Interior suede': { colorMul: 5, amb: 2.0, ao: 0.6, direct: 0.1 },
        // (r6) cabin 5: the near-black spokes take more of the night lamp (L 1 -> ~15; cabin 4 read 12); the day fill 1 only
        // reaches their dash side, cabin2 1 keeps the day look
        'Interior black anodized': { color: 0x1b1c1f, metalness: 0.7, roughness: 0.3, env: 1.0, envSat: 0.25, amb: 2.0, ao: 0.4, cabin: 5, cabin2: 1 },
        'Gloss black': { env: 0.6, coat: 0.9, ao: 0.4, amb: 2.0 },
        'Polished aluminum': { ao: 0.3 },
        // the 12 o'clock marker: vivid orange like the photo (ACES alone gives brick red under the roof)
        'Wheel marker orange': { env: 0.2, amb: 3.0, ao: 0.3, direct: 0.1, cabin: 1.5, tint: [1.25, 0.97, 0.7], lift: 0.09 },
        'Orange gloss': { env: 0.4, amb: 3.0, ao: 0.3, direct: 0.1, cabin: 1.5, tint: [1.25, 0.97, 0.7], lift: 0.09 },
      },
      // (r5) outside the cockpit the polished parts (beadlock rings / bolts, tie-rod ends, bypass caps) take the plain
      // sunlit look, not the COCKPIT fill: with amb 3 / env .8 the scalloped beadlock rings read near-white
      ...Object.fromEntries(['Wheel_FL_Mesh', 'Wheel_FR_Mesh', 'Wheel_RL_Mesh', 'Wheel_RR_Mesh', 'TieRod_FL', 'TieRod_FR', 'Shock_FL_2', 'Shock_FR_2']
        .map(n => [n, { 'Polished aluminum': { amb: 1.0, ao: 0.8, direct: 0.35, env: 0.5 } }])),
    },
    // (r5: the r5 tail lenses carry LED-dot emissive maps - 1.3 % lit texels on the two rear lenses, 18 % on the
    // roof's rear strip - which read as a 1 px (76,0,1) line from the chase cam at night: lit as whole red lenses.
    // ACES at the night exposure (.95) turns a strong red orange: i 3 read (255,128,68); ~1.3 keeps it red ~(255,40,0))
    // (r6) 'Interior switch panel': the keypad's backlit icons (its emissive map) at radiance ~1 with the lights on
    lamps: { 'Tail light lens': { glow: 0xff1208, i: 1.3 }, 'Tail light brake': { glow: 0xff1208, i: 1.3 }, 'Tail light lens dark': { glow: 0xff1208, i: 1.0 }, 'Tail light red': 1.6, 'LED white': 2.5, 'Interior switch panel': 1.0 },
  },
};

// dev: ?look={"trx":{"mats":{"Carbon gloss":{"env":0.3}}}} merges into LOOKS (look tuning in the real game)
try {
  const q = typeof location !== 'undefined' && new URLSearchParams(location.search).get('look');
  if (q) for (const [id, o] of Object.entries(JSON.parse(q))) {
    const L = LOOKS[id] || (LOOKS[id] = { mats: {} });
    for (const [k, v] of Object.entries(o)) {
      if (k === 'mats' || k === 'nodes') { L[k] = L[k] || {}; for (const [n, t] of Object.entries(v)) L[k][n] = { ...(L[k][n] || {}), ...t }; }
      else L[k] = v;
    }
  }
} catch (e) { console.warn('look param:', e); }

// shared by every patched material: the cabin fill light of the player's car (world position, colour x
// intensity, cut-off distance; colour 0 = off) and the daylight factor for the orange lift
export const CABIN = {
  uCabinPos: { value: new THREE.Vector3() }, uCabinCol: { value: new THREE.Color(0, 0, 0) }, uCabinDist: { value: 1.6 },
  uCabinPos2: { value: new THREE.Vector3() }, uCabinCol2: { value: new THREE.Color(0, 0, 0) }, uCabinDist2: { value: 1.6 },
};
const DAY = { uLookDay: { value: 1 } };
export function setLookDaylight(k) { DAY.uLookDay.value = THREE.MathUtils.clamp(k, 0, 1); }

export function patchMaterial(m, look, t = {}) {
  if (m.userData.lookPatched) return;
  m.userData.lookPatched = true;
  const env = look.env ?? 1;
  const tint = t.tint || look.tint || [1, 1, 1];
  const u = {
    uBakedAO: { value: t.ao ?? look.ao ?? 1 }, uEnvSat: { value: t.envSat ?? look.envSat ?? 1 },
    uAmbSat: { value: t.ambSat ?? look.ambSat ?? 1 }, uAODirect: { value: t.direct ?? look.direct ?? 0 },
    uAmb: { value: (look.amb ?? 1) * (t.amb ?? 1) }, uSpec: { value: env * (t.env ?? 1) },
    uCoat: { value: env * (t.coat ?? t.env ?? 1) },
    uTint: { value: new THREE.Vector3(...tint) }, uLift: { value: t.lift ?? 0 }, uCabinK: { value: t.cabin ?? 1 }, uCabinK2: { value: t.cabin2 ?? t.cabin ?? 1 },
    uAODown: { value: t.aoDown ?? 0 }, uGraze: { value: t.graze ?? 1 }, uOrangeRefl: { value: t.orangeRefl ?? 1 },
    uSpecDown: { value: t.specDown ?? 1 }, uGrazeStart: { value: t.grazeStart ?? 0.05 }, uGrazeEnd: { value: t.grazeEnd ?? 0.4 },
  };
  m.userData.lookUniforms = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, CABIN, DAY);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float bakedAO;\nvarying float vBakedAO;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvBakedAO = bakedAO;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vBakedAO;
uniform float uBakedAO, uEnvSat, uAmbSat, uAODirect, uAmb, uSpec, uCoat, uLift, uLookDay, uCabinDist, uCabinK, uAODown, uGraze, uOrangeRefl;
uniform float uCabinDist2, uCabinK2, uSpecDown, uGrazeStart, uGrazeEnd;
uniform vec3 uTint, uCabinPos, uCabinCol, uCabinPos2, uCabinCol2;
float lookLuma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }`)
      // saturated orange texels: tint (hue / brightness under ACES) + a little emissive lift by day
      .replace('#include <color_fragment>', `#include <color_fragment>
	float lookOrange = clamp( ( diffuseColor.r - 2.0 * diffuseColor.g - diffuseColor.b ) / max( diffuseColor.r, 1e-3 ), 0.0, 1.0 ) * smoothstep( 0.02, 0.1, diffuseColor.r );
	vec3 lookBase = diffuseColor.rgb;
	diffuseColor.rgb *= mix( vec3( 1.0 ), uTint, lookOrange );`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
	totalEmissiveRadiance += lookBase * ( uLift * uLookDay * lookOrange );`)
      // indirect light: desaturate the incoming sky light (not the surface colour), scale it, occlude it;
      // plus the cabin fill light (a shadowless point light, car shaders only)
      .replace('#include <lights_fragment_end>', `
	#if defined( RE_Direct )
${[['uCabinPos', 'uCabinCol', 'uCabinDist', 'uCabinK'], ['uCabinPos2', 'uCabinCol2', 'uCabinDist2', 'uCabinK2']].map(([P, C, D, K]) => `
	if ( ${K} * ( ${C}.r + ${C}.g + ${C}.b ) > 0.0 ) {
		vec3 cabL = ( viewMatrix * vec4( ${P}, 1.0 ) ).xyz - geometryPosition;
		float cabD = length( cabL );
		if ( cabD < ${D} ) {
			IncidentLight cabLight;
			cabLight.direction = cabL / max( cabD, 1e-4 );
			// (no hot spot on surfaces right next to it: the falloff is held below 0.3 m, like a soft lamp)
			cabLight.color = ( ${K} * getDistanceAttenuation( max( cabD, 0.3 ), ${D}, 2.0 ) ) * ${C};
			cabLight.visible = true;
			RE_Direct( cabLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		}
	}`).join('')}
	#endif
	// baked AO; aoDown: a floor for surfaces facing down (world), e.g. the roof's cockpit side
	float lookAO = clamp( vBakedAO, 0.0, 1.0 );
	if ( uAODown > 0.0 && inverseTransformDirection( geometryNormal, viewMatrix ).y < -0.5 ) lookAO = max( lookAO, uAODown );
	{
		float bao = mix( 1.0, lookAO, uBakedAO );
		#if defined( RE_IndirectDiffuse )
			irradiance = mix( vec3( lookLuma( irradiance ) ), irradiance, uAmbSat ) * ( bao * uAmb );
			iblIrradiance = mix( vec3( lookLuma( iblIrradiance ) ), iblIrradiance, uAmbSat ) * ( bao * uAmb );
		#endif
		#if defined( RE_IndirectSpecular ) && defined( STANDARD )
			float bdotNV = saturate( dot( geometryNormal, geometryViewDir ) );
			// graze < 1: fewer sky reflections where the surface is seen nearly edge-on (N.V below grazeStart, default .05,
			// back to all of them at grazeEnd, default .4); orangeRefl < 1: fewer on the
			// orange texels (the sky's white over them washed the hood orange out to salmon)
			float lookGraze = mix( uGraze, 1.0, smoothstep( uGrazeStart, uGrazeEnd, bdotNV ) ) * mix( 1.0, uOrangeRefl, lookOrange );
			// specDown < 1: fewer reflections looking down (world) - the ground of the environment map, which the car
			// itself hides from surfaces inside the cockpit (the roof liner mirrored the sunlit sand as a bright streak)
			lookGraze *= mix( 1.0, uSpecDown, smoothstep( 0.0, -0.35, inverseTransformDirection( reflect( - geometryViewDir, geometryNormal ), viewMatrix ).y ) );
			radiance = mix( vec3( lookLuma( radiance ) ), radiance, uEnvSat ) * ( computeSpecularOcclusion( bdotNV, bao, material.roughness ) * uSpec * lookGraze );
			#ifdef USE_CLEARCOAT
				float bdotNVc = saturate( dot( geometryClearcoatNormal, geometryViewDir ) );
				float lookDownC = mix( 1.0, uSpecDown, smoothstep( 0.0, -0.35, inverseTransformDirection( reflect( - geometryViewDir, geometryClearcoatNormal ), viewMatrix ).y ) );
				clearcoatRadiance = mix( vec3( lookLuma( clearcoatRadiance ) ), clearcoatRadiance, uEnvSat ) * ( computeSpecularOcclusion( bdotNVc, bao, material.clearcoatRoughness ) * uCoat * mix( uGraze, 1.0, smoothstep( uGrazeStart, uGrazeEnd, bdotNVc ) ) * mix( 1.0, uOrangeRefl, lookOrange ) * lookDownC );
			#endif
		#endif
	}
	#include <lights_fragment_end>`)
      // direct light: a little of the AO in deep cavities, where the coarse sun shadow map leaks
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
	{
		float bdir = mix( 1.0, smoothstep( 0.0, 0.6, mix( 1.0, lookAO, uBakedAO ) ), uAODirect );
		// (orangeRefl also takes the sun / cabin-fill highlights off the orange texels, as for the sky reflections)
		float bspec = bdir * mix( 1.0, uOrangeRefl, lookOrange );
		reflectedLight.directDiffuse *= bdir;
		reflectedLight.directSpecular *= bspec;
		#if defined( USE_CLEARCOAT )
			clearcoatSpecularDirect *= bspec;
		#endif
	}`);
  };
  m.customProgramCacheKey = () => 'bakedAO9';
  m.needsUpdate = true;
}

function tuneMaterial(m, L, t) {
  if (t.color !== undefined && m.color) m.color.set(t.color);
  if (t.colorMul !== undefined && m.color) m.color.multiplyScalar(t.colorMul);
  if (t.metalness !== undefined) m.metalness = t.metalness;
  if (t.roughness !== undefined) m.roughness = t.roughness;
  if (t.clearcoat !== undefined && 'clearcoat' in m) m.clearcoat = t.clearcoat;
  if (t.clearcoatRoughness !== undefined && 'clearcoatRoughness' in m) m.clearcoatRoughness = t.clearcoatRoughness;
  if (t.emissiveIntensity !== undefined) m.emissiveIntensity = t.emissiveIntensity;
  if (t.normalScale !== undefined && m.normalMap) m.normalScale.multiplyScalar(t.normalScale);
  if (t.alphaTest !== undefined && (m.transparent || m.alphaTest > 0)) { m.alphaTest = t.alphaTest; m.transparent = false; m.depthWrite = true; }
  // patched materials scale environment diffuse (`amb`) and reflections (`env`, `coat`) separately in the shader
  if (m.isMeshStandardMaterial) { m.envMapIntensity = 1; patchMaterial(m, L, t); }
  else if ('envMapIntensity' in m) m.envMapIntensity = (L.env ?? 1) * (t.env ?? 1);
}

// returns the number of meshes that carried baked AO
function applyLook(def, scene) {
  const look = LOOKS[def.look];
  const meshes = [];
  scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const baked = meshes.filter(o => o.geometry.attributes._ao);
  if (!look && !baked.length) return 0;
  const L = look || { ao: 1, envSat: 1, direct: 0, env: 1, mats: {} };
  for (const o of meshes) {
    const g = o.geometry;
    // the shader reads `bakedAO` on every mesh of a patched car: open sky where nothing was baked
    if (g.attributes._ao) { g.setAttribute('bakedAO', g.attributes._ao); g.deleteAttribute('_ao'); }
    else if (!g.attributes.bakedAO) g.setAttribute('bakedAO', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(1), 1));
  }
  // node overrides: that node's meshes get their own copy of the material
  for (const [node, over] of Object.entries(L.nodes || {})) {
    const n = scene.getObjectByName(node);
    if (!n) continue;
    const clones = new Map();
    n.traverse((o) => {
      if (!o.isMesh) return;
      const swap = (m) => {
        if (!m || !over[m.name]) return m;
        if (!clones.has(m)) {
          const c = m.clone(); c.userData = { ...m.userData, lookPatched: false };
          tuneMaterial(c, L, { ...(L.mats?.[m.name] || {}), ...over[m.name] });
          clones.set(m, c);
        }
        return clones.get(m);
      };
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
  }
  const seen = new Set();
  for (const o of meshes) {
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || seen.has(m) || m.userData.lookPatched) continue;
      seen.add(m);
      tuneMaterial(m, L, L.mats?.[m.name] || {});
    }
  }
  return baked.length;
}

// lamp lenses of a look: emissive on with the car lights (night), dark by day. Materials are shared by
// every car of that model, which all switch their lights together.
const lampState = new WeakMap();
export function setLamps(scene, def, on) {
  const lamps = LOOKS[def?.look]?.lamps;
  if (!lamps) return;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || lamps[m.name] === undefined || !m.emissive) continue;
      if (!lampState.has(m)) lampState.set(m, { i: m.emissiveIntensity, e: m.emissive.clone(), map: m.emissiveMap });
      const s = lampState.get(m);
      const L = lamps[m.name];
      if (on && typeof L === 'object') {
        // whole-lens glow (sRGB hex -> linear like any three.js colour)
        m.emissive.setHex(L.glow); m.emissiveIntensity = L.i;
        if (m.emissiveMap) { m.emissiveMap = null; m.needsUpdate = true; }
      } else if (on) {
        if (s.e.getHex() === 0) m.emissive.copy(m.color.getHex() ? m.color : new THREE.Color(1, 1, 1));
        if (!s.map && m.map) { m.emissiveMap = m.map; m.needsUpdate = true; }
        // lamps[name] = emissive radiance when lit (whatever the glTF emissive factor was)
        m.emissiveIntensity = lamps[m.name] / Math.max(0.05, Math.max(m.emissive.r, m.emissive.g, m.emissive.b));
      } else {
        m.emissive.copy(s.e); m.emissiveIntensity = s.i;
        if (m.emissiveMap !== s.map) { m.emissiveMap = s.map; m.needsUpdate = true; }
      }
    }
  });
}
export const CAR_IDS = Object.keys(CARS);

const loader = new GLTFLoader();
const cache = new Map();

// onProgress(fraction 0..1) while the model downloads (first request only)
export function loadCar(id, onProgress) {
  if (!CARS[id]) return Promise.reject(new Error('unknown car ' + id));
  if (!cache.has(id)) {
    const def = CARS[id];
    const p = Promise.all([
      loader.loadAsync(def.file, onProgress && ((e) => { if (e.total) onProgress(e.loaded / e.total); })),
      def.family === 'sandcar' ? fetch(def.file.replace(/\.glb$/, '.physics.json')).then(r => r.ok ? r.json() : null).catch(() => null) : null,
    ]).then(([gltf, phys]) => { uniqueNodeNames(gltf); return prepare(id, gltf.scene, phys); });
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return cache.get(id);
}

// GLTFLoader names the parts (primitives) of a multi-material mesh <mesh>_1, <mesh>_2 ... without checking
// the node names: the 2nd primitive of the Shock_FR mesh (its chrome shaft) was also called "Shock_FR_2",
// the name of the bypass-shock node, and getObjectByName found it first - the rig then posed the shaft as
// the bypass (a rod floating under the car in every chase view) and the bypass itself never moved. Node
// objects keep their names; any other object with a node's name gets a '_part' suffix.
function uniqueNodeNames(gltf) {
  const assoc = gltf.parser?.associations;
  if (!assoc) return;
  const nodes = new Set();
  gltf.scene.traverse((o) => { if (assoc.get(o)?.nodes !== undefined) nodes.add(o); });
  const names = new Set([...nodes].map(o => o.name).filter(Boolean));
  gltf.scene.traverse((o) => { if (!nodes.has(o) && names.has(o.name)) o.name += '_part'; });
}

// ---------- template: measure the model and build its physics spec ----------
const _box = new THREE.Box3();
function prepare(id, scene, phys) {
  const def = CARS[id];
  const flip = def.family === 'sandcar'; // glTF -> body frame is a 180 deg turn about Y
  scene.updateMatrixWorld(true);
  const find = (n) => scene.getObjectByName(n);
  const toBody = (v) => flip ? new THREE.Vector3(-v.x, v.y, -v.z) : v.clone();
  if (def.stretchFront) stretchFront(scene, phys, def.stretchFront, flip ? -1 : 1);
  const corners = ['FL', 'FR', 'RL', 'RR'];
  const wheels = corners.map((c) => {
    const node = find('Wheel_' + c);
    const p = node.getWorldPosition(new THREE.Vector3());
    _box.setFromObject(node);
    const size = _box.getSize(new THREE.Vector3());
    return { c, node: node.name, p, width: size.x, radius: Math.max(size.y, size.z) / 2 };
  });
  // chassis bounds in body frame (for hull contact points)
  const chassis = find('Chassis_Mesh') || find('Chassis');
  _box.setFromObject(chassis);
  const a = toBody(_box.min), b = toBody(_box.max);
  const bmin = a.clone().min(b), bmax = a.clone().max(b);

  const base = SANDRAIL_SPEC;
  const bw = wheels.map(w => toBody(w.p));
  const zf = (bw[0].z + bw[1].z) / 2, zr = (bw[2].z + bw[3].z) / 2;
  const wheelbase = zf - zr;
  // keep the tuned weight split (31 % front) and CG height so the car launches and wheelies the same
  // (keepRoll: a narrower or shorter car gets a lower CG, keeping track / CG height and wheelbase / CG height
  // at least the tuned values - with 0.78 m the 1.84 m-track GLX rolled over launching up a dune face)
  let cgY = 0.78;
  if (def.keepRoll) {
    const track = (Math.abs(bw[0].x - bw[1].x) + Math.abs(bw[2].x - bw[3].x)) / 2;
    const bt = base.wheels, track0 = (Math.abs(bt[0].x - bt[1].x) + Math.abs(bt[2].x - bt[3].x)) / 2;
    cgY = +(0.78 * Math.min(1, track / track0, wheelbase / base.wheelbase)).toFixed(3);
  }
  const cg = [0, cgY, zr + 0.31 * wheelbase];
  const spec = {
    ...base,
    name: def.label,
    wheelbase,
    cg,
    wheels: base.wheels.map((bwSpec, i) => {
      const w = wheels[i], p = bw[i];
      const r = Math.min(w.radius, p.y); // rest on the ground at ride height
      return { ...bwSpec, x: p.x, y: p.y, z: p.z, r, w: Math.min(bwSpec.front ? 0.3 : 0.55, w.width * 0.85) };
    }),
  };
  if (def.keepRoll) {
    // roll stiffness per axle = (k / 2 + arb) * track^2 with k = the corner spring rate the physics derives
    const frac = (front) => (front ? (cg[2] + wheelbase / 2) / wheelbase : (wheelbase / 2 - cg[2]) / wheelbase);
    const arb0 = [9000, 14000];
    spec.arb = [0, 1].map((ax) => {
      const ws = spec.wheels.filter(w => !!w.front === (ax === 0)), wb = base.wheels.filter(w => !!w.front === (ax === 0));
      const t = Math.abs(ws[0].x - ws[1].x), t0 = Math.abs(wb[0].x - wb[1].x);
      const k = (spec.mass * 9.81 * frac(ax === 0) / 2) / ws[0].sag;
      return Math.max(arb0[ax], Math.round((k / 2 + arb0[ax]) * (t0 / t) ** 2 - k / 2));
    });
  }
  // hull: map the original contact points into this model's bounding box
  const oMin = new THREE.Vector3(-0.98, 0.26, -2.65), oMax = new THREE.Vector3(0.98, 1.78, 2.45);
  const top = Math.min(bmax.y, 2.0);
  spec.hull = base.hull.map(([x, y, z]) => [
    THREE.MathUtils.mapLinear(x, oMin.x, oMax.x, bmin.x, bmax.x),
    THREE.MathUtils.mapLinear(y, oMin.y, oMax.y, Math.max(0.22, bmin.y), top),
    THREE.MathUtils.mapLinear(z, oMin.z, oMax.z, bmin.z, bmax.z),
  ]);
  const eyeNode = find('DriverEye');
  const eye = eyeNode ? toBody(eyeNode.getWorldPosition(new THREE.Vector3())) : new THREE.Vector3(bw[0].x * 0.33, 1.3, (zf + zr) / 2 + 0.2);
  if (def.sightNotch) sightNotch(find('Chassis_Mesh'), toBody, eye, wheels.slice(0, 2).map((w, i) => ({ c: bw[i], r: w.radius, w: w.width })));
  scene.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true; o.receiveShadow = true;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) if (m.map) m.map.anisotropy = 8;
    }
  });
  const bakedAO = applyLook(def, scene);
  return { id, def, scene, phys, spec, eye, flip, bakedAO };
}

// stretchFront (m): the front wheels and front suspension move forward by dz as one piece, and the bodywork
// between the dash (body z 0.7) and the front suspension mounts (1.15) stretches to follow, so the nose comes
// along and the cockpit is unchanged. fz: body z = fz * glTF z. The physics wheel spec is measured afterwards.
function stretchFront(scene, phys, dz, fz) {
  const Z0 = 0.7, Z1 = 1.15;
  const shift = (bz) => bz <= Z0 ? 0 : bz >= Z1 ? dz : dz * (bz - Z0) / (Z1 - Z0);
  scene.updateMatrixWorld(true);
  const v = new THREE.Vector3(), inv = new THREE.Matrix4();
  scene.getObjectByName('Chassis_Mesh')?.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position; inv.copy(o.matrixWorld).invert();
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(o.matrixWorld);
      const s = shift(fz * v.z); if (!s) continue;
      v.z += fz * s; v.applyMatrix4(inv); pos.setXYZ(k, v.x, v.y, v.z);
    }
    pos.needsUpdate = true; o.geometry.computeBoundingBox(); o.geometry.computeBoundingSphere();
  });
  const FRONT = /^(Wheel|Upright|Link|Shock|TieRod)_F[LR]/;
  const parts = [];
  scene.traverse((o) => { if (FRONT.test(o.name) && !FRONT.test(o.parent?.name || '')) parts.push(o); });
  for (const o of parts) {
    const p = o.getWorldPosition(new THREE.Vector3()); p.z += fz * dz;
    o.position.copy(o.parent.worldToLocal(p));
  }
  scene.updateMatrixWorld(true);
  if (phys) {
    for (const l of [...phys.links, ...phys.shocks]) if (l.wheel[0] === 'F') { l.a[2] += fz * dz; l.b[2] += fz * dz; }
    for (const w of phys.wheels || []) if (w.name?.[0] === 'F' && w.center) w.center[2] += fz * dz;
  }
}

// sightNotch: from the driver's eye the dash cowl, the nose top and the side-panel tops hid the front tyres
// by ~9 cm. Bodywork just above each eye -> tyre-top sightline is pressed down below it (fully within ~11 deg,
// tapering to nothing ~21 deg above, fading out ~7 deg either side of the tread), so the top 7 cm of both tyres
// show over the dash. Only that strip 0.6-1.6 m ahead moves (mirrors, eye-height parts and the rest stay put).
function sightNotch(chassis, toBody, eye, tyres) {
  if (!chassis) return;
  const E = new THREE.Vector3(eye.x, eye.y + 0.03, eye.z); // main.js puts the cockpit camera 3 cm above DriverEye
  const SHOW = 0.07, AZ = 0.12, B1 = 0.20, B2 = 0.36, DROP = 0.006, NEAR = 0.62;
  const T = tyres.map(({ c, r, w }) => {
    const az = [-1, 1].map(s => Math.atan2(c.x + s * w * 0.85 - E.x, c.z - E.z));
    const hd = Math.hypot(c.x - E.x, c.z - E.z);
    return { az0: Math.min(...az) - AZ, az1: Math.max(...az) + AZ, el: Math.atan2(c.y + r - SHOW - E.y, hd), hd: hd - r * 0.6 };
  });
  chassis.updateMatrixWorld(true);
  const v = new THREE.Vector3(), inv = new THREE.Matrix4();
  chassis.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position; inv.copy(o.matrixWorld).invert();
    let moved = false;
    for (let k = 0; k < pos.count; k++) {
      const b = toBody(v.fromBufferAttribute(pos, k).applyMatrix4(o.matrixWorld));
      // the mirrors (~0.55 m ahead) and anything at eye height are left alone
      const wy = Math.min(1, (E.y - 0.02 - b.y) / 0.04);
      if (b.z - E.z < NEAR || wy <= 0) continue;
      const hd = Math.hypot(b.x - E.x, b.z - E.z), az = Math.atan2(b.x - E.x, b.z - E.z), el = Math.atan2(b.y - E.y, hd);
      let newEl = el;
      for (const t of T) {
        if (hd > t.hd) continue;
        const wa = Math.min(1, az < t.az0 ? 1 - (t.az0 - az) / AZ : az > t.az1 ? 1 - (az - t.az1) / AZ : 1);
        const line = t.el - DROP, top1 = t.el + B1, top2 = t.el + B2;
        if (wa <= 0 || el <= line || el >= top2) continue;
        // monotonic remap: (line, top1) -> line, (top1, top2) -> (line, top2), so nothing folds over
        const tgt = el < top1 ? line : line + (el - top1) / (top2 - top1) * (top2 - line);
        newEl = Math.min(newEl, el + (tgt - el) * wa * wy);
      }
      if (newEl < el) {
        b.y = E.y + Math.tan(newEl) * hd;
        v.copy(toBody(b)).applyMatrix4(inv); pos.setXYZ(k, v.x, v.y, v.z); moved = true;
      }
    }
    if (moved) { pos.needsUpdate = true; o.geometry.computeBoundingBox(); o.geometry.computeBoundingSphere(); }
  });
}

// ---------- per-car instance ----------
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);

// A part spanning two points (a = chassis end, b = moving end). Re-aims and stretches it.
class Segment {
  constructor(node, a, b) {
    this.node = node;
    this.a = a.clone(); this.b = b.clone();
    this.p0 = node.position.clone(); this.q0 = node.quaternion.clone(); this.s0 = node.scale.clone();
    this.d0 = b.clone().sub(a);
    this.len0 = this.d0.length(); this.d0.normalize();
    this.mid0 = a.clone().add(b).multiplyScalar(0.5);
    this.offset = this.p0.clone().sub(this.a); // node origin relative to the chassis end
    // which local axis runs along the part (for stretching)
    const local = this.d0.clone().applyQuaternion(this.q0.clone().invert());
    const ax = [Math.abs(local.x), Math.abs(local.y), Math.abs(local.z)];
    this.axis = ax.indexOf(Math.max(...ax));
    this.originAtMid = this.p0.distanceTo(this.mid0) < this.p0.distanceTo(this.a);
  }
  aim(a, b, stretch) {
    const d = _v.copy(b).sub(a); const len = d.length(); d.multiplyScalar(1 / len);
    _q.setFromUnitVectors(this.d0, d);
    this.node.quaternion.copy(_q).multiply(this.q0);
    if (this.originAtMid) this.node.position.copy(a).add(b).multiplyScalar(0.5);
    else this.node.position.copy(a).add(_v2.copy(this.offset).applyQuaternion(_q));
    if (stretch) { this.node.scale.copy(this.s0); this.node.scale.setComponent(this.axis, this.s0.getComponent(this.axis) * len / this.len0); }
  }
}

export class GltfSandrail {
  constructor(tpl) {
    this.tpl = tpl;
    this.spec = tpl.spec;
    this.root = new THREE.Group();   // placed at the physics CG
    this.body = new THREE.Group();   // body frame (+X left, +Z forward), origin on the ground
    this.body.position.set(-tpl.spec.cg[0], -tpl.spec.cg[1], -tpl.spec.cg[2]);
    this.model = tpl.scene.clone(true);
    if (tpl.flip) this.model.rotation.y = Math.PI;
    this.body.add(this.model);
    this.root.add(this.body);
    this.eye = tpl.eye;
    this.look = LOOKS[tpl.def.look] || null;
    // cockpit fill light position (glTF frame of the model), see LOOKS.cabin
    this.cabin = this.look?.cabin ? { ...this.look.cabin, local: new THREE.Vector3(...this.look.cabin.pos) } : null;
    // (r6) the dim night lamp above the wheel that takes the fill's place when the daylight goes (LOOKS.nightCabin)
    this.cabin2 = this.look?.cabin2 ? { ...this.look.cabin2, local: new THREE.Vector3(...this.look.cabin2.pos) } : null;
    this.nightCabin = this.look?.nightCabin ? { ...this.look.nightCabin, local: new THREE.Vector3(...this.look.nightCabin.pos) } : null;
    const find = (n) => this.model.getObjectByName(n);
    const corners = ['FL', 'FR', 'RL', 'RR'];
    this.wheelRigs = corners.map((c, i) => {
      const node = find('Wheel_' + c);
      return { c, node, hub: node, spec: tpl.spec.wheels[i], rest: node.position.clone(), q0: node.quaternion.clone() };
    });
    this.steeringWheel = find('SteeringWheel');
    this.steerQ0 = this.steeringWheel?.quaternion.clone();
    if (tpl.def.family === 'sandcar') this._rigSandcar(find);
    else this._rigTrax(find);
    this.update(null);
  }

  // lamp lenses on with the car lights (night)
  setLamps(on) { setLamps(this.model, this.tpl.def, on); }

  // world position of the cockpit fill light (or null); local: a position in the model's glTF frame instead
  cabinWorld(out, local) {
    if (!this.cabin && !local) return null;
    return this.model.localToWorld(out.copy(local || this.cabin.local));
  }

  _rigSandcar(find) {
    const ph = this.tpl.phys;
    const V = (p) => new THREE.Vector3(...p);
    this.segs = [];
    // hub carriers / spindles that ride with the wheel and steer but do not spin
    this.uprights = ['FL', 'FR', 'RL', 'RR'].map((c) => { const n = find('Upright_' + c); return n ? { c, node: n, p0: n.position.clone(), q0: n.quaternion.clone() } : null; }).filter(Boolean);
    if (!ph) return;
    // lower link of each corner, to work out how far along the arm each shock mounts
    const lower = {};
    for (const l of ph.links) if (/Lower_0$/.test(l.node)) lower[l.wheel] = l;
    for (const l of ph.links) {
      const n = find(l.node); if (!n) continue;
      this.segs.push({ seg: new Segment(n, V(l.a), V(l.b)), corner: l.wheel, ratio: 1, stretch: true, tie: /TieRod/.test(l.node) });
    }
    for (const s of ph.shocks) {
      const n = find(s.node); if (!n) continue;
      let ratio = 0.75;
      const lo = lower[s.wheel];
      if (lo) {
        const A = V(lo.a), B = V(lo.b), P = V(s.b);
        const ab = B.clone().sub(A);
        ratio = THREE.MathUtils.clamp(P.sub(A).dot(ab) / ab.lengthSq(), 0.3, 1);
      }
      this.segs.push({ seg: new Segment(n, V(s.a), V(s.b)), corner: s.wheel, ratio, stretch: true, shock: true });
    }
  }

  _rigTrax(find) {
    this.corners = {};
    for (const c of ['FL', 'FR', 'RL', 'RR']) {
      const k = {};
      k.upright = find('Upright_' + c); k.uprightP0 = k.upright?.position.clone(); k.uprightQ0 = k.upright?.quaternion.clone();
      k.armLo = find('ArmLower_' + c); k.armUp = find('ArmUpper_' + c);
      k.armLoQ0 = k.armLo?.quaternion.clone(); k.armUpQ0 = k.armUp?.quaternion.clone();
      k.loOut = find(`HP_${c}_LowerOuter`)?.position.clone(); k.upOut = find(`HP_${c}_UpperOuter`)?.position.clone();
      const sb = find('ShockBody_' + c), ss = find('ShockShaft_' + c), sp = find('ShockSpring_' + c);
      if (sb && ss) {
        k.top = sb.position.clone(); k.bot = ss.position.clone();
        k.body = new Segment(sb, k.top, k.bot);
        k.shaft = new Segment(ss, k.bot, k.top);
        k.spring = sp ? new Segment(sp, k.bot, k.top) : null;
      }
      const tie = find('TieRod_' + c), drive = find('DriveShaft_' + c);
      const link = tie || drive;
      if (link) {
        const out = find(tie ? `HP_${c}_TieOuter` : `HP_${c}_DriveOuter`);
        if (out) { k.linkIn = link.position.clone(); k.linkOut = out.position.clone(); k.link = new Segment(link, k.linkIn, k.linkOut); }
      }
      this.corners[c] = k;
    }
  }

  // wheelStates: SandrailPhysics.getState().w ([comp, angle, steer, ...] per wheel) or null for ride height
  update(wheelStates, steerAngle = 0) {
    const flip = this.tpl.flip;
    const dys = {}, steers = {};
    this.wheelRigs.forEach((rig, i) => {
      const w = rig.spec;
      const ws = wheelStates ? wheelStates[i] : [w.sag, 0, 0];
      const dy = ws[0] - w.sag, angle = ws[1];
      let steer = ws[2];
      const cap = this.tpl.def.maxSteerVis;
      if (cap && dy > 0.05) {
        const c = cap + (Math.PI / 4 - cap) * Math.max(0, 1 - (dy - 0.05) / 0.15);
        steer = Math.max(-c, Math.min(c, steer));
      }
      dys[rig.c] = dy; steers[rig.c] = steer;
      rig.node.position.set(rig.rest.x, rig.rest.y + dy, rig.rest.z);
      // steer about Y, then roll about the axle (glTF models roll the other way round X)
      _q.setFromAxisAngle(AY, steer);
      _q2.setFromAxisAngle(AX, flip ? -angle : angle);
      rig.node.quaternion.copy(rig.q0).multiply(_q).multiply(_q2);
    });
    if (this.uprights) for (const u of this.uprights) {
      u.node.position.set(u.p0.x, u.p0.y + dys[u.c], u.p0.z);
      u.node.quaternion.copy(u.q0);
      if (u.c[0] === 'F') u.node.quaternion.multiply(_q.setFromAxisAngle(AY, steers[u.c]));
    }
    if (this.segs) {
      for (const s of this.segs) {
        const dy = dys[s.corner] * s.ratio;
        const b = _v2.copy(s.seg.b); b.y += dy;
        // a front tie rod's outer end sits on the upright's steering arm: it turns with the upright about the
        // wheel's vertical steering axis (the rack end stays put, the rod stretches a little)
        if (s.tie && s.corner[0] === 'F' && steers[s.corner]) {
          const hub = this.wheelRigs.find(r => r.c === s.corner).rest;
          b.x -= hub.x; b.z -= hub.z;
          b.applyAxisAngle(AY, steers[s.corner]);
          b.x += hub.x; b.z += hub.z;
        }
        s.seg.aim(s.seg.a, b.clone(), s.stretch);
      }
    }
    if (this.corners) {
      for (const [c, k] of Object.entries(this.corners)) {
        const dy = dys[c], st = steers[c];
        const hub = this.wheelRigs.find(r => r.c === c).node.position;
        if (k.upright) { k.upright.position.copy(hub); k.upright.quaternion.copy(k.uprightQ0); if (c[0] === 'F') k.upright.quaternion.premultiply(_q.setFromAxisAngle(AY, st)); }
        const armAng = (pivot, out) => { const r0x = out.x - pivot.x, r0y = out.y - pivot.y; return Math.atan2(r0y + dy, r0x) - Math.atan2(r0y, r0x); };
        let aLo = 0;
        if (k.armLo && k.loOut) { aLo = armAng(k.armLo.position, k.loOut); k.armLo.quaternion.copy(_q.setFromAxisAngle(AZ, aLo)).multiply(k.armLoQ0); }
        if (k.armUp && k.upOut) { const aUp = armAng(k.armUp.position, k.upOut); k.armUp.quaternion.copy(_q.setFromAxisAngle(AZ, aUp)).multiply(k.armUpQ0); }
        if (k.body) {
          const piv = k.armLo ? k.armLo.position : k.bot;
          const bot = k.bot.clone().sub(piv).applyAxisAngle(AZ, aLo).add(piv);
          k.body.aim(k.top, bot, false);
          k.shaft.aim(bot, k.top, false);
          k.spring?.aim(bot, k.top, true);
        }
        if (k.link) {
          const restHub = this.wheelRigs.find(r => r.c === c).rest;
          const out = k.linkOut.clone().sub(restHub);
          if (c[0] === 'F') out.applyAxisAngle(AY, st);
          k.link.aim(k.linkIn, out.add(hub), true);
        }
      }
    }
    if (this.steeringWheel) this.steeringWheel.quaternion.copy(this.steerQ0).multiply(_q.setFromAxisAngle(AY, steerAngle * 5));
  }
}
