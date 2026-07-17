// The authoritative game simulation. Runs locally in Solo Battle, on the host
// during online play, and (movement-only, via shared physics) inside client
// prediction. Fixed timestep, event-emitting, no rendering concerns.

import { MODULES, PLAYER, ROUND, STEP, SUDDEN_DEATH, TEMP_WALL, WEAPON } from './constants';
import type { ArenaDef } from './arena';
import { createArenaDef, makeCovers, makePads } from './arena';
import {
  makePlayer,
  projectileHitsPlayer,
  respawnPlayer,
  separatePlayers,
  spawnProjectile,
  stepPlayerMovement,
  stepProjectile,
  resetProjectileIds,
} from './physics';
import type {
  CollisionWorld,
  Cover,
  DamageSource,
  InputState,
  ModuleType,
  Pad,
  PlayerState,
  Projectile,
  SimEvent,
  SimPhase,
  TempWall,
  Team,
} from './types';
import { ArenaDirector } from '../systems/ArenaDirector';
import type { DirectorHost } from '../systems/ArenaDirector';
import { circleRectPush, dist, norm } from '../utils/math';
import { Rng } from '../utils/random';

export class Simulation implements DirectorHost {
  arena: ArenaDef;
  players: [PlayerState, PlayerState];
  projectiles: Projectile[] = [];
  covers: Cover[] = [];
  tempWalls: TempWall[] = [];
  pads: Pad[];
  director: ArenaDirector;
  rng: Rng;

  tick = 0;
  time = 0; // seconds since round became active
  phase: SimPhase = 0;
  phaseT: number = ROUND.countdown;
  roundTimer: number = ROUND.timer;
  suddenDeath = false;
  sdR: number = SUDDEN_DEATH.startRadius;
  round = 1;
  swap = false;
  winner: -1 | Team | null = null;
  events: SimEvent[] = [];

  private nextWallId = 1;

  constructor(seed: number) {
    this.arena = createArenaDef();
    this.rng = new Rng(seed);
    this.players = [makePlayer(0, 150, this.arena.cy), makePlayer(1, 1130, this.arena.cy)];
    this.pads = makePads(this.arena);
    this.covers = makeCovers(this.arena);
    this.director = new ArenaDirector(this.arena);
    resetProjectileIds();
  }

  setLoadouts(m0: ModuleType, m1: ModuleType): void {
    this.players[0].module = m0;
    this.players[1].module = m1;
  }

  get world(): CollisionWorld {
    return { segs: this.arena.segs, covers: this.covers, tempWalls: this.tempWalls, pads: this.pads };
  }

  resetRound(round: number, swap: boolean): void {
    this.round = round;
    this.swap = swap;
    this.tick = 0;
    this.time = 0;
    this.phase = 0;
    this.phaseT = ROUND.countdown;
    this.roundTimer = ROUND.timer;
    this.suddenDeath = false;
    this.sdR = SUDDEN_DEATH.startRadius;
    this.winner = null;
    this.projectiles.length = 0;
    this.tempWalls.length = 0;
    this.covers = makeCovers(this.arena);
    for (const pad of this.pads) pad.surgeT = 0;
    this.director.reset(this.rng);
    this.events.length = 0;

    const [sa, sb] = this.arena.spawns;
    const p0Spawn = swap ? sb : sa;
    const p1Spawn = swap ? sa : sb;
    respawnPlayer(this.players[0], p0Spawn.x, p0Spawn.y, swap ? Math.PI : 0);
    respawnPlayer(this.players[1], p1Spawn.x, p1Spawn.y, swap ? 0 : Math.PI);
  }

  drainEvents(): SimEvent[] {
    if (this.events.length === 0) return [];
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }

