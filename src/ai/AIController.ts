// Solo Battle opponent. The AI plays by the same rules as the player: it
// produces a normal InputState each tick, obeys the same cooldowns, and only
// reads information a human could see (positions, hazards, telegraphs).
// Movement uses simple candidate-direction steering scored against hazards,
// projectile paths, range and line of sight — no navmesh.

import { AI_CONFIGS, MODULES, PLAYER, WEAPON } from '../game/constants';
import type { Simulation } from '../game/Simulation';
import type { Difficulty, InputState, PlayerState, Team } from '../game/types';
import {
  angDiff,
  clamp,
  dist,
  norm,
  pointSegDist,
  rotateToward,
  segRectHit,
} from '../utils/math';

interface Candidate {
  x: number;
  y: number;
  score: number;
}

export class AIController {
  private cfg: (typeof AI_CONFIGS)[Difficulty];
  private decideT = 0;
  private targetMx = 0;
  private targetMy = 0;
  private mx = 0;
  private my = 0;
  private aim: number;
  private noisePhase = Math.random() * 100;
  private seenT = 0;
  private hesitateT = 0;
  private bankCd = 2;
  private bankT = 0;
  private bankAim = 0;
  private dashEvalCd = 0;
  private moduleEvalCd = 0;
  /** Debug label shown on the F3 overlay. */
  state = 'idle';

  constructor(public team: Team, public difficulty: Difficulty) {
    this.cfg = AI_CONFIGS[difficulty];
    this.aim = team === 0 ? 0 : Math.PI;
  }

  pickModule(): 'aegis' | 'repulsor' | 'volt' {
    const all = ['aegis', 'repulsor', 'volt'] as const;
    if (this.difficulty === 'hard') {
      return Math.random() < 0.5 ? 'aegis' : 'volt';
    }
    return all[Math.floor(Math.random() * all.length)];
  }

  update(sim: Simulation, dt: number): InputState {
    const me = sim.players[this.team];
    const foe = sim.players[(1 - this.team) as Team];
    const cfg = this.cfg;

    const inp: InputState = { mx: 0, my: 0, aim: this.aim, fire: false, dash: false, module: false };
    if (!me.alive || sim.phase !== 1) {
      // Track the opponent with the eyes even while locked.
      const want = Math.atan2(foe.y - me.y, foe.x - me.x);
      this.aim = rotateToward(this.aim, want, cfg.turnRate * 0.5 * dt);
      inp.aim = this.aim;
      return inp;
    }

    this.decideT -= dt;
    this.dashEvalCd = Math.max(0, this.dashEvalCd - dt);
    this.moduleEvalCd = Math.max(0, this.moduleEvalCd - dt);
    this.hesitateT = Math.max(0, this.hesitateT - dt);
    this.bankCd = Math.max(0, this.bankCd - dt);
    this.bankT = Math.max(0, this.bankT - dt);

    const los = this.hasLos(sim, me.x, me.y, foe.x, foe.y);
    if (los) this.seenT += dt;
    else this.seenT = Math.max(0, this.seenT - dt * 2);

    // ---- steering ----
    if (this.decideT <= 0) {
      this.decideT = cfg.decide * (0.8 + Math.random() * 0.4);
      this.chooseDirection(sim, me, foe, los);
    }
    this.mx += (this.targetMx - this.mx) * Math.min(1, 9 * dt);
    this.my += (this.targetMy - this.my) * Math.min(1, 9 * dt);
    inp.mx = this.mx;
    inp.my = this.my;

    // ---- aiming ----
    const d = dist(me.x, me.y, foe.x, foe.y);
    const lead = (d / WEAPON.speed) * cfg.prediction;
    let tx = foe.x + foe.vx * lead;
    let ty = foe.y + foe.vy * lead;
    let wantAim = Math.atan2(ty - me.y, tx - me.x);
    if (this.bankT > 0) wantAim = this.bankAim;
    const noise =
      Math.sin(sim.time * cfg.aimWander + this.noisePhase) * cfg.aimErr +
      Math.sin(sim.time * cfg.aimWander * 2.7 + this.noisePhase * 2) * cfg.aimErr * 0.5;
    wantAim += noise;
    this.aim = rotateToward(this.aim, wantAim, cfg.turnRate * dt);
    inp.aim = this.aim;

    // ---- firing ----
    const aimClose = Math.abs(angDiff(this.aim, wantAim)) < 0.14;
    const reacted = this.seenT >= cfg.reaction;
    if (this.bankT > 0 && aimClose && this.hesitateT <= 0) {
      inp.fire = true;
      this.state = 'bank shot';
    } else if (los && reacted && aimClose && this.hesitateT <= 0) {
      inp.fire = true;
      this.state = 'attacking';
      if (me.fireCd <= 0 && Math.random() < 0.5) {
        this.hesitateT = Math.random() * cfg.fireHesitation;
      }
    }

    // Attempt a bank shot when vision is blocked.
    if (!los && cfg.bankShots && this.bankCd <= 0 && this.bankT <= 0) {
      this.bankCd = 3 + Math.random() * 3;
      const bank = this.findBankShot(sim, me, foe);
      if (bank !== null) {
        this.bankAim = bank;
        this.bankT = 0.7;
      }
    }

    // ---- dash ----
    if (me.dashCd <= 0 && this.dashEvalCd <= 0) {
      const dash = this.considerDash(sim, me);
      if (dash) {
        this.dashEvalCd = 0.35;
        if (Math.random() < this.cfg.dashChance) {
          inp.dash = true;
          inp.mx = dash.x;
          inp.my = dash.y;
          this.targetMx = dash.x;
          this.targetMy = dash.y;
          this.state = 'dodging';
        }
      }
    }

    // ---- power module ----
    if (me.moduleCd <= 0 && this.moduleEvalCd <= 0) {
      this.moduleEvalCd = 0.3;
      if (this.considerModule(sim, me, foe, los, d) && Math.random() < cfg.moduleChance) {
        inp.module = true;
      }
    }

    return inp;
  }

