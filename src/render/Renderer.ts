// Canvas world renderer: arena, fighters, projectiles, hazards, particles,
// banners and screen effects. One logical 1280x720 stage, letterboxed and
// DPI-aware. Static sprites — all motion is transforms, trails and glow.

import { COLORS, MAX_DPR, PLAYER, VIEW_H, VIEW_W, WEAPON, teamBright, teamColor, MODULES } from '../game/constants';
import type { ArenaDef } from '../game/arena';
import type { Settings } from '../game/settings';
import type {
  Presentation,
  Team,
  WorldView,
} from '../game/types';
import { coverState } from '../game/types';
import { AssetFactory, FIGHTER_DRAW, rgba, roundRect } from './AssetFactory';
import { HudRenderer } from './HudRenderer';
import type { ParticleSystem } from '../systems/ParticleSystem';
import type { ScreenEffects } from '../systems/ScreenEffects';
import { clamp01, lerp } from '../utils/math';

export interface PlayerAux {
  muzzleT: number;
  hitT: number;
  stretch: number;
  stretchAng: number;
  shieldHitT: number;
  deadT: number;
  deadX: number;
  deadY: number;
  trail: { x: number; y: number; a: number }[];
  trailTimer: number;
  aiTimer: number;
}

function makeAux(): PlayerAux {
  return {
    muzzleT: 0, hitT: 0, stretch: 0, stretchAng: 0, shieldHitT: 0,
    deadT: 0, deadX: 0, deadY: 0, trail: [], trailTimer: 0, aiTimer: 0,
  };
}

export interface DebugInfo {
  fps: number;
  tick: number;
  entities: number;
  particles: number;
  ping: number;
  role: string;
  aiState: string;
  event: string;
  shapes: boolean;
}

export interface FrameExtras {
  pres: Presentation | null;
  showHud: boolean;
  showReticle: boolean;
  mouseX: number;
  mouseY: number;
  hintAlpha: number;
  debug: DebugInfo | null;
}

export class Renderer {
  ctx: CanvasRenderingContext2D;
  hud: HudRenderer;
  aux: [PlayerAux, PlayerAux] = [makeAux(), makeAux()];
  private dpr = 1;
  private cssScale = 1;
  private cssOx = 0;
  private cssOy = 0;
  time = 0;
  private menuGlows: { x: number; y: number; vx: number; vy: number; s: number; c: string }[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private assets: AssetFactory,
    private particles: ParticleSystem,
    private effects: ScreenEffects,
    private settings: Settings,
    private arena: ArenaDef,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D unavailable');
    this.ctx = ctx;
    this.hud = new HudRenderer(assets);
    for (let i = 0; i < 26; i++) {
      this.menuGlows.push({
        x: Math.random() * VIEW_W,
        y: Math.random() * VIEW_H,
        vx: (Math.random() - 0.5) * 12,
        vy: (Math.random() - 0.5) * 12,
        s: 20 + Math.random() * 70,
        c: Math.random() < 0.5 ? COLORS.blue : COLORS.red,
      });
    }
  }

  resize(): { scale: number; ox: number; oy: number } {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const qualityCap = this.settings.quality === 'low' ? 1.25 : MAX_DPR;
    this.dpr = Math.min(window.devicePixelRatio || 1, qualityCap);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.cssScale = Math.min(w / VIEW_W, h / VIEW_H);
    this.cssOx = (w - VIEW_W * this.cssScale) / 2;
    this.cssOy = (h - VIEW_H * this.cssScale) / 2;
    return { scale: this.cssScale, ox: this.cssOx, oy: this.cssOy };
  }

