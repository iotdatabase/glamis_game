// Multiplayer client: sends our car state at 20 Hz, interpolates other cars.
export class NetClient {
  constructor(handlers) {
    this.h = handlers;
    this.id = null;
    this.ws = null;
    this.sendTimer = 0;
    this.connected = false;
  }

  connect(name, car) {
    this.name = name; this.car = car;
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.connected = this.everConnected = true; ws.send(JSON.stringify({ t: 'hello', name: this.name, car: this.car, world: this.world?.() })); };
    // retry a server that dropped; a page with no game server behind it (GitHub Pages) stays single player
    ws.onclose = () => {
      const was = this.everConnected; this.connected = false; this.h.onStatus?.(false);
      if (was) setTimeout(() => this.connect(this.name, this.car), 3000);
    };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) { this.h.onBinary?.(new Float32Array(e.data)); return; }
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'welcome') { this.id = m.id; this.h.onStatus?.(true); this.h.onWorld?.(m.world); for (const p of m.players) this.h.onJoin(p.id, p.name, p.tint, p.s, p.car); }
      else if (m.t === 'join') this.h.onJoin(m.id, m.name, m.tint, null, m.car);
      else if (m.t === 'leave') this.h.onLeave(m.id);
      else if (m.t === 'state') this.h.onState(m.id, m.s);
      else if (m.t === 'setting') this.h.onSetting?.(m.key, m.value, m.name);
      else if (m.t === 'car') this.h.onCar?.(m.id, m.car);
      else if (m.t === 'chat') this.h.onChat?.(m.name, m.text);
    };
  }

  sendBinary(buf) { if (this.connected) this.ws.send(buf); }
  sendJSON(m) { if (this.connected) this.ws.send(JSON.stringify(m)); }

  sendSetting(key, value) {
    if (this.connected) this.ws.send(JSON.stringify({ t: 'setting', key, value }));
  }

  setCar(car) {
    this.car = car;
    if (this.connected) this.ws.send(JSON.stringify({ t: 'car', car }));
  }

  update(dt, getState) {
    if (!this.connected) return;
    this.sendTimer += dt;
    if (this.sendTimer >= 0.05) {
      this.sendTimer = 0;
      const s = getState();
      s.ts = performance.now();
      this.ws.send(JSON.stringify({ t: 'state', s: compact(s) }));
    }
  }
}

function r(v, k = 1000) { return Math.round(v * k) / k; }
function compact(s) {
  return {
    lt: s.lt ? 1 : 0,
    p: s.p.map(v => r(v, 1000)), q: s.q.map(v => r(v, 10000)), v: s.v.map(v => r(v, 100)),
    w: s.w.map(a => a.map(v => r(v, 1000))), rpm: Math.round(s.rpm), gear: s.gear, thr: r(s.thr, 100), ts: s.ts,
  };
}