  // -------------------------------------------------------------------------

  private chooseDirection(sim: Simulation, me: PlayerState, foe: PlayerState, los: boolean): void {
    const cfg = this.cfg;
    const desired = 330;
    const d = dist(me.x, me.y, foe.x, foe.y);
    const toFoe = norm(foe.x - me.x, foe.y - me.y);
    const perp = { x: -toFoe.y, y: toFoe.x };
    const wantCover = me.hp < 35 && foe.voltShots > 0;

    const candidates: Candidate[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      candidates.push({ x: Math.cos(a), y: Math.sin(a), score: 0 });
    }
    candidates.push({ x: 0, y: 0, score: -3 });

    for (const c of candidates) {
      const fx = me.x + c.x * 140;
      const fy = me.y + c.y * 140;

      // Stay inside the arena.
      for (const s of sim.arena.segs) {
        const sd = (fx - s.ax) * s.nx + (fy - s.ay) * s.ny;
        if (sd < 30) c.score -= (30 - sd) * 0.6;
        else if (sd < 65) c.score -= (65 - sd) * 0.15;
      }
      // Don't steer into cover.
      for (const cv of sim.covers) {
        if (cv.hp <= 0) continue;
        if (
          Math.abs(fx - cv.x) < cv.w / 2 + PLAYER.radius &&
          Math.abs(fy - cv.y) < cv.h / 2 + PLAYER.radius
        ) {
          c.score -= 30;
        }
      }
      // Hazards from the director.
      for (const ev of sim.director.active) {
        const desc = ev.desc;
        if (desc.kind === 'laserSweep' || desc.kind === 'crossfire') {
          for (const beam of ev.beams) {
            if (!beam.active && beam.charge < 0.4) continue;
            const bd = pointSegDist(fx, fy, beam.x, beam.y, beam.ex, beam.ey);
            const danger = beam.active ? 1.2 : 0.5;
            if (bd < 80) c.score -= (80 - bd) * danger * cfg.threatWeight * 0.55;
          }
        } else if (desc.kind === 'dangerZones') {
          const burning = ev.t >= desc.warnT;
          for (const z of desc.zones) {
            const zd = dist(fx, fy, z.x, z.y);
            const margin = z.r + 34;
            if (zd < margin) c.score -= (margin - zd) * (burning ? 1.5 : 0.85) * cfg.threatWeight;
          }
        }
      }
      // Rising wall telegraphs.
      for (const w of sim.tempWalls) {
        if (w.phase === 0 && Math.abs(fx - w.x) < w.w / 2 + 26 && Math.abs(fy - w.y) < w.h / 2 + 26) {
          c.score -= 22;
        }
      }
      // Sudden-death field.
      if (sim.suddenDeath) {
        const cd = dist(fx, fy, sim.arena.cx, sim.arena.cy);
        if (cd > sim.sdR - 70) c.score -= (cd - (sim.sdR - 70)) * 0.8;
        c.score -= cd * 0.01;
      }
      // Enemy projectile paths.
      for (const pr of sim.projectiles) {
        if (pr.dead || pr.owner === this.team) continue;
        const relx = fx - pr.x;
        const rely = fy - pr.y;
        if (relx * pr.vx + rely * pr.vy <= 0) continue; // moving away
        const pd = pointSegDist(fx, fy, pr.x, pr.y, pr.x + pr.vx * 0.7, pr.y + pr.vy * 0.7);
        if (pd < 55) c.score -= (55 - pd) * 1.1 * cfg.threatWeight;
      }
      // Preferred combat range.
      const fd = dist(fx, fy, foe.x, foe.y);
      c.score -= Math.abs(fd - desired) * 0.055;
      // Line of sight preferences.
      const fLos = this.hasLos(sim, fx, fy, foe.x, foe.y);
      if (wantCover) {
        if (!fLos) c.score += 14;
      } else if (fLos && me.fireCd < 0.25) {
        c.score += 10;
      } else if (!los && !fLos) {
        c.score -= 4; // don't hide forever
      }
      // Encourage strafing and steady movement.
      c.score += Math.abs(c.x * perp.x + c.y * perp.y) * 5;
      c.score += (c.x * this.targetMx + c.y * this.targetMy) * 3.5;
    }

    let best = candidates[0];
    for (const c of candidates) if (c.score > best.score) best = c;
    this.targetMx = best.x;
    this.targetMy = best.y;
    if (this.state !== 'dodging') {
      this.state = best.x === 0 && best.y === 0 ? 'holding' : 'repositioning';
    }
  }