  step(inputs: [InputState, InputState]): void {
    const dt = STEP;
    this.tick++;

    // --- phase flow ---
    if (this.phase === 0) {
      this.phaseT -= dt;
      if (this.phaseT <= 0) {
        this.phase = 1;
        this.phaseT = 0;
      }
    } else if (this.phase === 1) {
      this.time += dt;
      if (!this.suddenDeath) {
        this.roundTimer -= dt;
        if (this.roundTimer <= 0) {
          this.roundTimer = 0;
          this.suddenDeath = true;
          this.events.push({ k: 'suddenDeath' });
        }
      }
    } else {
      this.phaseT += dt; // time since round ended
    }

    const locked = this.phase !== 1;
    const world = this.world;

    // --- players: movement, dash, pads ---
    for (let i = 0 as Team; i < 2; i = (i + 1) as Team) {
      const p = this.players[i];
      const inp = inputs[i];
      stepPlayerMovement(p, inp, world, this.arena, dt, locked, {
        onDashStart: (pl) => {
          const d = norm(pl.dashDx, pl.dashDy);
          this.events.push({ k: 'dash', team: pl.team, x: pl.x, y: pl.y, dx: d.x, dy: d.y });
        },
        onPad: (pl, pad, surge) => {
          this.events.push({
            k: 'pad', team: pl.team, pad: pad.id,
            x: pad.x, y: pad.y, dx: pad.dx, dy: pad.dy, surge,
          });
        },
        onWallBreak: (w) => {
          this.events.push({ k: 'wallBreak', id: w.id, x: w.x, y: w.y, w: w.w, h: w.h });
        },
      });
    }
    separatePlayers(this.players[0], this.players[1]);

    // --- per-player timers, firing and modules ---
    for (let i = 0 as Team; i < 2; i = (i + 1) as Team) {
      const p = this.players[i];
      const inp = inputs[i];
      if (p.fireCd > 0) p.fireCd = Math.max(0, p.fireCd - dt);
      if (p.moduleCd > 0) p.moduleCd = Math.max(0, p.moduleCd - dt);
      if (p.laserCd > 0) p.laserCd = Math.max(0, p.laserCd - dt);
      if (p.zoneCd > 0) p.zoneCd = Math.max(0, p.zoneCd - dt);
      if (p.fieldCd > 0) p.fieldCd = Math.max(0, p.fieldCd - dt);
      if (p.shieldT > 0) {
        p.shieldT = Math.max(0, p.shieldT - dt);
        if (p.shieldT === 0) p.shieldHp = 0;
      }
      if (p.voltT > 0) {
        p.voltT = Math.max(0, p.voltT - dt);
        if (p.voltT === 0) p.voltShots = 0;
      }

      if (!locked && p.alive) {
        if (inp.module && p.moduleCd <= 0) this.useModule(p);
        if (inp.fire && p.fireCd <= 0) this.fire(p);
      }
    }

    // --- projectiles ---
    for (const pr of this.projectiles) {
      if (pr.dead) continue;
      stepProjectile(pr, world, this.arena, dt, {
        onBounce: (proj, x, y, nx, ny, surface, obj) => {
          this.events.push({ k: 'bounce', x, y, nx, ny, pad: surface === 'pad' });
          if (surface === 'cover') {
            this.damageCover(obj as Cover, WEAPON.coverDamage, x, y, nx, ny);
          } else if (surface === 'tempwall') {
            // Energy walls shrug off shots but flare where they're hit.
          }
        },
        onDie: (proj, x, y, burst) => {
          this.events.push({ k: 'projDie', id: proj.id, x, y, burst });
        },
      });
      // Player hits are authoritative and only apply during active play.
      if (!pr.dead && this.phase === 1) {
        const target = this.players[(1 - pr.owner) as Team];
        if (target.alive && target.invulnT <= 0) {
          const hit = projectileHitsPlayer(pr, target);
          if (hit) {
            pr.dead = true;
            const dmg = pr.oc ? MODULES.volt.damage : WEAPON.damage;
            this.damagePlayer(target.team, dmg, 'proj', hit.x, hit.y);
            this.events.push({ k: 'projDie', id: pr.id, x: hit.x, y: hit.y, burst: true });
          }
        }
      }
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (this.projectiles[i].dead) this.projectiles.splice(i, 1);
    }

    // --- temporary walls lifecycle ---
    this.stepTempWalls(dt);

    // --- cover wobble decay ---
    for (const c of this.covers) {
      if (c.wobble > 0) c.wobble = Math.max(0, c.wobble - dt);
    }

    // --- pads surge decay ---
    for (const pad of this.pads) {
      if (pad.surgeT > 0) pad.surgeT = Math.max(0, pad.surgeT - dt);
    }

    // --- arena director ---
    this.director.stepAuth(this, dt, this.phase === 1);

    // --- sudden-death danger field ---
    if (this.suddenDeath && this.phase === 1) {
      this.sdR = Math.max(SUDDEN_DEATH.minRadius, this.sdR - SUDDEN_DEATH.shrinkRate * dt);
      for (const p of this.players) {
        if (!p.alive || p.fieldCd > 0) continue;
        if (dist(p.x, p.y, this.arena.cx, this.arena.cy) > this.sdR - PLAYER.radius) {
          const applied = this.damagePlayer(p.team, SUDDEN_DEATH.damage, 'field', p.x, p.y);
          if (applied >= 0) p.fieldCd = SUDDEN_DEATH.tick;
        }
      }
    }

    // --- round end check ---
    if (this.phase === 1) {
      const d0 = this.players[0].hp <= 0;
      const d1 = this.players[1].hp <= 0;
      if (d0 || d1) {
        let winner: -1 | Team;
        if (d0 && d1) {
          winner = this.players[0].hp === this.players[1].hp
            ? -1
            : this.players[0].hp > this.players[1].hp ? 0 : 1;
        } else {
          winner = d0 ? 1 : 0;
        }
        const loser = winner === 0 ? this.players[1] : this.players[0];
        for (const p of this.players) {
          if (p.hp <= 0) {
            p.alive = false;
            this.events.push({ k: 'death', target: p.team, x: p.x, y: p.y });
          }
        }
        this.phase = 2;
        this.phaseT = 0;
        this.winner = winner;
        this.events.push({ k: 'roundEnd', winner, x: loser.x, y: loser.y });
      }
    }
  }

