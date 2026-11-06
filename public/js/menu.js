// In-game menu (M): Controls, Key bindings, Quality, Weather, Teleport and Game tabs built from a schema.
// Settings are saved in the browser so they stick between sessions.

import { PLACES } from './places.js';
import { ACTIONS, loadBindings, resetBindings, assign, keyName, padName, padPressed, RESERVED_KEYS } from './controls.js';

const KEY = 'glamis-settings-v1';

export const DEFAULTS = {
  quality: 'ultra', renderScale: 1, shadows: 'ultra', particles: 1,
  weather: 'clear', tod: 16.8, night: false, wind: 1,
  autoTrans: true, wheelieControl: true, steerAssist: true, steerSens: 1, volume: 0.8, camMode: 0, cockpitFov: 78, radarCockpit: 'hud', liveMirrors: true, driverArms: false, invertLook: false,
  car: 'pro',
  gravity: 9.81, grip: 1, softness: 1, sandTex: 'all',
  bloom: 'auto', heatHaze: 'auto', colorGrade: 'auto', motionBlur: 'auto', scenery: 'auto',
  aiCount: 6, aiSkill: 1, radar: true, radarRange: 600, labels: true, showHelp: true,
};

// Settings that change the shared world: when one player changes them online,
// everyone's game follows. (Your car choice and per-PC display/sound/camera stay yours.)
export const GLOBAL_KEYS = ['weather', 'tod', 'night', 'wind', 'gravity', 'grip', 'softness', 'wheelieControl', 'steerAssist', 'aiCount', 'aiSkill'];

export function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { s = {}; }
  // the photo sand texture went from a test patch to the whole map
  if (s.sandTexV !== 2) { s.sandTex = 'all'; s.sandTexV = 2; }
  // the new GLX pro rail: start everyone in it once
  if (s.proCarV !== 1) { s.car = 'pro'; s.proCarV = 1; }
  // Q / E used to switch to the manual gearbox for good (players got stuck in 1st at ~50 mph): back to automatic once
  if (s.autoTransV !== 1) { s.autoTrans = true; s.autoTransV = 1; }
  // cockpit field of view: back to the wide 78 deg default (58 / 68 were test defaults, never picked by a player)
  if (s.cockpitFovV !== 3) { if (s.cockpitFov === undefined || [58, 68].includes(Number(s.cockpitFov))) s.cockpitFov = 78; s.cockpitFovV = 3; }
  return { ...DEFAULTS, ...s };
}
export function saveSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }

