// Lightweight procedural sound set built on the Web Audio API.
// Every effect is synthesised from oscillators + filtered noise, so the game
// ships with zero audio assets. Sounds are panned by horizontal position.

import { VIEW_W } from '../game/constants';
import { clamp } from '../utils/math';

export type SoundName =
  | 'uiClick' | 'uiHover' | 'count' | 'go'
  | 'shot' | 'shotOc' | 'ricochet' | 'padBounce'
  | 'hitPlayer' | 'hitShield' | 'shieldUp' | 'shieldBreak'
  | 'dash' | 'repulsor' | 'volt'
  | 'laserWarn' | 'zoneWarn' | 'zoneBoom'
  | 'coverHit' | 'coverBreak' | 'coverRepair'
  | 'wallUp' | 'wallBreak'
  | 'roundWin' | 'roundLose' | 'matchWin' | 'matchLose'
  | 'sudden' | 'fieldTick' | 'death' | 'error' | 'connect';

interface PlayOpts {
  x?: number;
  vol?: number;
  rate?: number;
}

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private volume: number;
  private lastPlayed = new Map<string, number>();

  constructor(initialVolume: number) {
    this.volume = initialVolume;
  }

  /** Must be called from a user gesture before anything can play. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      type AC = typeof AudioContext;
      const Ctor: AC | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: AC }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 24;
      comp.ratio.value = 6;
      comp.connect(this.ctx.destination);
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume * this.volume;
      this.master.connect(comp);
      // Pre-render one second of white noise, reused by every noise burst.
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volume * this.volume, this.ctx.currentTime, 0.05);
    }
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  // ---------------------------------------------------------------------

  private out(pan: number): AudioNode | null {
    if (!this.ctx || !this.master) return null;
    if (typeof this.ctx.createStereoPanner === 'function') {
      const p = this.ctx.createStereoPanner();
      p.pan.value = clamp(pan, -0.85, 0.85);
      p.connect(this.master);
      return p;
    }
    return this.master;
  }

  private panOf(opts?: PlayOpts): number {
    if (!opts || opts.x === undefined) return 0;
    return (opts.x / VIEW_W) * 1.7 - 0.85;
  }

  private tone(
    pan: number,
    type: OscillatorType,
    f0: number,
    f1: number,
    dur: number,
    vol: number,
    delay = 0,
    curve: 'exp' | 'lin' = 'exp',
  ): void {
    if (!this.ctx) return;
    const dest = this.out(pan);
    if (!dest) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, f0), t0);
    if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    else osc.frequency.linearRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(dest);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(
    pan: number,
    dur: number,
    vol: number,
    filterType: BiquadFilterType,
    f0: number,
    f1: number,
    q = 0.8,
    delay = 0,
  ): void {
    if (!this.ctx || !this.noiseBuf) return;
    const dest = this.out(pan);
    if (!dest) return;
    const t0 = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(Math.max(40, f0), t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(dest);
    src.start(t0, Math.random());
    src.stop(t0 + dur + 0.02);
  }

  // ---------------------------------------------------------------------

  play(name: SoundName, opts?: PlayOpts): void {
    if (!this.ctx || this.volume <= 0) return;
    // Basic rate limiting so identical sounds can't stack into a wall of noise.
    const now = performance.now();
    const last = this.lastPlayed.get(name) ?? -1e9;
    const minGap = name === 'ricochet' || name === 'coverHit' ? 40 : 25;
    if (now - last < minGap) return;
    this.lastPlayed.set(name, now);

    const pan = this.panOf(opts);
    const v = opts?.vol ?? 1;
    const rate = opts?.rate ?? 1;

    switch (name) {
      case 'uiClick':
        this.tone(0, 'square', 740, 980, 0.06, 0.12 * v);
        this.tone(0, 'sine', 1480, 1480, 0.05, 0.06 * v);
        break;
      case 'uiHover':
        this.tone(0, 'sine', 620, 660, 0.045, 0.05 * v);
        break;
      case 'count':
        this.tone(0, 'sine', 440, 438, 0.12, 0.22 * v);
        this.tone(0, 'sine', 880, 876, 0.1, 0.06 * v);
        break;
      case 'go':
        this.tone(0, 'sine', 660, 990, 0.2, 0.26 * v);
        this.tone(0, 'square', 330, 495, 0.18, 0.1 * v);
        break;
      case 'shot':
        this.tone(pan, 'sawtooth', 720 * rate, 260 * rate, 0.09, 0.16 * v);
        this.noise(pan, 0.05, 0.1 * v, 'highpass', 2200, 3200);
        break;
      case 'shotOc':
        this.tone(pan, 'sawtooth', 980, 320, 0.12, 0.2 * v);
        this.tone(pan, 'square', 490, 160, 0.1, 0.1 * v);
        this.noise(pan, 0.07, 0.12 * v, 'highpass', 1800, 3000);
        break;
      case 'ricochet':
        this.tone(pan, 'triangle', 1250 * rate, 850 * rate, 0.07, 0.16 * v);
        this.noise(pan, 0.045, 0.08 * v, 'highpass', 3000, 4200);
        break;
      case 'padBounce':
        this.tone(pan, 'triangle', 210, 640, 0.18, 0.24 * v);
        this.tone(pan, 'sine', 105, 320, 0.16, 0.16 * v);
        break;
      case 'hitPlayer':
        this.tone(pan, 'sine', 190, 70, 0.14, 0.3 * v);
        this.noise(pan, 0.09, 0.16 * v, 'bandpass', 900, 500, 1.2);
        break;
      case 'hitShield':
        this.tone(pan, 'sine', 520, 400, 0.08, 0.18 * v);
        this.tone(pan, 'sine', 1040, 800, 0.06, 0.08 * v);
        break;
      case 'shieldUp':
        this.tone(pan, 'sine', 420, 660, 0.16, 0.18 * v);
        this.tone(pan, 'sine', 630, 990, 0.16, 0.1 * v, 0.03);
        break;
      case 'shieldBreak':
        this.noise(pan, 0.22, 0.22 * v, 'bandpass', 2400, 700, 1.4);
        this.tone(pan, 'sine', 660, 180, 0.2, 0.14 * v);
        break;
      case 'dash':
        this.noise(pan, 0.16, 0.2 * v, 'bandpass', 600, 2400, 1);
        this.tone(pan, 'sine', 95, 190, 0.13, 0.2 * v);
        break;
      case 'repulsor':
        this.tone(pan, 'sine', 72, 40, 0.32, 0.36 * v);
        this.noise(pan, 0.28, 0.2 * v, 'lowpass', 1400, 220);
        break;
      case 'volt':
        this.tone(pan, 'square', 440, 445, 0.05, 0.12 * v);
        this.tone(pan, 'square', 660, 668, 0.05, 0.12 * v, 0.06);
        this.tone(pan, 'square', 880, 892, 0.08, 0.14 * v, 0.12);
        this.noise(pan, 0.2, 0.06 * v, 'highpass', 2400, 3400);
        break;
      case 'laserWarn':
        this.tone(pan, 'square', 220, 220, 0.09, 0.1 * v);
        this.tone(pan, 'square', 220, 220, 0.09, 0.1 * v, 0.16);
        break;
      case 'zoneWarn':
        this.tone(pan, 'square', 330, 330, 0.09, 0.09 * v);
        this.tone(pan, 'square', 262, 262, 0.11, 0.09 * v, 0.14);
        break;
      case 'zoneBoom':
        this.tone(pan, 'sine', 110, 36, 0.3, 0.34 * v);
        this.noise(pan, 0.26, 0.24 * v, 'lowpass', 2200, 240);
        break;
      case 'coverHit':
        this.tone(pan, 'triangle', 240, 140, 0.07, 0.14 * v);
        this.noise(pan, 0.05, 0.1 * v, 'bandpass', 700, 420, 1);
        break;
      case 'coverBreak':
        this.noise(pan, 0.3, 0.26 * v, 'lowpass', 1600, 180);
        this.tone(pan, 'sine', 150, 46, 0.26, 0.2 * v);
        this.noise(pan, 0.12, 0.1 * v, 'bandpass', 2200, 900, 1.2, 0.05);
        break;
      case 'coverRepair':
        this.tone(pan, 'sine', 330, 495, 0.12, 0.12 * v);
        this.tone(pan, 'sine', 495, 660, 0.12, 0.1 * v, 0.1);
        break;
      case 'wallUp':
        this.tone(pan, 'sawtooth', 90, 240, 0.22, 0.14 * v);
        this.tone(pan, 'sine', 180, 480, 0.2, 0.08 * v);
        break;
      case 'wallBreak':
        this.noise(pan, 0.18, 0.18 * v, 'bandpass', 2600, 800, 1.4);
        this.tone(pan, 'sine', 420, 120, 0.16, 0.1 * v);
        break;
      case 'roundWin':
        this.tone(0, 'sine', 523, 523, 0.11, 0.16 * v);
        this.tone(0, 'sine', 659, 659, 0.11, 0.16 * v, 0.11);
        this.tone(0, 'sine', 784, 784, 0.2, 0.18 * v, 0.22);
        break;
      case 'roundLose':
        this.tone(0, 'sine', 392, 392, 0.13, 0.14 * v);
        this.tone(0, 'sine', 311, 311, 0.22, 0.14 * v, 0.13);
        break;
      case 'matchWin':
        this.tone(0, 'sine', 523, 523, 0.12, 0.16 * v);
        this.tone(0, 'sine', 659, 659, 0.12, 0.16 * v, 0.12);
        this.tone(0, 'sine', 784, 784, 0.12, 0.16 * v, 0.24);
        this.tone(0, 'sine', 1047, 1047, 0.3, 0.2 * v, 0.36);
        this.tone(0, 'triangle', 262, 262, 0.5, 0.1 * v, 0.36);
        break;
      case 'matchLose':
        this.tone(0, 'sine', 440, 440, 0.16, 0.14 * v);
        this.tone(0, 'sine', 349, 349, 0.16, 0.14 * v, 0.16);
        this.tone(0, 'sine', 262, 262, 0.4, 0.16 * v, 0.32);
        break;
      case 'sudden':
        this.tone(0, 'sawtooth', 180, 360, 0.3, 0.16 * v);
        this.tone(0, 'sawtooth', 180, 360, 0.3, 0.16 * v, 0.35);
        break;
      case 'fieldTick':
        this.tone(pan, 'square', 880, 620, 0.05, 0.08 * v);
        break;
      case 'death':
        this.tone(pan, 'sine', 240, 40, 0.5, 0.3 * v);
        this.noise(pan, 0.4, 0.22 * v, 'lowpass', 3000, 200);
        break;
      case 'error':
        this.tone(0, 'square', 220, 165, 0.18, 0.12 * v);
        break;
      case 'connect':
        this.tone(0, 'sine', 523, 784, 0.14, 0.14 * v);
        break;
    }
  }

  /** Sustained laser hum; returns a stop function. */
  startLaserHum(x: number): () => void {
    if (!this.ctx) return () => {};
    const dest = this.out(this.panOf({ x }));
    if (!dest) return () => {};
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 96;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 192;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.09, t0 + 0.08);
    osc.connect(g);
    osc2.connect(g);
    g.connect(dest);
    osc.start(t0);
    osc2.start(t0);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      const t = ctx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.stop(t + 0.15);
      osc2.stop(t + 0.15);
    };
  }
}
