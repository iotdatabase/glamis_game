// In-game video recorder: the 3D view (canvas.captureStream) plus the engine sound, recorded with
// MediaRecorder and saved to the browser's Downloads as glamis-YYYYMMDD-HHMMSS.mp4 (or .webm).
// The HUD, radar and help panel are HTML on top of the canvas, so they are not in the video.

// best first: MP4 (H.264 + AAC) plays everywhere; WebM (VP9 / VP8 + Opus) where MP4 recording is missing
const TYPES = [
  'video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4',
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
];

export class GameRecorder {
  // canvas: the WebGL canvas; getAudio(): a MediaStream with the game sound (or null); onState(active, seconds)
  constructor(canvas, getAudio, onState) {
    this.canvas = canvas; this.getAudio = getAudio; this.onState = onState;
    this.rec = null; this.timer = 0;
  }

  get active() { return !!this.rec; }
  static supported() { return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream; }

  toggle() { if (this.rec) this.stop(); else this.start(); }

  start() {
    if (this.rec || !GameRecorder.supported()) return false;
    const stream = this.canvas.captureStream(60);
    const audio = this.getAudio?.();
    if (audio) for (const t of audio.getAudioTracks()) stream.addTrack(t);
    const mimeType = TYPES.find(t => MediaRecorder.isTypeSupported(t)) || '';
    // ~30 Mbit/s for 1440p60, scaled with the canvas size
    const px = this.canvas.width * this.canvas.height;
    const videoBitsPerSecond = Math.round(Math.min(40e6, Math.max(12e6, px / (2560 * 1440) * 30e6)));
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond, audioBitsPerSecond: 192000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      for (const t of stream.getVideoTracks()) t.stop();
      const type = rec.mimeType || mimeType || 'video/webm';
      this.save(new Blob(chunks, { type }), type.includes('mp4') ? 'mp4' : 'webm');
    };
    rec.start(1000);
    this.rec = rec; this.mimeType = mimeType; this.t0 = performance.now();
    this.onState?.(true, 0);
    this.timer = setInterval(() => this.onState?.(true, (performance.now() - this.t0) / 1000), 250);
    return true;
  }

  stop() {
    if (!this.rec) return;
    clearInterval(this.timer);
    const rec = this.rec; this.rec = null;
    rec.stop();
    this.onState?.(false, (performance.now() - this.t0) / 1000);
  }

  save(blob, ext) {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const name = `glamis-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    this.lastFile = { name, size: blob.size, type: blob.type };
    this.onSaved?.(this.lastFile);
  }
}