const fmtTod = (h) => { const hh = Math.floor(h), mm = Math.round((h % 1) * 60); const ap = hh >= 12 ? 'PM' : 'AM'; return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${ap}`; };

export const SCHEMA = [
  { tab: 'Controls', items: [
    { key: 'autoTrans', label: 'Gearbox', type: 'choice', options: [[true, 'Automatic'], [false, 'Manual (Q / E)']], hint: 'In automatic, Q / E shift for a few seconds, then it goes back to automatic' },
    { key: 'wheelieControl', label: 'Wheelie control', type: 'choice', options: [[true, 'On'], [false, 'Off (full send)']], hint: 'Key V' },
    { key: 'steerAssist', label: 'Countersteer assist', type: 'choice', options: [[true, 'On'], [false, 'Off']], hint: 'Key G' },
    { key: 'steerSens', label: 'Steering speed', type: 'range', min: 0.5, max: 1.8, step: 0.05, fmt: v => Math.round(v * 100) + '%' },
    { key: 'camMode', label: 'Camera', type: 'choice', options: [[0, 'Chase'], [1, 'Far'], [2, 'Cockpit'], [3, 'Hood'], [4, 'Side']], hint: 'Key C' },
    { key: 'cockpitFov', label: 'Cockpit field of view', type: 'range', min: 60, max: 90, step: 1, fmt: v => `${v}° (${Math.round(2 * Math.atan(Math.tan(v * Math.PI / 360) * 16 / 9) * 180 / Math.PI)}° wide)`, hint: 'Vertical angle of the cockpit camera' },
    { key: 'invertLook', label: 'Invert look up/down', type: 'choice', options: [[false, 'Off'], [true, 'On']] },
    { key: 'volume', label: 'Sound volume', type: 'range', min: 0, max: 1, step: 0.05, fmt: v => Math.round(v * 100) + '%' },
    { type: 'actions', key: 'rec', label: 'Video', list: [['toggle', 'Start / stop recording']], hint: 'Records the 3D view and engine sound (no HUD) and saves it to your Downloads. Key K or F8.' },
    { type: 'keys', rows: [
      ['Mouse', 'Drag to look around, scroll to zoom'], ['M or Esc', 'This menu (controller: Start)'],
      ['Controller', 'Right stick looks around. Change any key or button in the Key bindings tab.'],
    ] },
  ] },
  { tab: 'Key bindings', items: [{ type: 'bindings' }] },
  { tab: 'Quality', items: [
    { key: 'quality', label: 'Graphics preset', type: 'choice', options: [['ultra', 'Ultra (RTX 5090)'], ['high', 'High'], ['low', 'Low']], hint: 'Terrain detail and tire-track resolution. Reloads the game.', reload: true },
    { key: 'renderScale', label: 'Render resolution', type: 'range', min: 0.5, max: 2, step: 0.25, fmt: v => Math.round(v * 100) + '%', hint: 'Above 100% supersamples for the sharpest image.' },
    { key: 'shadows', label: 'Shadows', type: 'choice', options: [['off', 'Off'], ['low', 'Low'], ['high', 'High'], ['ultra', 'Ultra']] },
    { key: 'sandTex', label: 'Photo sand textures', type: 'choice', options: [['off', 'Off'], ['patch', 'Test patch at start'], ['all', 'Everywhere']], hint: 'Poly Haven scanned sand. Turn off for slower PCs.' },
    { key: 'liveMirrors', label: 'Live mirrors (cockpit)', type: 'choice', options: [[true, 'On'], [false, 'Off']], hint: 'Real reflections in the rear-view mirrors. Turn off for more fps in the cockpit view.' },
    { key: 'driverArms', label: 'Driver arms (cockpit)', type: 'choice', options: [[true, 'Show'], [false, 'Hide']], hint: 'The driver\'s arms and gloves on the steering wheel in the driver\'s seat view.' },
    { key: 'scenery', label: 'Desert life', type: 'choice', options: [['auto', 'On'], [false, 'Off']], hint: 'Bushes on the flats, camps with RVs, flags and parked rails at Glamis Flats and Osborne Overlook' },
    { key: 'bloom', label: 'Bloom (glow)', type: 'choice', options: [['auto', 'Auto'], [true, 'On'], [false, 'Off']], hint: 'The sun, light bars and whips glow. Auto: on at Ultra and High' },
    { key: 'heatHaze', label: 'Heat shimmer', type: 'choice', options: [['auto', 'Auto'], [true, 'On'], [false, 'Off']], hint: 'The far sand wavers in the midday heat' },
    { key: 'colorGrade', label: 'Colour grading', type: 'choice', options: [['auto', 'Auto'], [true, 'On'], [false, 'Off']], hint: 'Warmer light, golden hour glow and a soft vignette' },
    { key: 'motionBlur', label: 'Speed blur', type: 'choice', options: [['auto', 'Auto'], [true, 'On'], [false, 'Off']], hint: 'The screen edges streak above ~50 mph' },
    { key: 'particles', label: 'Sand and dust amount', type: 'range', min: 0.25, max: 2, step: 0.25, fmt: v => Math.round(v * 100) + '%' },
  ] },
  { tab: 'Weather', items: [
    { key: 'weather', label: 'Weather', hint: 'Weather, time and wind are shared with all players.', type: 'choice', options: [['clear', 'Clear'], ['hazy', 'Hazy'], ['cloudy', 'Partly cloudy'], ['overcast', 'Overcast'], ['windy', 'Windy'], ['sandstorm', 'Sandstorm']] },
    { key: 'night', label: 'Night mode', type: 'choice', options: [[false, 'Off'], [true, 'On (moonlight, N for light bars)']], hint: 'Key T steps through the day into night' },
    { key: 'tod', label: 'Time of day', type: 'range', min: 6.2, max: 19.4, step: 0.1, fmt: fmtTod, lazy: true },
    { key: 'wind', label: 'Wind strength', type: 'range', min: 0, max: 2, step: 0.1, fmt: v => Math.round(v * 100) + '%' },
  ] },
  { tab: 'Teleport', items: [
    { type: 'actions', key: 'tp', label: 'Hill climbs', list: PLACES.filter(p => p.kind === 'hill').map(p => [p.id, p.name]) },
    { type: 'actions', key: 'tp', label: 'Bowls', list: PLACES.filter(p => p.kind === 'bowl').map(p => [p.id, p.name]) },
    { type: 'actions', key: 'tp', label: 'Camps and start', list: PLACES.filter(p => p.kind === 'camp' || p.kind === 'start').map(p => [p.id, p.name]),
      hint: 'Real Glamis spots from the BLM map. Hill climbs start you at the bottom facing up. Key L jumps to the next one.' },
  ] },
  { tab: 'Game', items: [
    { key: 'gravity', label: 'Gravity', type: 'range', min: 1, max: 20, step: 0.01, fmt: v => `${v.toFixed(2)} m/s² · ${(v / 9.81).toFixed(2)} g`,
      presets: [[1.62, 'Moon'], [3.71, 'Mars'], [9.81, 'Earth'], [14.7, '1.5 g']], hint: 'Arrow keys fine-tune by 0.01. Shared with all players.' },
    { key: 'softness', label: 'Sand softness', type: 'range', min: 0.4, max: 2, step: 0.05, fmt: v => Math.round(v * 100) + '%', hint: 'How deep tires sink. Shared with all players.' },
    { key: 'grip', label: 'Sand grip', type: 'range', min: 0.5, max: 1.5, step: 0.01, fmt: v => Math.round(v * 100) + '%', hint: 'Lower lets the rails slide more. Shared with all players.' },
    { key: 'car', label: 'Your sandrail', type: 'choice', options: [['pro', 'GLX pro'], ['pro2', 'GLX pro 2'], ['flamerail', 'Flame rail'], ['black', 'Black'], ['blue', 'Blue'], ['green', 'Green'], ['silver', 'Silver'], ['yellow', 'Yellow'], ['trax', 'Trax'], ['classic', 'Classic (built in)']], hint: 'Your Blender models from the assets folder' },
    { key: 'aiCount', label: 'Computer sandrails', type: 'range', min: 0, max: 12, step: 1, fmt: v => String(v) },
    { key: 'aiSkill', label: 'Computer driving', type: 'choice', options: [[0.75, 'Cruising'], [1, 'Normal'], [1.3, 'Aggressive']] },
    { key: 'radar', label: 'Radar', type: 'choice', options: [[true, 'On'], [false, 'Off']] },
    { key: 'radarCockpit', label: 'Radar in the cockpit', type: 'choice', options: [['hud', 'Screen corner'], ['dash', 'Dash screen only']], hint: 'Cars with a dash GPS screen (GLX pro) always show the map there too' },
    { key: 'radarRange', label: 'Radar range', type: 'choice', options: [[300, '300 m'], [600, '600 m'], [1200, '1.2 km'], [2500, '2.5 km']] },
    { key: 'labels', label: 'Name tags', type: 'choice', options: [[true, 'On'], [false, 'Off']] },
    { key: 'showHelp', label: 'Help panel', type: 'choice', options: [[true, 'On'], [false, 'Off']] },
  ] },
];

export class Menu {
  constructor(root, settings, onChange) {
    this.root = root; this.s = settings; this.onChange = onChange;
    this.open = false;
    this.tab = 0;
    this.controls = new Map();
    this.bindings = loadBindings();   // read by the game every frame
    this.onBindings = null;           // called after a binding changes
    this.capture = null;
    addEventListener('keydown', (e) => this._captureKey(e), true);
    this.build();
  }

  build() {
    const r = this.root;
    r.innerHTML = '';
    const panel = el('div', 'menu-panel');
    const head = el('div', 'menu-head');
    head.append(el('div', 'menu-title', 'GLAMIS'));
    const tabs = el('div', 'menu-tabs');
    SCHEMA.forEach((t, i) => {
      const b = el('button', 'menu-tab', t.tab);
      b.onclick = () => this.showTab(i);
      tabs.append(b);
    });
    head.append(tabs);
    const close = el('button', 'menu-close', 'Resume');
    close.onclick = () => this.toggle(false);
    head.append(close);
    panel.append(head);
    this.pages = SCHEMA.map((t) => {
      const page = el('div', 'menu-page');
      for (const it of t.items) page.append(this.item(it));
      panel.append(page);
      return page;
    });
    r.append(panel);
    this.tabBtns = [...tabs.children];
    this.showTab(this.tab);
  }

  item(it) {
    if (it.type === 'actions') {
      // a list of buttons that do something right away (teleport spots)
      const box = el('div', 'menu-actions');
      if (it.label) box.append(el('div', 'menu-label', it.label));
      const grid = el('div', 'menu-ctl');
      for (const [id, text] of it.list) { const b = el('button', 'menu-opt', text); b.onclick = () => this.onAction?.(it.key, id); grid.append(b); }
      box.append(grid);
      if (it.hint) box.append(el('small', '', it.hint));
      return box;
    }
    if (it.type === 'bindings') return this.bindingsTable();
    if (it.type === 'keys') {
      const box = el('div', 'menu-keys');
      for (const [k, d] of it.rows) { const row = el('div', 'menu-keyrow'); row.append(el('b', '', k), el('span', '', d)); box.append(row); }
      return box;
    }
    const row = el('div', 'menu-row');
    const lab = el('div', 'menu-label', it.label);
    if (it.hint) lab.append(el('small', '', it.hint));
    row.append(lab);
    const ctl = el('div', 'menu-ctl');
    if (it.type === 'choice') {
      const btns = it.options.map(([v, text]) => {
        const b = el('button', 'menu-opt', text);
        b.onclick = () => this.set(it, v);
        ctl.append(b);
        return [v, b];
      });
      this.controls.set(it.key, () => btns.forEach(([v, b]) => b.classList.toggle('on', v === this.s[it.key])));
    } else if (it.type === 'range') {
      const inp = document.createElement('input');
      Object.assign(inp, { type: 'range', min: it.min, max: it.max, step: it.step });
      const val = el('span', 'menu-val');
      inp.oninput = () => { val.textContent = it.fmt(+inp.value); if (!it.lazy) this.set(it, +inp.value); };
      inp.onchange = () => this.set(it, +inp.value);
      ctl.append(inp, val);
      const pbtns = (it.presets || []).map(([v, text]) => {
        const b = el('button', 'menu-opt', text);
        b.onclick = () => this.set(it, v);
        return [v, b];
      });
      if (pbtns.length) { const pr = el('div', 'menu-presets'); pbtns.forEach(([, b]) => pr.append(b)); ctl.append(pr); }
      this.controls.set(it.key, () => {
        inp.value = this.s[it.key]; val.textContent = it.fmt(this.s[it.key]);
        pbtns.forEach(([v, b]) => b.classList.toggle('on', Math.abs(v - this.s[it.key]) < 1e-6));
      });
    }
    row.append(ctl);
    this.controls.get(it.key)?.();
    return row;
  }

  // ---------- key bindings ----------
  bindingsTable() {
    const box = el('div', 'menu-binds');
    const note = el('div', 'menu-bindnote', 'Click a box, then press the key or controller button for it. Backspace clears it, Esc cancels. M, Esc and Start always open this menu.');
    const table = el('div', 'menu-bindgrid');
    this.bindBtns = [];
    const head = ['Action', 'Key', 'Second key', 'Controller', 'Second controller'];
    for (const h of head) table.append(el('div', 'menu-bindhead', h));
    let group = null;
    for (const a of ACTIONS) {
      if (a.group !== group) { group = a.group; table.append(el('div', 'menu-bindgroup', group)); }
      table.append(el('div', 'menu-bindlabel', a.label));
      for (const [kind, slot] of [['keys', 0], ['keys', 1], ['pad', 0], ['pad', 1]]) {
        const b = el('button', 'menu-bind');
        b.onclick = () => this._startCapture(a.id, kind, slot, b);
        table.append(b);
        this.bindBtns.push({ id: a.id, kind, slot, b });
      }
    }
    const foot = el('div', 'menu-ctl');
    const reset = el('button', 'menu-opt', 'Reset all to defaults');
    reset.onclick = () => { this._stopCapture(); resetBindings(this.bindings); this._refreshBinds(); this.status.textContent = 'Back to the default controls.'; this.onBindings?.(); };
    this.status = el('small', 'menu-bindstatus', '');
    foot.append(reset, this.status);
    box.append(note, table, foot);
    this._refreshBinds();
    return box;
  }

  _refreshBinds() {
    for (const { id, kind, slot, b } of this.bindBtns) {
      const code = this.bindings[id][kind][slot];
      b.textContent = kind === 'keys' ? keyName(code) : padName(code);
      b.classList.toggle('empty', !code);
      b.classList.remove('wait');
    }
  }

  _startCapture(id, kind, slot, btn) {
    this._stopCapture();
    this.capture = { id, kind, slot, btn, armed: false, rest: {} };
    btn.classList.add('wait');
    btn.textContent = kind === 'keys' ? 'Press a key...' : 'Press a button...';
    this.status.textContent = '';
    if (kind === 'pad') {
      const pads = navigator.getGamepads ? [...navigator.getGamepads()] : [];
      for (const gp of pads) if (gp) this.capture.rest[gp.index] = [...gp.axes];
      if (!pads.some(Boolean)) this.status.textContent = 'No controller found. Plug one in and press any button on it first.';
      const poll = () => {
        const c = this.capture;
        if (!c || c.btn !== btn) return;
        const code = padPressed(navigator.getGamepads ? [...navigator.getGamepads()] : [], c.rest);
        if (!code) c.armed = true; // wait until everything is released first
        else if (c.armed) { this._finish(code); return; }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }
  }

  _stopCapture() { if (this.capture) { this.capture = null; this._refreshBinds(); } }

  _finish(code) {
    const { id, kind, slot } = this.capture;
    this.capture = null;
    const moved = assign(this.bindings, id, kind, slot, code);
    this._refreshBinds();
    const name = code ? (kind === 'keys' ? keyName(code) : padName(code)) : null;
    const label = (x) => ACTIONS.find(a => a.id === x)?.label;
    this.status.textContent = !code ? `Cleared.` : moved && moved !== id ? `${name} now does ${label(id)} (taken off ${label(moved)}).` : `${name} set for ${label(id)}.`;
    this.onBindings?.();
  }

  _captureKey(e) {
    const c = this.capture;
    if (!c || !this.open) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.code === 'Escape') { this._stopCapture(); this.status.textContent = 'Cancelled.'; return; }
    if (c.kind !== 'keys') return;
    if (e.code === 'Backspace' || e.code === 'Delete') { this._finish(null); return; }
    if (RESERVED_KEYS.includes(e.code)) { this.status.textContent = 'M and Esc are kept for the menu. Pick another key.'; return; }
    this._finish(e.code);
  }

  set(it, v) {
    if (this.s[it.key] === v) return;
    this.s[it.key] = v;
    saveSettings(this.s);
    this.refresh(it.key);
    this.onChange(it.key, v, it);
  }

  // external change (hotkey) -> update the menu's buttons
  refresh(key) { if (key) this.controls.get(key)?.(); else for (const f of this.controls.values()) f(); }

  showTab(i) {
    this.tab = i;
    this.pages.forEach((p, k) => p.classList.toggle('show', k === i));
    this.tabBtns.forEach((b, k) => b.classList.toggle('on', k === i));
  }

  toggle(force) {
    this.open = force ?? !this.open;
    if (!this.open) this._stopCapture();
    this.root.classList.toggle('open', this.open);
    if (this.open) this.refresh();
  }
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
