// Screen feel: trauma-based shake, hit-stop, slow motion, full-screen flashes
// and a subtle zoom pulse. All of it respects the user's shake / reduced-flash
// settings.

import type { Settings } from '../game/settings';
import { clamp01 } from '../utils/math';

export class ScreenEffects {
  private trauma = 0;
  private hitstopT = 0;
  private slowmoT = 0;
  private slowmoF = 1;
  flashT = 0;
  flashLife = 0.001;
  flashColor = '#ffffff';
  flashStrength = 0;
  private zoomT = 0;
  private t = 0;

  constructor(private settings: Settings) {}

  addShake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  hitstop(dur: number): void {
    this.hitstopT = Math.max(this.hitstopT, dur);
  }

  slowmo(dur: number, factor: number): void {
    this.slowmoT = Math.max(this.slowmoT, dur);
    this.slowmoF = factor;
  }

  flash(color: string, strength: number, dur: number): void {
    if (this.settings.reducedFlashes) {
      strength *= 0.25;
      dur *= 0.7;
    }
    this.flashColor = color;
    this.flashStrength = strength;
    this.flashT = dur;
    this.flashLife = dur;
  }

  zoomPulse(): void {
    this.zoomT = 0.18;
  }

  reset(): void {
    this.trauma = 0;
    this.hitstopT = 0;
    this.slowmoT = 0;
    this.slowmoF = 1;
    this.flashT = 0;
    this.zoomT = 0;
  }

  /**
   * Advance by real frame time. Returns the timescale to apply to
   * simulation/particle time this frame (0 while hit-stopped).
   */
  update(rawDt: number): number {
    this.t += rawDt;
    this.trauma = Math.max(0, this.trauma - rawDt * 1.6);
    if (this.flashT > 0) this.flashT = Math.max(0, this.flashT - rawDt);
    if (this.zoomT > 0) this.zoomT = Math.max(0, this.zoomT - rawDt);
    if (this.hitstopT > 0) {
      this.hitstopT -= rawDt;
      return 0;
    }
    if (this.slowmoT > 0) {
      this.slowmoT -= rawDt;
      return this.slowmoF;
    }
    return 1;
  }

  /** Camera offset/rotation/zoom for this frame. */
  getCamera(): { x: number; y: number; rot: number; zoom: number } {
    const shake = this.trauma * this.trauma * this.settings.shake;
    const max = 13;
    const t = this.t;
    const x = shake * max * (Math.sin(t * 127.3) * 0.6 + Math.sin(t * 311.7) * 0.4);
    const y = shake * max * (Math.cos(t * 97.7) * 0.6 + Math.cos(t * 251.3) * 0.4);
    const rot = shake * 0.011 * Math.sin(t * 173.1);
    const zoom = 1 + (this.zoomT > 0 ? Math.sin((this.zoomT / 0.18) * Math.PI) * 0.014 : 0);
    return { x, y, rot, zoom };
  }

  get flashAlpha(): number {
    if (this.flashT <= 0) return 0;
    return clamp01(this.flashT / this.flashLife) * this.flashStrength;
  }
}
