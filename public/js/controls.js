// Driving controls that each player can rebind in the menu (M > Key bindings).
// Every action has two keyboard keys and two controller inputs. A controller
// input is a button ('b7') or one direction of a stick axis ('a0-', 'a0+').
// Saved in this browser only, so each player keeps their own layout.

const KEY = 'glamis-bindings-v1';

export const ACTIONS = [
  { id: 'throttle', label: 'Throttle', group: 'Driving' },
  { id: 'brake', label: 'Brake / reverse', group: 'Driving' },
  { id: 'left', label: 'Steer left', group: 'Driving' },
  { id: 'right', label: 'Steer right', group: 'Driving' },
  { id: 'handbrake', label: 'Handbrake', group: 'Driving' },
  { id: 'shiftUp', label: 'Shift up', group: 'Driving' },
  { id: 'shiftDown', label: 'Shift down', group: 'Driving' },
  { id: 'camera', label: 'Change camera', group: 'Other' },
  { id: 'reset', label: 'Flip back upright', group: 'Other' },
  { id: 'lights', label: 'Light bars on / off', group: 'Other' },
  { id: 'teleport', label: 'Next teleport spot', group: 'Other' },
  { id: 'wheelie', label: 'Wheelie control on / off', group: 'Other' },
  { id: 'assist', label: 'Countersteer assist on / off', group: 'Other' },
  { id: 'time', label: 'Time of day / night', group: 'Other' },
  { id: 'hud', label: 'Hide HUD', group: 'Other' },
  { id: 'help', label: 'Hide help', group: 'Other' },
  { id: 'name', label: 'Driver name', group: 'Other' },
  { id: 'record', label: 'Record video on / off', group: 'Other' },
];

export const DEFAULT_BINDINGS = {
  throttle: { keys: ['KeyW', 'ArrowUp'], pad: ['b7', null] },
  brake: { keys: ['KeyS', 'ArrowDown'], pad: ['b6', null] },
  left: { keys: ['KeyA', 'ArrowLeft'], pad: ['a0-', 'b14'] },
  right: { keys: ['KeyD', 'ArrowRight'], pad: ['a0+', 'b15'] },
  handbrake: { keys: ['Space', null], pad: ['b1', 'b0'] },
  shiftUp: { keys: ['KeyE', null], pad: ['b5', null] },
  shiftDown: { keys: ['KeyQ', null], pad: ['b4', null] },
  camera: { keys: ['KeyC', null], pad: ['b3', null] },
  reset: { keys: ['KeyR', null], pad: ['b8', null] },
  lights: { keys: ['KeyN', null], pad: ['b12', null] },
  teleport: { keys: ['KeyL', null], pad: ['b13', null] },
  wheelie: { keys: ['KeyV', null], pad: [null, null] },
  assist: { keys: ['KeyG', null], pad: [null, null] },
  time: { keys: ['KeyT', null], pad: [null, null] },
  hud: { keys: ['KeyH', null], pad: [null, null] },
  help: { keys: ['F1', 'Slash'], pad: [null, null] },
  name: { keys: ['KeyP', null], pad: [null, null] },
  record: { keys: ['KeyK', 'F8'], pad: [null, null] },
};

// keys and buttons that always open the menu, so nobody can lock themselves out
export const RESERVED_KEYS = ['KeyM', 'Escape'];
export const RESERVED_PAD = ['b9'];

const clone = (o) => JSON.parse(JSON.stringify(o));

export function loadBindings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { s = {}; }
  const b = clone(DEFAULT_BINDINGS);
  for (const id of Object.keys(b)) {
    const v = s[id];
    if (!v) continue;
    if (Array.isArray(v.keys)) b[id].keys = [v.keys[0] ?? null, v.keys[1] ?? null];
    if (Array.isArray(v.pad)) b[id].pad = [v.pad[0] ?? null, v.pad[1] ?? null];
  }
  return b;
}
export function saveBindings(b) { try { localStorage.setItem(KEY, JSON.stringify(b)); } catch { /* private mode */ } }
export function resetBindings(b) { const d = clone(DEFAULT_BINDINGS); for (const id of Object.keys(d)) b[id] = d[id]; saveBindings(b); }

// put an input on one slot; it comes off any other action that had it
export function assign(b, id, kind, slot, code) {
  let moved = null;
  if (code) for (const [other, v] of Object.entries(b)) {
    v[kind].forEach((c, i) => { if (c === code && !(other === id && i === slot)) { v[kind][i] = null; moved = other; } });
  }
  b[id][kind][slot] = code;
  saveBindings(b);
  return moved; // the action that lost this input, if any
}

export function actionForKey(b, code) {
  for (const [id, v] of Object.entries(b)) if (v.keys.includes(code)) return id;
  return null;
}

// how hard a controller input is pressed (0..1); triggers stay analog
export function padValue(gp, code) {
  if (!code || !gp) return 0;
  if (code[0] === 'b') { const btn = gp.buttons[+code.slice(1)]; return btn ? (btn.value || (btn.pressed ? 1 : 0)) : 0; }
  const m = /^a(\d+)([+-])$/.exec(code); if (!m) return 0;
  const v = (gp.axes[+m[1]] || 0) * (m[2] === '+' ? 1 : -1);
  return v > 0.08 ? (v - 0.08) / 0.92 : 0;
}
export const isAxis = (code) => !!code && code[0] === 'a';

// first input being pressed on any controller (for rebinding); rest = axes at rest
export function padPressed(pads, rest) {
  for (const gp of pads) {
    if (!gp) continue;
    for (let i = 0; i < gp.buttons.length; i++) if (gp.buttons[i].pressed && !RESERVED_PAD.includes('b' + i)) return 'b' + i;
    for (let i = 0; i < gp.axes.length; i++) {
      const d = gp.axes[i] - (rest?.[gp.index]?.[i] ?? 0);
      if (Math.abs(d) > 0.6) return 'a' + i + (d > 0 ? '+' : '-');
    }
  }
  return null;
}

const KEY_NAMES = { Space: 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Slash: '/', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', AltLeft: 'Left Alt', AltRight: 'Right Alt', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', CapsLock: 'Caps Lock' };
export function keyName(code) {
  if (!code) return '-';
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return 'Num ' + code.slice(6);
  return code;
}
const PAD_NAMES = ['A / Cross', 'B / Circle', 'X / Square', 'Y / Triangle', 'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2', 'Back / Share', 'Start / Options',
  'Left stick click', 'Right stick click', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home'];
const AXIS_NAMES = [['Left stick left', 'Left stick right'], ['Left stick up', 'Left stick down'], ['Right stick left', 'Right stick right'], ['Right stick up', 'Right stick down']];
export function padName(code) {
  if (!code) return '-';
  if (code[0] === 'b') return PAD_NAMES[+code.slice(1)] || 'Button ' + code.slice(1);
  const m = /^a(\d+)([+-])$/.exec(code);
  if (!m) return code;
  return AXIS_NAMES[+m[1]]?.[m[2] === '+' ? 1 : 0] || `Axis ${m[1]} ${m[2]}`;
}
