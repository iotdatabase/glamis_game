// Engine sound: recorded sandrail samples (assets/audio/), crossfaded by throttle and pitched by rpm,
// plus synthesized roost and wind noise. Until the samples have loaded (or if they are missing) a
// synthesized blown big-block V8 plays instead.
//
// Sound files live in assets/audio/. Any of .mp3 .ogg .wav .m4a works; the name before the dot is what counts
// (capitals, spaces and dashes do not matter: "Full Throttle.MP3" is full_throttle).
//   idle           engine idling, car sitting still (looped)
//   full_throttle  throttle held down at high rpm (looped)
// Optional files, used when present and skipped silently when not (add one and reload the page):
//   off_throttle   lifting off / coasting with the engine still revving high (looped)
//   nearby         another sandrail driving close by; used for the bot/other-car engine voice (looped)
// `rpm` is the engine speed the recording was made at: playback speed is the game's rpm over it.
// `loop` is the part of the file that repeats (seconds, from the start; negative = from the end),
// `xfade` how long the end blends into the start so the loop has no click.
const SOUNDS = {
  idle:          { rpm: 1490, loop: [0.10, 13.0], xfade: 0.30 },
  full_throttle: { rpm: 6200, loop: [2.40, 6.90], xfade: 0.20 }, // skips the shift dip at 2.1 s
  off_throttle:  { rpm: 5000, loop: [0.05, -0.05], xfade: 0.20, optional: true },
  nearby:        { rpm: 5000, loop: [0.05, -0.05], xfade: 0.20, optional: true },
};
const AUDIO_DIR = 'assets/audio/';
const EXTS = ['.mp3', '.ogg', '.wav', '.m4a'];
const IDLE_RPM = 900; // the game's rpm when sitting (idleRpm 1000 less converter drag); idle.mp3 plays at its own pitch here

// one AudioContext and one decoded copy of each file, shared by the player's and the bots' engines
let sharedCtx = null, sharedSamples = null;
// the in-game video recorder taps the master of every engine (player and computer cars)
const masters = [];
let recDest = null;
export function audioRecordStream() {
  if (!sharedCtx) return null;
  if (!recDest) { recDest = sharedCtx.createMediaStreamDestination(); for (const m of masters) m.connect(recDest); }
  return recDest.stream;
}

// the server lists assets/audio/ as JSON, so optional files that are not there are never requested
async function listAudioDir() {
  try {
    const r = await fetch(AUDIO_DIR);
    if (r.ok) return await r.json();
  } catch (e) { /* older server: no listing */ }
  return ['idle.mp3', 'full_throttle.mp3'];
}

// keep `loop` of the buffer and blend its last `xfade` seconds into its first (equal power), so
// sample N-1 runs straight into sample 0 with no gap or click
function makeLoop(ctx, buf, spec) {
  const sr = buf.sampleRate, n = buf.length;
  // decoders may leave encoder delay / padding as near-silence at either end
  const d0 = buf.getChannelData(0);
  let s = 0, e = n;
  while (s < n && Math.abs(d0[s]) < 1e-3) s++;
  while (e > s && Math.abs(d0[e - 1]) < 1e-3) e--;
  const at = (t) => Math.round(t < 0 ? e + t * sr : s + t * sr);
  let a = Math.max(s, at(spec.loop[0])), b = Math.min(e, at(spec.loop[1]));
  // a new recording shorter than the loop set in SOUNDS: loop all of it instead of failing
  if (b - a < 0.5 * sr) { a = s; b = e; }
  const x = Math.min(Math.round(spec.xfade * sr), Math.floor((b - a) / 3)), len = b - a - x;
  const out = ctx.createBuffer(buf.numberOfChannels, len, sr);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c), dst = out.getChannelData(c);
    dst.set(src.subarray(a, a + len));
    for (let i = 0; i < x; i++) {
      const t = (i + 0.5) / x;
      dst[i] = src[a + i] * Math.sin(t * Math.PI / 2) + src[a + len + i] * Math.cos(t * Math.PI / 2);
    }
  }
  return out;
}