  toLogical(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.cssOx) / this.cssScale,
      y: (sy - this.cssOy) / this.cssScale,
    };
  }

  resetRound(): void {
    for (const a of this.aux) {
      a.trail.length = 0;
      a.deadT = 0;
      a.hitT = 0;
      a.muzzleT = 0;
      a.stretch = 0;
      a.shieldHitT = 0;
    }
  }

  private beginFrame(worldSpace: boolean): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const s = this.cssScale * this.dpr;
    ctx.setTransform(s, 0, 0, s, this.cssOx * this.dpr, this.cssOy * this.dpr);
    if (worldSpace) {
      const cam = this.effects.getCamera();
      ctx.translate(VIEW_W / 2 + cam.x, VIEW_H / 2 + cam.y);
      ctx.rotate(cam.rot);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-VIEW_W / 2, -VIEW_H / 2);
    }
  }

  private toScreenSpace(): void {
    const s = this.cssScale * this.dpr;
    this.ctx.setTransform(s, 0, 0, s, this.cssOx * this.dpr, this.cssOy * this.dpr);
  }

  // =========================================================================
  // Menu backdrop
  // =========================================================================

  renderMenu(dt: number): void {
    this.time += dt;
    const ctx = this.ctx;
    this.beginFrame(false);
    ctx.drawImage(this.assets.background, 0, 0, VIEW_W, VIEW_H);

    // Slow ambient sweep.
    const sweepX = ((this.time * 60) % (VIEW_W + 600)) - 300;
    const grad = ctx.createLinearGradient(sweepX - 200, 0, sweepX + 200, 0);
    grad.addColorStop(0, 'rgba(90,180,255,0)');
    grad.addColorStop(0.5, 'rgba(90,180,255,0.05)');
    grad.addColorStop(1, 'rgba(90,180,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const g of this.menuGlows) {
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      if (g.x < -80) g.x = VIEW_W + 80;
      if (g.x > VIEW_W + 80) g.x = -80;
      if (g.y < -80) g.y = VIEW_H + 80;
      if (g.y > VIEW_H + 80) g.y = -80;
      ctx.globalAlpha = 0.05 + 0.03 * Math.sin(this.time + g.x);
      ctx.drawImage(this.assets.glow(g.c), g.x - g.s, g.y - g.s, g.s * 2, g.s * 2);
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // Dim for DOM readability.
    ctx.fillStyle = 'rgba(4,6,10,0.52)';
    ctx.fillRect(-4, -4, VIEW_W + 8, VIEW_H + 8);
  }

  // =========================================================================
  // World rendering
  // =========================================================================

  render(view: WorldView, dt: number, extras: FrameExtras): void {
    this.time += dt;
    const ctx = this.ctx;
    this.beginFrame(true);
    ctx.drawImage(this.assets.background, 0, 0, VIEW_W, VIEW_H);

    this.drawFloorDecals(view, dt);
    this.drawRubbleAndCovers(view);
    this.drawTempWalls(view);
    this.updateAux(view, dt);
    this.drawTrailsAndAfterimages(view);
    this.drawPlayers(view);
    this.drawProjectiles(view, dt);
    this.drawBeams(view);
    this.drawParticles();
    if (extras.debug?.shapes) this.drawCollisionShapes(view);

    // ---- screen space ----
    this.toScreenSpace();
    this.drawScreenTint(view);
    const fa = this.effects.flashAlpha;
    if (fa > 0) {
      ctx.globalAlpha = fa;
      ctx.fillStyle = this.effects.flashColor;
      ctx.fillRect(-4, -4, VIEW_W + 8, VIEW_H + 8);
      ctx.globalAlpha = 1;
    }
    if (extras.pres) this.drawPresentation(view, extras.pres);
    if (extras.showHud) this.hud.draw(ctx, view, dt);
    if (extras.hintAlpha > 0) this.drawHint(extras.hintAlpha);
    if (extras.showReticle) this.drawReticle(view, extras.mouseX, extras.mouseY);
    this.drawCorners(view);
    if (extras.debug) this.drawDebug(extras.debug);
  }

  // -------------------------------------------------------------------------

  private drawFloorDecals(view: WorldView, dt: number): void {
    const ctx = this.ctx;
    const a = this.arena;
    const t = this.time;

    // Sudden-death contracting field.
    if (view.suddenDeath && view.director.sdR < 770) {
      const r = view.director.sdR;
      ctx.save();
      ctx.beginPath();
      ctx.rect(-10, -10, VIEW_W + 20, VIEW_H + 20);
      ctx.arc(a.cx, a.cy, r, 0, Math.PI * 2, true);
      ctx.fillStyle = `rgba(150,10,26,${0.2 + 0.05 * Math.sin(t * 6)})`;
      ctx.fill('evenodd');
      ctx.restore();
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(COLORS.hazard, 0.7);
      ctx.lineWidth = 2.5;
      ctx.setLineDash([14, 10]);
      ctx.lineDashOffset = -t * 60;
      ctx.beginPath();
      ctx.arc(a.cx, a.cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = rgba(COLORS.hazard, 0.16);
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.arc(a.cx, a.cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Pads: idle pulse + surge glow.
    for (const pad of view.pads) {
      const surging = pad.surgeT > 0;
      const pulse = 0.5 + 0.5 * Math.sin(t * (surging ? 9 : 3) + pad.id * 1.7);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const color = surging ? COLORS.padSurge : COLORS.pad;
      ctx.globalAlpha = surging ? 0.45 + 0.3 * pulse : 0.12 + 0.1 * pulse;
      const gs = surging ? 58 : 40;
      ctx.drawImage(this.assets.glow(color), pad.x - gs, pad.y - gs, gs * 2, gs * 2);
      ctx.globalAlpha = surging ? 0.9 : 0.4;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pad.x, pad.y, pad.r - 4 + pulse * 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Director floor telegraphs.
    for (const ev of view.director.events) {
      const d = ev.desc;
      if (d.kind === 'dangerZones') {
        const warnFrac = clamp01(ev.t / d.warnT);
        const burning = ev.t >= d.warnT && ev.t < d.warnT + d.burnT;
        const fading = ev.t >= d.warnT + d.burnT;
        for (const z of d.zones) {
          if (fading) {
            const fa = clamp01(1 - (ev.t - d.warnT - d.burnT) / 0.45);
            ctx.globalAlpha = fa * 0.25;
            ctx.fillStyle = '#3b1010';
            ctx.beginPath();
            ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            continue;
          }
          if (!burning) {
            // Telegraph: outline + progressive fill + hazard icon.
            ctx.strokeStyle = rgba(COLORS.hazard, 0.55 + 0.3 * Math.sin(t * 10));
            ctx.lineWidth = 2.5;
            ctx.setLineDash([8, 6]);
            ctx.beginPath();
            ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = rgba(COLORS.hazard, 0.1 + warnFrac * 0.16);
            ctx.beginPath();
            ctx.moveTo(z.x, z.y);
            ctx.arc(z.x, z.y, z.r - 3, -Math.PI / 2, -Math.PI / 2 + warnFrac * Math.PI * 2);
            ctx.closePath();
            ctx.fill();
            this.drawHazardIcon(z.x, z.y, 12, 0.5 + 0.4 * Math.sin(t * 10));
          } else {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = rgba('#ff5a2e', 0.16 + 0.08 * Math.sin(t * 22));
            ctx.beginPath();
            ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = rgba('#ffb46a', 0.7);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
        }
      } else if (d.kind === 'coverShift' && ev.t < d.warnT) {
        const pulse = 0.4 + 0.4 * Math.sin(t * 9);
        if (d.op === 'raise') {
          const slot = this.arena.coverSlots[d.slot];
          if (slot) {
            ctx.strokeStyle = rgba(COLORS.pad, 0.4 + pulse * 0.4);
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 5]);
            ctx.strokeRect(slot.x - slot.w / 2, slot.y - slot.h / 2, slot.w, slot.h);
            ctx.setLineDash([]);
          }
        } else {
          const target = view.covers.find((c) => c.id === d.coverId);
          if (target) {
            const col = d.op === 'repair' ? COLORS.pad : COLORS.hazard;
            ctx.strokeStyle = rgba(col, 0.35 + pulse * 0.45);
            ctx.lineWidth = 3;
            ctx.strokeRect(target.x - target.w / 2 - 4, target.y - target.h / 2 - 4, target.w + 8, target.h + 8);
          }
        }
      }
    }

    // Temp wall telegraphs (phase 0).
    for (const w of view.tempWalls) {
      if (w.phase !== 0) continue;
      const f = clamp01(w.t / 1.0);
      ctx.strokeStyle = rgba(COLORS.energyWall, 0.3 + f * 0.5 + 0.15 * Math.sin(t * 12));
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(w.x - w.w / 2, w.y - w.h / 2, w.w, w.h);
      ctx.setLineDash([]);
      ctx.fillStyle = rgba(COLORS.energyWall, 0.08 + f * 0.12);
      ctx.fillRect(w.x - w.w / 2, w.y - w.h / 2, w.w, w.h);
    }

    // Laser warning lines (charging beams).
    for (const ev of view.director.events) {
      if (ev.desc.kind !== 'laserSweep' && ev.desc.kind !== 'crossfire') continue;
      for (const beam of ev.beams) {
        if (beam.active || beam.charge <= 0.02) continue;
        ctx.save();
        ctx.strokeStyle = rgba(COLORS.hazard, 0.15 + beam.charge * 0.5);
        ctx.lineWidth = 1.5 + beam.charge * 2;
        ctx.setLineDash([10, 8]);
        ctx.lineDashOffset = -t * 120;
        ctx.beginPath();
        ctx.moveTo(beam.x, beam.y);
        ctx.lineTo(beam.ex, beam.ey);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalCompositeOperation = 'lighter';
        const gs = 10 + beam.charge * 16;
        ctx.globalAlpha = beam.charge;
        ctx.drawImage(this.assets.glow(COLORS.hazard), beam.x - gs, beam.y - gs, gs * 2, gs * 2);
        ctx.restore();
      }
    }

    // Local player spawn arrow during countdown.
    if (view.phase === 0) {
      const p = view.players[view.localTeam];
      const bob = Math.sin(t * 5) * 4;
      ctx.save();
      ctx.fillStyle = teamColor(view.localTeam);
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 34 + bob);
      ctx.lineTo(p.x - 8, p.y - 48 + bob);
      ctx.lineTo(p.x + 8, p.y - 48 + bob);
      ctx.closePath();
      ctx.fill();
      ctx.font = '700 13px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('YOU', p.x, p.y - 54 + bob);
      ctx.restore();
    }
    void dt;
  }

  private drawHazardIcon(x: number, y: number, s: number, alpha: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = COLORS.hazard;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y - s);
    ctx.lineTo(x + s * 0.9, y + s * 0.7);
    ctx.lineTo(x - s * 0.9, y + s * 0.7);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = COLORS.hazard;
    ctx.fillRect(x - 1.2, y - s * 0.45, 2.4, s * 0.7);
    ctx.fillRect(x - 1.2, y + s * 0.38, 2.4, 2.4);
    ctx.restore();
  }

  private drawRubbleAndCovers(view: WorldView): void {
    const ctx = this.ctx;
    for (const c of view.covers) {
      if (c.hp > 0) continue;
      const spr = this.assets.cover(c.w, c.h, 'destroyed', c.temp);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(spr, c.x - c.w / 2 - 8, c.y - c.h / 2 - 8);
      ctx.globalAlpha = 1;
    }
    for (const c of view.covers) {
      if (c.hp <= 0) continue;
      const wob = c.wobble > 0 ? Math.sin(c.wobble * 60) * c.wobble * 8 : 0;
      // Soft directional shadow.
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      roundRect(ctx, c.x - c.w / 2 + 5, c.y - c.h / 2 + 9, c.w, c.h, 7);
      ctx.fill();
      const spr = this.assets.cover(c.w, c.h, coverState(c), c.temp);
      ctx.drawImage(spr, c.x - c.w / 2 - 8 + wob, c.y - c.h / 2 - 8);
    }
  }

  private drawTempWalls(view: WorldView): void {
    const ctx = this.ctx;
    const t = this.time;
    for (const w of view.tempWalls) {
      if (w.phase === 0) continue;
      let alpha = 1;
      let scaleY = 1;
      if (w.phase === 2) {
        const f = clamp01(w.t / 0.35);
        alpha = 1 - f;
        scaleY = 1 - f * 0.6;
      } else {
        alpha = Math.min(1, w.t * 8 + 0.3);
      }
      ctx.save();
      ctx.translate(w.x, w.y);
      ctx.scale(1, scaleY);
      ctx.globalAlpha = alpha * 0.8;
      const grad = ctx.createLinearGradient(0, -w.h / 2, 0, w.h / 2);
      grad.addColorStop(0, rgba(COLORS.energyWall, 0.75));
      grad.addColorStop(0.5, rgba('#c9aaff', 0.5));
      grad.addColorStop(1, rgba(COLORS.energyWall, 0.75));
      ctx.fillStyle = grad;
      roundRect(ctx, -w.w / 2, -w.h / 2, w.w, w.h, 4);
      ctx.fill();
      // Animated energy scan.
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      const span = Math.max(w.w, w.h);
      const off = (t * 90) % 24;
      ctx.beginPath();
      for (let k = -span; k < span; k += 24) {
        ctx.moveTo(-w.w / 2 + k + off, -w.h / 2 - 4);
        ctx.lineTo(-w.w / 2 + k + off + w.h + 8, w.h / 2 + 4);
      }
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = rgba('#d9c5ff', 0.9);
      ctx.lineWidth = 1.6;
      roundRect(ctx, w.x - w.w / 2, w.y - (w.h / 2) * scaleY, w.w, w.h * scaleY, 4);
      ctx.stroke();
      ctx.restore();
    }
  }

  private updateAux(view: WorldView, dt: number): void {
    for (let i = 0 as Team; i < 2; i = (i + 1) as Team) {
      const p = view.players[i];
      const a = this.aux[i];
      a.muzzleT = Math.max(0, a.muzzleT - dt * 6);
      a.hitT = Math.max(0, a.hitT - dt * 6.5);
      a.shieldHitT = Math.max(0, a.shieldHitT - dt * 6);
      a.stretch = Math.max(0, a.stretch - dt * 3.4);
      if (a.deadT > 0) a.deadT += dt;

      // Dash / launch trail points.
      const kbSpeed = Math.hypot(p.kbx, p.kby);
      const trailing = p.dashT > 0 || kbSpeed > 420;
      a.trailTimer -= dt;
      if (trailing && p.alive && a.trailTimer <= 0) {
        a.trailTimer = 0.014;
        a.trail.push({ x: p.x, y: p.y, a: 1 });
        if (a.trail.length > 26) a.trail.shift();
        a.aiTimer -= 0.014;
        if (a.aiTimer <= 0) {
          a.aiTimer = 0.03;
          this.particles.spawnAfterimage(i, p.x, p.y, p.aim);
        }
      }
      for (const tp of a.trail) tp.a -= dt * 3.4;
      while (a.trail.length > 0 && a.trail[0].a <= 0) a.trail.shift();
    }
  }

  private drawTrailsAndAfterimages(view: WorldView): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0 as Team; i < 2; i = (i + 1) as Team) {
      const a = this.aux[i];
      const glow = this.assets.glow(i === 0 ? COLORS.blue : COLORS.red);
      for (const tp of a.trail) {
        const s = 8 + tp.a * 22;
        ctx.globalAlpha = tp.a * 0.4;
        ctx.drawImage(glow, tp.x - s, tp.y - s, s * 2, s * 2);
      }
    }
    // Fighter afterimages.
    for (const ai of this.particles.afterimages) {
      if (!ai.alive) continue;
      const f = 1 - ai.t / ai.life;
      const spr = this.assets.fighters[ai.team];
      ctx.globalAlpha = f * 0.35;
      ctx.save();
      ctx.translate(ai.x, ai.y);
      ctx.rotate(ai.rot);
      ctx.drawImage(spr, -FIGHTER_DRAW / 2, -FIGHTER_DRAW / 2, FIGHTER_DRAW, FIGHTER_DRAW);
      ctx.restore();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private drawPlayers(view: WorldView): void {
    const ctx = this.ctx;
    const t = this.time;
    for (let i = 0 as Team; i < 2; i = (i + 1) as Team) {
      const p = view.players[i];
      const a = this.aux[i];
      const col = teamColor(i);

      if (!p.alive || a.deadT > 0) {
        // Scorch mark where the fighter went down.
        const dx = a.deadT > 0 ? a.deadX : p.x;
        const dy = a.deadT > 0 ? a.deadY : p.y;
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = 'rgba(8,8,12,0.85)';
        ctx.beginPath();
        ctx.ellipse(dx, dy, 22, 16, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        continue;
      }

      // Shadow.
      ctx.fillStyle = 'rgba(0,0,0,0.34)';
      ctx.beginPath();
      ctx.ellipse(p.x + 5, p.y + 9, 20, 13, 0, 0, Math.PI * 2);
      ctx.fill();

      // Ground marker ring + aim wedge.
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 23, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      const wa = p.aim;
      ctx.moveTo(p.x + Math.cos(wa) * 27, p.y + Math.sin(wa) * 27);
      ctx.lineTo(p.x + Math.cos(wa + 0.35) * 20, p.y + Math.sin(wa + 0.35) * 20);
      ctx.lineTo(p.x + Math.cos(wa - 0.35) * 20, p.y + Math.sin(wa - 0.35) * 20);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.restore();

      // Volt charge aura.
      if (p.voltShots > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.3 + 0.15 * Math.sin(t * 18);
        const g = this.assets.glow(i === 0 ? COLORS.blueBright : '#ffcf8a');
        ctx.drawImage(g, p.x - 34, p.y - 34, 68, 68);
        ctx.restore();
      }

      // The fighter sprite: rotation + squash/stretch only, no frame animation.
      ctx.save();
      ctx.translate(p.x, p.y);
      if (a.stretch > 0.01) {
        ctx.rotate(a.stretchAng);
        ctx.scale(1 + a.stretch * 0.45, 1 - a.stretch * 0.28);
        ctx.rotate(-a.stretchAng);
      }
      ctx.rotate(p.aim);
      const recoil = a.muzzleT * 5;
      ctx.translate(-recoil, 0);
      if (p.invulnT > 0) ctx.globalAlpha = 0.65 + 0.25 * Math.sin(t * 60);
      ctx.drawImage(this.assets.fighters[i], -FIGHTER_DRAW / 2, -FIGHTER_DRAW / 2, FIGHTER_DRAW, FIGHTER_DRAW);
      if (a.hitT > 0) {
        ctx.globalAlpha = Math.min(1, a.hitT * 1.4);
        ctx.drawImage(this.assets.fighterFlashes[i], -FIGHTER_DRAW / 2, -FIGHTER_DRAW / 2, FIGHTER_DRAW, FIGHTER_DRAW);
      }
      ctx.globalAlpha = 1;
      // Muzzle flash.
      if (a.muzzleT > 0.35) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = (a.muzzleT - 0.35) * 1.4;
        ctx.translate(WEAPON.muzzleOffset + recoil, 0);
        ctx.fillStyle = teamBright(i);
        ctx.beginPath();
        ctx.moveTo(12, 0);
        ctx.lineTo(-2, -5);
        ctx.lineTo(2, 0);
        ctx.lineTo(-2, 5);
        ctx.closePath();
        ctx.fill();
        const g = this.assets.glow(col);
        ctx.drawImage(g, -12, -12, 24, 24);
        ctx.restore();
      }
      ctx.restore();

      // Aegis shield bubble.
      if (p.shieldHp > 0) {
        const frac = p.shieldHp / MODULES.aegis.absorb;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const shieldCol = i === 0 ? COLORS.blue : COLORS.red;
        ctx.globalAlpha = 0.35 + frac * 0.3 + a.shieldHitT * 0.4;
        ctx.strokeStyle = shieldCol;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 31, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.16 + a.shieldHitT * 0.3;
        ctx.drawImage(this.assets.glow(shieldCol), p.x - 38, p.y - 38, 76, 76);
        // Rotating segment arcs.
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 3;
        for (let s = 0; s < 3; s++) {
          const base = t * 2.4 + (s * Math.PI * 2) / 3;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 34, base, base + 0.9);
          ctx.stroke();
        }
        if (a.shieldHitT > 0.3) {
          // Crack flash lines when absorbing damage.
          ctx.globalAlpha = a.shieldHitT;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (let s = 0; s < 4; s++) {
            const ca = (s * Math.PI) / 2 + t * 3;
            ctx.moveTo(p.x + Math.cos(ca) * 22, p.y + Math.sin(ca) * 22);
            ctx.lineTo(p.x + Math.cos(ca + 0.4) * 33, p.y + Math.sin(ca + 0.4) * 33);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  private drawProjectiles(view: WorldView, dt: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const pr of view.projectiles) {
      if (pr.dead) continue;
      // Maintain a short render trail on the projectile object itself.
      pr.trail.push(pr.x, pr.y);
      if (pr.trail.length > (pr.oc ? 22 : 16)) pr.trail.splice(0, 2);

      const col = pr.owner === 0 ? COLORS.blue : COLORS.redProj;
      const bright = pr.owner === 0 ? COLORS.blueBright : '#ffe4c9';
      if (pr.trail.length >= 4) {
        ctx.strokeStyle = rgba(col, 0.32);
        ctx.lineWidth = pr.oc ? 8 : 5.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(pr.trail[0], pr.trail[1]);
        for (let k = 2; k < pr.trail.length; k += 2) ctx.lineTo(pr.trail[k], pr.trail[k + 1]);
        ctx.stroke();
        ctx.strokeStyle = rgba(bright, 0.5);
        ctx.lineWidth = pr.oc ? 3 : 2;
        ctx.beginPath();
        const start = Math.max(0, pr.trail.length - 10);
        ctx.moveTo(pr.trail[start], pr.trail[start + 1]);
        for (let k = start + 2; k < pr.trail.length; k += 2) ctx.lineTo(pr.trail[k], pr.trail[k + 1]);
        ctx.stroke();
      }
      const gs = pr.oc ? 20 : 13;
      ctx.drawImage(this.assets.glow(col), pr.x - gs, pr.y - gs, gs * 2, gs * 2);
      ctx.fillStyle = bright;
      ctx.beginPath();
      const jitter = pr.oc ? Math.sin(this.time * 60 + pr.id) * 0.8 : 0;
      ctx.arc(pr.x + jitter, pr.y - jitter, pr.oc ? 4.4 : 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    void dt;
  }

  private drawBeams(view: WorldView): void {
    const ctx = this.ctx;
    for (const ev of view.director.events) {
      if (ev.desc.kind !== 'laserSweep' && ev.desc.kind !== 'crossfire') continue;
      for (const beam of ev.beams) {
        if (!beam.active) continue;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        ctx.strokeStyle = rgba(COLORS.hazard, 0.2);
        ctx.lineWidth = 17;
        ctx.beginPath();
        ctx.moveTo(beam.x, beam.y);
        ctx.lineTo(beam.ex, beam.ey);
        ctx.stroke();
        ctx.strokeStyle = rgba('#ff6b5e', 0.65);
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(beam.x, beam.y);
        ctx.lineTo(beam.ex, beam.ey);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,240,235,0.95)';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(beam.x, beam.y);
        ctx.lineTo(beam.ex, beam.ey);
        ctx.stroke();
        // Emitter + impact glows.
        ctx.drawImage(this.assets.glow(COLORS.hazard), beam.x - 22, beam.y - 22, 44, 44);
        const ig = 14 + Math.sin(this.time * 40) * 3;
        ctx.drawImage(this.assets.glow('#ffffff'), beam.ex - ig, beam.ey - ig, ig * 2, ig * 2);
        ctx.restore();
        // Sparks where the beam terminates.
        if (Math.random() < 0.5) {
          this.particles.spawnSparks(
            beam.ex, beam.ey,
            beam.ang + Math.PI, 1.6, 1, 160, 0.3, 1.6, COLORS.warn,
          );
        }
      }
    }
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    // Non-additive first (debris).
    for (const p of this.particles.particles) {
      if (!p.alive || p.additive) continue;
      const f = 1 - p.t / p.life;
      ctx.globalAlpha = Math.min(1, f * 1.6);
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles.particles) {
      if (!p.alive || !p.additive) continue;
      const f = 1 - p.t / p.life;
      if (p.type === 0) {
        // Spark: short streak along velocity.
        ctx.globalAlpha = f;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size;
        ctx.lineCap = 'round';
        const vl = Math.max(1, Math.hypot(p.vx, p.vy));
        const nx = (p.vx / vl) * (4 + p.size * 2);
        const ny = (p.vy / vl) * (4 + p.size * 2);
        ctx.beginPath();
        ctx.moveTo(p.x - nx, p.y - ny);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      } else {
        ctx.globalAlpha = f * 0.8;
        const g = this.assets.glow(p.color);
        const s = p.size * (0.6 + (1 - f) * 0.8);
        ctx.drawImage(g, p.x - s, p.y - s, s * 2, s * 2);
      }
    }
    // Rings.
    for (const r of this.particles.rings) {
      if (!r.alive) continue;
      const f = r.t / r.life;
      const radius = lerp(6, r.r1, 1 - (1 - f) * (1 - f));
      ctx.globalAlpha = (1 - f) * 0.85;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(1, r.width * (1 - f));
      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    // Floating damage numbers.
    ctx.font = '800 15px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const ft of this.particles.texts) {
      if (!ft.alive) continue;
      const f = 1 - ft.t / ft.life;
      ctx.globalAlpha = Math.min(1, f * 2);
      ctx.fillStyle = '#0a0d12';
      ctx.fillText(ft.str, ft.x + 1, ft.y + 1);
      ctx.fillStyle = ft.color;
      ctx.fillText(ft.str, ft.x, ft.y);
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------------
  // Screen-space layers
  // -------------------------------------------------------------------------

  private drawScreenTint(view: WorldView): void {
    const ctx = this.ctx;
    const local = view.players[view.localTeam];
    if (local.alive && local.hp <= 30 && view.phase === 1) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * (this.settings.reducedFlashes ? 3 : 6));
      const a = (0.16 + pulse * 0.12) * (this.settings.reducedFlashes ? 0.5 : 1);
      const g = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.36, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.75);
      g.addColorStop(0, 'rgba(255,30,40,0)');
      g.addColorStop(1, `rgba(255,30,40,${a})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    if (view.suddenDeath && view.phase === 1) {
      ctx.fillStyle = 'rgba(255,40,40,0.045)';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
  }

  private arcadeText(
    text: string, x: number, y: number, size: number,
    color: string, glow: string, alpha: number,
  ): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 italic ${size}px "Segoe UI", "Arial Black", system-ui, sans-serif`;
    ctx.shadowColor = glow;
    ctx.shadowBlur = size * 0.45;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = 0;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  private drawPresentation(view: WorldView, pres: Presentation): void {
    const cx = VIEW_W / 2;
    const cy = VIEW_H / 2;
    const t = pres.t;
    switch (pres.kind) {
      case 'roundIntro': {
        // "ROUND N" then a 3-2-1 countdown driven by the sim phase timer.
        if (t < 1.0) {
          const a = Math.min(1, t * 5) * (t > 0.82 ? (1.0 - t) / 0.18 : 1);
          const slide = (1 - Math.min(1, t * 5)) * 60;
          this.arcadeText(pres.text, cx + slide, cy - 60, 64, '#eaf6ff', COLORS.blue, a);
          if (pres.sub) this.arcadeText(pres.sub, cx + slide, cy - 8, 22, '#9fb8d8', '#000', a * 0.9);
        }
        const remaining = view.phaseT;
        if (remaining > 0 && remaining <= 2.4 && view.phase === 0) {
          const n = Math.ceil(remaining / 0.8);
          const segT = remaining / 0.8 - (n - 1); // 1 → 0 within each beat
          const scale = 1 + (1 - segT) * 0.5;
          const alpha = Math.min(1, segT * 3);
          this.arcadeText(String(n), cx, cy + 40, 88 * scale, '#ffffff', COLORS.blue, alpha * 0.95);
        }
        break;
      }
      case 'fight': {
        const a = t < 0.12 ? t / 0.12 : Math.max(0, 1 - (t - 0.3) / 0.35);
        const scale = 1 + Math.min(1, t * 6) * 0.12;
        this.arcadeText('FIGHT!', cx, cy - 20, 84 * scale, '#ffffff', COLORS.warn, a);
        break;
      }
      case 'suddenDeath': {
        const a = Math.min(1, t * 4) * (t > 1.6 ? Math.max(0, 1 - (t - 1.6) / 0.4) : 1);
        const pulse = 1 + 0.05 * Math.sin(t * 20);
        this.arcadeText('SUDDEN DEATH', cx, cy - 40, 60 * pulse, '#ffdada', COLORS.hazard, a);
        this.arcadeText('THE ARENA IS CLOSING IN', cx, cy + 14, 20, '#ff9d9d', '#000', a * 0.85);
        break;
      }
      case 'roundEnd':
      case 'doubleKo': {
        const a = Math.min(1, t * 4);
        const col = pres.kind === 'doubleKo' ? '#ffd6a0' : teamColor(pres.data as Team);
        this.ctx.save();
        this.ctx.globalAlpha = Math.min(0.45, t * 2);
        this.ctx.fillStyle = 'rgba(4,8,14,0.55)';
        this.ctx.fillRect(0, cy - 110, VIEW_W, 220);
        this.ctx.restore();
        this.arcadeText(pres.text, cx, cy - 28, 56, col, col, a);
        if (pres.sub) this.arcadeText(pres.sub, cx, cy + 30, 26, '#cfe0f4', '#000', a * 0.9);
        break;
      }
      case 'matchEnd': {
        const a = Math.min(1, t * 3);
        this.ctx.save();
        this.ctx.globalAlpha = Math.min(0.72, t * 1.5);
        this.ctx.fillStyle = 'rgba(3,5,10,0.8)';
        this.ctx.fillRect(0, 0, VIEW_W, VIEW_H);
        this.ctx.restore();
        const col = teamColor(pres.data as Team);
        this.arcadeText(pres.text, cx, cy - 130, 72, col, col, a);
        if (pres.sub) this.arcadeText(pres.sub, cx, cy - 66, 28, '#cfe0f4', '#000', a * 0.9);
        break;
      }
    }
  }

  private drawReticle(view: WorldView, mx: number, my: number): void {
    const ctx = this.ctx;
    const local = view.players[view.localTeam];
    const readyFrac = local.fireCd <= 0 ? 1 : 1 - local.fireCd / (local.voltShots > 0 ? MODULES.volt.interval : WEAPON.interval);
    const a = this.aux[view.localTeam];
    const expand = a.muzzleT * 6;
    const r = 11 + expand;
    const col = teamColor(view.localTeam);
    ctx.save();
    ctx.globalAlpha = 0.35 + readyFrac * 0.6;
    ctx.strokeStyle = readyFrac >= 1 ? col : rgba(col, 0.7);
    ctx.lineWidth = readyFrac >= 1 ? 2 : 1.4;
    ctx.beginPath();
    ctx.arc(mx, my, r, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const ang = (i * Math.PI) / 2 + Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(mx + Math.cos(ang) * (r + 3), my + Math.sin(ang) * (r + 3));
      ctx.lineTo(mx + Math.cos(ang) * (r + 8), my + Math.sin(ang) * (r + 8));
      ctx.stroke();
    }
    // Cooldown sweep inside the ring.
    if (readyFrac < 1) {
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(mx, my, r - 4, -Math.PI / 2, -Math.PI / 2 + readyFrac * Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = readyFrac >= 1 ? col : rgba(col, 0.5);
    ctx.beginPath();
    ctx.arc(mx, my, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawHint(alpha: number): void {
    const ctx = this.ctx;
    const w = 560;
    const h = 44;
    const x = VIEW_W / 2 - w / 2;
    const y = VIEW_H - 66;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(8,12,22,0.82)';
    roundRect(ctx, x, y, w, h, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(110,180,255,0.3)';
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 10);
    ctx.stroke();
    ctx.fillStyle = '#cfe2ff';
    ctx.font = '600 15px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WASD move   ·   Mouse aim   ·   LMB fire   ·   SPACE dash   ·   E module', VIEW_W / 2, y + h / 2);
    ctx.restore();
  }

  private drawCorners(view: WorldView): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '500 11px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(140,165,200,0.4)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`DASH DUEL v${__APP_VERSION__}`, 10, VIEW_H - 8);
    if (view.online) {
      const ping = view.ping;
      const col = ping <= 0 ? '#8fa5c5' : ping < 80 ? '#57e389' : ping < 160 ? '#ffc247' : '#ff5d5d';
      ctx.textAlign = 'right';
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(VIEW_W - 66, VIEW_H - 14, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(200,220,245,0.75)';
      ctx.fillText(ping > 0 ? `${Math.round(ping)} ms` : '— ms', VIEW_W - 12, VIEW_H - 8);
    }
    ctx.restore();
  }

  private drawCollisionShapes(view: WorldView): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,255,120,0.6)';
    ctx.lineWidth = 1;
    for (const p of view.players) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const c of view.covers) {
      if (c.hp <= 0) continue;
      ctx.strokeRect(c.x - c.w / 2, c.y - c.h / 2, c.w, c.h);
    }
    for (const w of view.tempWalls) {
      if (w.phase !== 1) continue;
      ctx.strokeRect(w.x - w.w / 2, w.y - w.h / 2, w.w, w.h);
    }
    ctx.strokeStyle = 'rgba(255,180,0,0.6)';
    for (const pr of view.projectiles) {
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, WEAPON.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const s of this.arena.segs) {
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawDebug(d: DebugInfo): void {
    const ctx = this.ctx;
    const lines = [
      `fps ${d.fps.toFixed(0)}   tick ${d.tick}`,
      `entities ${d.entities}   particles ${d.particles}`,
      `role ${d.role}   ping ${d.ping > 0 ? d.ping.toFixed(0) + 'ms' : '—'}`,
      `event ${d.event}`,
      `ai ${d.aiState}`,
      `F3: overlay   (collision shapes ${d.shapes ? 'on' : 'off'})`,
    ];
    ctx.save();
    ctx.fillStyle = 'rgba(5,10,18,0.8)';
    ctx.fillRect(8, 88, 250, 16 * lines.length + 12);
    ctx.fillStyle = '#8ff0a8';
    ctx.font = '500 12px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, 16, 94 + i * 16));
    ctx.restore();
  }

  /** Public FX helpers used by the Game's event router. */
  flashPlayer(team: Team): void {
    this.aux[team].hitT = 1;
  }

  muzzle(team: Team): void {
    this.aux[team].muzzleT = 1;
  }

  stretchPlayer(team: Team, ang: number, amount: number): void {
    const a = this.aux[team];
    a.stretch = amount;
    a.stretchAng = ang;
  }

  shieldHit(team: Team): void {
    this.aux[team].shieldHitT = 1;
  }

  markDead(team: Team, x: number, y: number): void {
    const a = this.aux[team];
    a.deadT = 0.001;
    a.deadX = x;
    a.deadY = y;
  }
}