  private fire(p: PlayerState): void {
    const oc = p.voltShots > 0;
    if (oc) p.voltShots--;
    p.fireCd = oc ? MODULES.volt.interval : WEAPON.interval;
    const mx = p.x + Math.cos(p.aim) * WEAPON.muzzleOffset;
    const my = p.y + Math.sin(p.aim) * WEAPON.muzzleOffset;
    const pr = spawnProjectile(p.team, mx, my, p.aim, oc);
    this.projectiles.push(pr);
    // Slight recoil nudge opposite to the shot.
    p.kbx -= Math.cos(p.aim) * WEAPON.recoil;
    p.kby -= Math.sin(p.aim) * WEAPON.recoil;
    this.events.push({ k: 'shot', team: p.team, x: mx, y: my, aim: p.aim, oc });
    this.events.push({
      k: 'projSpawn', id: pr.id, owner: pr.owner,
      x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy, oc: pr.oc,
    });
  }

  private useModule(p: PlayerState): void {
    const kind = p.module;
    p.moduleCd = MODULES[kind].cooldown;
    this.events.push({ k: 'module', team: p.team, kind, x: p.x, y: p.y });
    if (kind === 'aegis') {
      p.shieldHp = MODULES.aegis.absorb;
      p.shieldT = MODULES.aegis.duration;
    } else if (kind === 'volt') {
      p.voltShots = MODULES.volt.shots;
      p.voltT = MODULES.volt.timeout;
    } else {
      // Repulsor: destroy nearby enemy shots, shove the enemy, crack fragile obstacles.
      const R = MODULES.repulsor.radius;
      for (const pr of this.projectiles) {
        if (pr.dead || pr.owner === p.team) continue;
        if (dist(pr.x, pr.y, p.x, p.y) < R) {
          pr.dead = true;
          this.events.push({ k: 'projDie', id: pr.id, x: pr.x, y: pr.y, burst: true });
        }
      }
      const enemy = this.players[(1 - p.team) as Team];
      const d = dist(enemy.x, enemy.y, p.x, p.y);
      if (enemy.alive && d < R + PLAYER.radius) {
        const dir = norm(enemy.x - p.x, enemy.y - p.y);
        const fallback = { x: Math.cos(p.aim), y: Math.sin(p.aim) };
        const push = dir.x === 0 && dir.y === 0 ? fallback : dir;
        enemy.kbx = push.x * MODULES.repulsor.knockback;
        enemy.kby = push.y * MODULES.repulsor.knockback;
        this.damagePlayer(enemy.team, MODULES.repulsor.damage, 'repulsor', enemy.x, enemy.y);
      }
      for (const w of this.tempWalls) {
        if (w.phase === 1 && dist(w.x, w.y, p.x, p.y) < R + Math.max(w.w, w.h) / 2) {
          w.phase = 2;
          w.t = 0;
          this.events.push({ k: 'wallBreak', id: w.id, x: w.x, y: w.y, w: w.w, h: w.h });
        }
      }
      for (const c of this.covers) {
        if (c.temp && c.hp > 0 && dist(c.x, c.y, p.x, p.y) < R + Math.max(c.w, c.h) / 2) {
          this.damageCover(c, c.hp + 999, c.x, c.y, 0, -1);
        }
      }
    }
  }