function loadSamples(ctx) {
  if (sharedSamples) return sharedSamples;
  sharedSamples = listAudioDir().then(async (files) => {
    const out = {};
    await Promise.all(Object.entries(SOUNDS).map(async ([name, spec]) => {
      const file = files.find(f => EXTS.includes(f.slice(f.lastIndexOf('.')).toLowerCase())
        && f.slice(0, f.lastIndexOf('.')).toLowerCase().replace(/[\s-]+/g, '_') === name);
      if (!file) { if (!spec.optional) console.warn(`audio: ${AUDIO_DIR}${name}.mp3 not found, using the synth`); return; }
      try {
        const r = await fetch(AUDIO_DIR + encodeURIComponent(file));
        if (!r.ok) throw new Error(r.status);
        out[name] = makeLoop(ctx, await ctx.decodeAudioData(await r.arrayBuffer()), spec);
      } catch (e) { console.warn(`audio: could not load ${file}:`, e.message || e); }
    }));
    return out;
  });
  return sharedSamples;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// playback rate past `k` bends smoothly toward `lim` instead of stopping dead there, so the pitch keeps
// moving with rpm (a hard clamp freezes it for seconds while the engine winds down)
const knee = (r, k, lim) => (r - k) * (lim - k) > 0 ? lim - (lim - k) * Math.exp(-(r - k) / (lim - k)) : r;

export class EngineAudio {
  // nearby: this engine voices another car (bot / remote player); it uses nearby.* when that file exists
  constructor({ nearby = false } = {}) {
    this.ctx = null;
    this.enabled = false;
    this.volume = 1;
    this.nearby = nearby;
    this.samples = null; // { idle, full, off, near } -> { src, g, flt?, rpm } once loaded
    this.synthMix = 1;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(0.55 * v, this.ctx.currentTime, 0.05);
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    if (!sharedCtx) {
      sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
      // a hidden tab stops drawing frames, so update() would leave the engine stuck where it was
      document.addEventListener('visibilitychange', () => { if (document.hidden) sharedCtx.suspend(); else sharedCtx.resume(); });
    }
    const ctx = sharedCtx;
    ctx.resume();
    this.ctx = ctx;
    const master = ctx.createGain(); master.gain.value = 0.55 * this.volume; master.connect(ctx.destination);
    masters.push(master); if (recDest) master.connect(recDest);
    this.master = master;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4; comp.connect(master);
    this.comp = comp;

    // Synth engine (fallback): two detuned sawtooth "firing" oscillators + sub-harmonic burble
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 3.2); }
    shaper.curve = curve;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2.5;
    const engGain = ctx.createGain(); engGain.gain.value = 0;
    shaper.connect(lp); lp.connect(engGain); engGain.connect(comp);
    const pre = ctx.createGain(); pre.gain.value = 0.6; pre.connect(shaper);
    const mk = (type, g) => { const o = ctx.createOscillator(); o.type = type; const gg = ctx.createGain(); gg.gain.value = g; o.connect(gg); gg.connect(pre); o.start(); return o; };
    this.osc = [mk('sawtooth', 0.5), mk('sawtooth', 0.35), mk('square', 0.35), mk('triangle', 0.5)];
    // cam lope: amplitude modulation at half-crank frequency
    const lfo = ctx.createOscillator(); lfo.type = 'sine';
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.25;
    lfo.connect(lfoGain); lfoGain.connect(pre.gain); lfo.start();
    this.lfo = lfo; this.lfoGain = lfoGain;
    this.lp = lp; this.engGain = engGain;

    // supercharger whine
    const whine = ctx.createOscillator(); whine.type = 'sine';
    const wg = ctx.createGain(); wg.gain.value = 0;
    whine.connect(wg); wg.connect(comp); whine.start();
    this.whine = whine; this.whineGain = wg;

    // noise source shared by roost and wind
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const mkNoise = (type, f, q) => {
      const src = ctx.createBufferSource(); src.buffer = nb; src.loop = true;
      const flt = ctx.createBiquadFilter(); flt.type = type; flt.frequency.value = f; flt.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(flt); flt.connect(g); g.connect(comp); src.start();
      return { flt, g };
    };
    this.roost = mkNoise('bandpass', 1400, 0.6);
    this.wind = mkNoise('lowpass', 500, 0.5);
    this.intake = mkNoise('bandpass', 300, 1.2);
    this.enabled = true;

    loadSamples(ctx).then((bufs) => this.useSamples(bufs));
  }

  // every loop runs all the time; update() only moves gains and playback rates
  useSamples(bufs) {
    if (!bufs.idle || !bufs.full_throttle) return; // keep the synth
    const ctx = this.ctx, t = ctx.currentTime;
    const voice = (name, lowpass) => {
      const buf = bufs[name];
      if (!buf) return null;
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const g = ctx.createGain(); g.gain.value = 0;
      let out = src, flt = null;
      if (lowpass) { flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 18000; src.connect(flt); out = flt; }
      out.connect(g); g.connect(this.comp);
      src.start(t, Math.random() * buf.duration); // bots and player do not phase together
      return { src, g, flt, rpm: SOUNDS[name].rpm };
    };
    this.samples = {
      idle: voice('idle'),
      // without an off_throttle file the full-throttle loop is muffled when the throttle is lifted
      full: voice('full_throttle', !bufs.off_throttle || this.nearby),
      off: voice('off_throttle'),
      near: this.nearby ? voice('nearby') : null,
    };
    this.synthMix = 0;
    this.engGain.gain.setTargetAtTime(0, t, 0.1);
    this.whineGain.gain.setTargetAtTime(0, t, 0.1);
    // the synth engine is silent from here on: stop its oscillators so they cost nothing
    for (const o of [...this.osc, this.lfo, this.whine]) o.stop(t + 0.6);
  }

  // current mix, for tests: gains and playback rates as the audio thread has them
  debug() {
    const s = this.samples, v = (x) => x ? +x.g.gain.value.toFixed(3) : null;
    return {
      enabled: this.enabled, state: this.ctx?.state, samples: !!s, synthMix: this.synthMix,
      idleGain: v(s?.idle), fullGain: v(s?.full), offGain: v(s?.off), nearGain: v(s?.near),
      idleRate: s?.idle ? +s.idle.src.playbackRate.value.toFixed(3) : null,
      fullRate: s?.full ? +s.full.src.playbackRate.value.toFixed(3) : null,
      fullCutoff: s?.full?.flt ? Math.round(s.full.flt.frequency.value) : null,
      master: this.master ? +this.master.gain.value.toFixed(3) : null,
    };
  }

  update(rpm, throttle, roost, speed) {
    if (!this.enabled) return;
    const t = this.ctx.currentTime, k = 0.05;
    if (this.samples) this.updateSamples(rpm, throttle, t);
    const sm = this.synthMix;
    if (sm) {
      const fire = rpm / 60 * 4; // V8: 4 power pulses per crank revolution
      this.osc[0].frequency.setTargetAtTime(fire, t, k);
      this.osc[1].frequency.setTargetAtTime(fire * 1.006, t, k);
      this.osc[2].frequency.setTargetAtTime(fire * 0.5, t, k);
      this.osc[3].frequency.setTargetAtTime(fire * 0.25, t, k);
      this.lfo.frequency.setTargetAtTime(rpm / 120, t, k);
      this.lfoGain.gain.setTargetAtTime(rpm < 1600 ? 0.35 : 0.08, t, 0.2);
      this.lp.frequency.setTargetAtTime(350 + throttle * 2200 + rpm * 0.25, t, k);
      this.engGain.gain.setTargetAtTime(sm * (0.18 + throttle * 0.32 + rpm / 7500 * 0.25), t, k);
      this.whine.frequency.setTargetAtTime(rpm / 60 * 7.5, t, k);
      this.whineGain.gain.setTargetAtTime(sm * Math.min(rpm / 7500, 1) ** 2 * (0.012 + throttle * 0.03), t, k);
    }
    this.roost.g.gain.setTargetAtTime(Math.min(roost / 15, 1) * 0.35, t, 0.08);
    this.wind.g.gain.setTargetAtTime(Math.min(speed / 50, 1) ** 2 * 0.25, t, 0.2);
    this.wind.flt.frequency.setTargetAtTime(300 + speed * 20, t, 0.2);
    this.intake.g.gain.setTargetAtTime((0.25 + 0.75 * sm) * throttle * 0.08 * rpm / 7500, t, k);
    this.intake.flt.frequency.setTargetAtTime(200 + rpm * 0.12, t, k);
  }

  updateSamples(rpm, throttle, t) {
    const s = this.samples, full = s.near || s.full;
    // Map game rpm (idle 1000 .. limiter 7500) onto the recordings: game idle sounds like idle.mp3,
    // game 6200 like full_throttle.mp3, linear in between.
    const sRpm = s.idle.rpm + (rpm - IDLE_RPM) * (full.rpm - s.idle.rpm) / (full.rpm - IDLE_RPM);
    // idle loop -> "high" loops: throttle, or revs alone (coasting at high rpm is not idle). The idle
    // loop is gone by ~3000 rpm, so it is never sped up far enough to sound like a chipmunk.
    const rn = clamp((rpm - IDLE_RPM) / (full.rpm - IDLE_RPM), 0, 1);
    const x = clamp(Math.max(throttle, rn * 2.5), 0, 1);
    const gIdle = Math.cos(x * Math.PI / 2), gHigh = Math.sin(x * Math.PI / 2); // equal power
    // fast attack when the throttle goes down, a slower release when it comes up
    const up = throttle > (this._thr || 0), tc = up ? 0.04 : 0.12;
    this._thr = throttle;
    s.idle.g.gain.setTargetAtTime(0.9 * gIdle, t, tc);
    s.idle.src.playbackRate.setTargetAtTime(clamp(knee(sRpm / s.idle.rpm, 1.15, 1.45), 0.85, 1.45), t, 0.05);
    const fRate = clamp(knee(sRpm / full.rpm, 0.7, 0.4), 0.4, 1.3);
    full.src.playbackRate.setTargetAtTime(fRate, t, 0.05);
    const off = this.nearby ? null : s.off;
    if (off) {
      // high revs split between on-throttle and off-throttle loops, equal power again
      const a = throttle * Math.PI / 2;
      full.g.gain.setTargetAtTime(gHigh * Math.sin(a), t, tc);
      off.g.gain.setTargetAtTime(gHigh * Math.cos(a), t, tc);
      off.src.playbackRate.setTargetAtTime(clamp(knee(sRpm / off.rpm, 0.7, 0.4), 0.4, 1.5), t, 0.05);
    } else {
      // no off_throttle file: the full-throttle loop drops in level and loses its top end instead
      full.g.gain.setTargetAtTime(gHigh * (0.5 + 0.5 * throttle), t, tc);
      if (full.flt) full.flt.frequency.setTargetAtTime(900 + throttle * throttle * 17000, t, tc);
    }
    if (s.near && s.full !== full) s.full.g.gain.setTargetAtTime(0, t, 0.1);
  }
}