  private hasLos(sim: Simulation, ax: number, ay: number, bx: number, by: number): boolean {
    for (const c of sim.covers) {
      if (c.hp <= 0) continue;
      if (segRectHit(ax, ay, bx, by, c.x, c.y, c.w / 2, c.h / 2)) return false;
    }
    for (const w of sim.tempWalls) {
      if (w.phase !== 1) continue;
      if (segRectHit(ax, ay, bx, by, w.x, w.y, w.w / 2, w.h / 2)) return false;
    }
    return true;
  }

  /** Try a one-bounce wall shot by mirroring the target across an outer wall. */
  private findBankShot(sim: Simulation, me: PlayerState, foe: PlayerState): number | null {
    const a = sim.arena;
    const mirrors = [
      { x: 2 * a.left - foe.x, y: foe.y },
      { x: 2 * a.right - foe.x, y: foe.y },
      { x: foe.x, y: 2 * a.top - foe.y },
      { x: foe.x, y: 2 * a.bottom - foe.y },
    ];
    for (const m of mirrors) {
      const dx = m.x - me.x;
      const dy = m.y - me.y;
      const L = Math.hypot(dx, dy);
      if (L < 60 || L > 1500) continue;
      // Find where the shot meets the wall plane.
      let hitX: number;
      let hitY: number;
      if (m.x !== foe.x) {
        const wallX = m.x < foe.x ? a.left : a.right;
        const t = (wallX - me.x) / dx;
        if (!(t > 0.05 && t < 0.95)) continue;
        hitX = wallX;
        hitY = me.y + dy * t;
        if (hitY < a.top + 40 || hitY > a.bottom - 40) continue;
      } else {
        const wallY = m.y < foe.y ? a.top : a.bottom;
        const t = (wallY - me.y) / dy;
        if (!(t > 0.05 && t < 0.95)) continue;
        hitY = wallY;
        hitX = me.x + dx * t;
        if (hitX < a.left + 40 || hitX > a.right - 40) continue;
      }
      if (!this.hasLos(sim, me.x, me.y, hitX, hitY)) continue;
      if (!this.hasLos(sim, hitX, hitY, foe.x, foe.y)) continue;
      return Math.atan2(dy, dx);
    }
    return null;
  }