  /**
   * Apply damage respecting dash immunity and shields.
   * Returns the damage that connected, or -1 when the target was immune.
   */
  damagePlayer(target: Team, dmg: number, src: DamageSource, x: number, y: number): number {
    const p = this.players[target];
    if (!p.alive || this.phase !== 1) return -1;
    if (p.invulnT > 0) return -1;
    let remaining = dmg;
    if (p.shieldHp > 0) {
      const absorbed = Math.min(p.shieldHp, remaining);
      p.shieldHp -= absorbed;
      remaining -= absorbed;
      this.events.push({ k: 'hit', target, dmg: absorbed, x, y, shield: true, src });
      if (p.shieldHp <= 0) {
        p.shieldHp = 0;
        p.shieldT = 0;
        this.events.push({ k: 'shieldBreak', team: target, x: p.x, y: p.y });
      }
    }
    if (remaining > 0) {
      p.hp -= remaining;
      this.events.push({ k: 'hit', target, dmg: remaining, x, y, shield: false, src });
    }
    return dmg;
  }

  damageCover(c: Cover, dmg: number, x: number, y: number, nx: number, ny: number): void {
    if (c.hp <= 0) return;
    c.hp -= dmg;
    c.wobble = 0.22;
    if (c.hp <= 0) {
      c.hp = 0;
      this.events.push({ k: 'coverBreak', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h });
    } else if (dmg >= 5) {
      this.events.push({ k: 'coverHit', id: c.id, x, y, nx, ny });
    }
  }

  spawnTempWalls(slots: number[]): void {
    for (const slot of slots) {
      const def = this.arena.wallSlots[slot];
      if (!def) continue;
      this.tempWalls.push({
        id: this.nextWallId++,
        slot,
        x: def.x, y: def.y, w: def.w, h: def.h,
        phase: 0, t: 0, life: TEMP_WALL.life,
      });
    }
  }

  spawnTempCover(slot: number): void {
    const def = this.arena.coverSlots[slot];
    if (!def) return;
    const id = 100 + slot;
    const existing = this.covers.find((c) => c.id === id);
    if (existing && existing.hp > 0) return;
    if (existing) {
      existing.hp = 55;
      existing.maxHp = 55;
      existing.wobble = 0.3;
      this.events.push({ k: 'coverRaise', id, x: def.x, y: def.y, w: def.w, h: def.h });
      return;
    }
    this.covers.push({
      id, x: def.x, y: def.y, w: def.w, h: def.h,
      hp: 55, maxHp: 55, temp: true, wobble: 0.3,
    });
    this.events.push({ k: 'coverRaise', id, x: def.x, y: def.y, w: def.w, h: def.h });
  }

  private stepTempWalls(dt: number): void {
    for (let i = this.tempWalls.length - 1; i >= 0; i--) {
      const w = this.tempWalls[i];
      if (w.phase === 0) {
        w.t += dt;
        if (w.t >= TEMP_WALL.warn) {
          w.phase = 1;
          w.t = 0;
          this.events.push({ k: 'wallUp', id: w.id, x: w.x, y: w.y, w: w.w, h: w.h });
          // Never trap a fighter inside a rising wall.
          for (const p of this.players) {
            const push = circleRectPush(p.x, p.y, PLAYER.radius + 2, w.x, w.y, w.w / 2, w.h / 2);
            if (push) {
              p.x += push.x;
              p.y += push.y;
            }
          }
        }
      } else if (w.phase === 1) {
        w.life -= dt;
        if (w.life <= 0) {
          w.phase = 2;
          w.t = 0;
          this.events.push({ k: 'wallBreak', id: w.id, x: w.x, y: w.y, w: w.w, h: w.h });
        }
      } else {
        w.t += dt;
        if (w.t >= TEMP_WALL.dieTime) this.tempWalls.splice(i, 1);
      }
    }
  }
}