  private considerDash(sim: Simulation, me: PlayerState): { x: number; y: number } | null {
    // Imminent projectile impact → dash perpendicular to the shot.
    for (const pr of sim.projectiles) {
      if (pr.dead || pr.owner === this.team) continue;
      const relX = me.x - pr.x;
      const relY = me.y - pr.y;
      const sp2 = pr.vx * pr.vx + pr.vy * pr.vy;
      if (sp2 < 1) continue;
      const tca = (relX * pr.vx + relY * pr.vy) / sp2;
      if (tca < 0 || tca > 0.3) continue;
      const cx = pr.x + pr.vx * tca;
      const cy = pr.y + pr.vy * tca;
      if (dist(cx, cy, me.x, me.y) < 42) {
        const v = norm(pr.vx, pr.vy);
        const side = (relX * -v.y + relY * v.x) >= 0 ? 1 : -1;
        return { x: -v.y * side, y: v.x * side };
      }
    }
    // Danger zone about to detonate underfoot → dash out.
    for (const ev of sim.director.active) {
      if (ev.desc.kind !== 'dangerZones') continue;
      const timeToBoom = ev.desc.warnT - ev.t;
      if (timeToBoom > 0.45 || timeToBoom < 0) continue;
      for (const z of ev.desc.zones) {
        if (dist(me.x, me.y, z.x, z.y) < z.r + 20) {
          return norm(me.x - z.x, me.y - z.y);
        }
      }
    }
    // Active beam closing in → dash across it.
    for (const ev of sim.director.active) {
      if (ev.desc.kind !== 'laserSweep' && ev.desc.kind !== 'crossfire') continue;
      for (const beam of ev.beams) {
        if (!beam.active) continue;
        const bd = pointSegDist(me.x, me.y, beam.x, beam.y, beam.ex, beam.ey);
        if (bd < 46) {
          const along = norm(beam.ex - beam.x, beam.ey - beam.y);
          const side = ((me.x - beam.x) * -along.y + (me.y - beam.y) * along.x) >= 0 ? 1 : -1;
          return { x: -along.y * side, y: along.x * side };
        }
      }
    }
    return null;
  }

  private considerModule(
    sim: Simulation,
    me: PlayerState,
    foe: PlayerState,
    los: boolean,
    d: number,
  ): boolean {
    if (me.module === 'aegis') {
      let threat = 0;
      for (const pr of sim.projectiles) {
        if (pr.dead || pr.owner === this.team) continue;
        if (dist(pr.x, pr.y, me.x, me.y) < 240) threat++;
      }
      return threat >= 2 || (threat >= 1 && me.hp < 45) || (foe.voltShots > 0 && d < 420);
    }
    if (me.module === 'repulsor') {
      if (d < 170 && foe.alive) return true;
      let near = 0;
      for (const pr of sim.projectiles) {
        if (pr.dead || pr.owner === this.team) continue;
        if (dist(pr.x, pr.y, me.x, me.y) < MODULES.repulsor.radius * 0.9) near++;
      }
      return near >= 2;
    }
    // Volt: overcharge when we have a clear shooting window.
    return los && d > 200 && d < 470 && me.fireCd < 0.15 && this.seenT > this.cfg.reaction;
  }
}

export function clampInput(inp: InputState): InputState {
  inp.mx = clamp(inp.mx, -1, 1);
  inp.my = clamp(inp.my, -1, 1);
  if (!isFinite(inp.aim)) inp.aim = 0;
  return inp;
}
