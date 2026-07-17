// Shared movement + projectile physics. Both the authoritative host simulation
// and the client-side prediction/replica run this exact code so they agree.

import { DASH, MODULES, PADS, PLAYER, WEAPON } from './constants';
import type { ArenaDef } from './arena';
import { resolveCircleArena } from './arena';
import type { CollisionWorld, InputState, Pad, PlayerState, Projectile, TempWall } from './types';
import { circleRectPush, norm, reflect, segCircleHit, segRectHit } from '../utils/math';

export interface MoveHooks {
  onDashStart?: (p: PlayerState) => void;
  onPad?: (p: PlayerState, pad: Pad, surge: boolean) => void;
  onWallBreak?: (w: TempWall) => void;
}

export function makePlayer(team: 0 | 1, x: number, y: number): PlayerState {
  return {
    team,
    x, y, px: x, py: y,
    vx: 0, vy: 0, kbx: 0, kby: 0,
    aim: team === 0 ? 0 : Math.PI,
    hp: PLAYER.maxHp,
    alive: true,
    fireCd: 0,
    dashCd: 0, dashT: 0, dashDx: 1, dashDy: 0,
    invulnT: 0,
    module: 'aegis',
    moduleCd: 0,
    shieldHp: 0, shieldT: 0,
    voltShots: 0, voltT: 0,
    padCd: 0,
    laserCd: 0, zoneCd: 0, fieldCd: 0,
  };
}

export function respawnPlayer(p: PlayerState, x: number, y: number, aim: number): void {
  p.x = x; p.y = y; p.px = x; p.py = y;
  p.vx = 0; p.vy = 0; p.kbx = 0; p.kby = 0;
  p.aim = aim;
  p.hp = PLAYER.maxHp;
  p.alive = true;
  p.fireCd = 0;
  p.dashCd = 0; p.dashT = 0;
  p.invulnT = 0;
  p.moduleCd = 0;
  p.shieldHp = 0; p.shieldT = 0;
  p.voltShots = 0; p.voltT = 0;
  p.padCd = 0;
  p.laserCd = 0; p.zoneCd = 0; p.fieldCd = 0;
}

/**
 * Advance one player by one fixed step. Handles aim, acceleration, dash,
 * knockback decay, collision with cover / temp walls / arena boundary and
 * bounce pads. Locked players (countdown / round over) may only aim.
 */
export function stepPlayerMovement(
  p: PlayerState,
  inp: InputState,
  world: CollisionWorld,
  arena: ArenaDef,
  dt: number,
  locked: boolean,
  hooks?: MoveHooks,
): void {
  p.px = p.x;
  p.py = p.y;
  p.aim = inp.aim;

  // --- cooldown timers that belong to movement ---
  if (p.dashCd > 0) p.dashCd = Math.max(0, p.dashCd - dt);
  if (p.padCd > 0) p.padCd = Math.max(0, p.padCd - dt);
  if (p.invulnT > 0) p.invulnT = Math.max(0, p.invulnT - dt);

  // --- dash start ---
  if (!locked && inp.dash && p.dashCd <= 0 && p.dashT <= 0 && p.alive) {
    let d = norm(inp.mx, inp.my);
    if (d.x === 0 && d.y === 0) d = { x: Math.cos(inp.aim), y: Math.sin(inp.aim) };
    p.dashDx = d.x;
    p.dashDy = d.y;
    p.dashT = DASH.duration;
    p.dashCd = DASH.cooldown;
    p.invulnT = DASH.invulnTime;
    hooks?.onDashStart?.(p);
  }

  // --- velocity ---
  if (p.dashT > 0) {
    p.dashT -= dt;
    p.vx = p.dashDx * DASH.speed;
    p.vy = p.dashDy * DASH.speed;
  } else if (!locked && p.alive) {
    const d = norm(inp.mx, inp.my);
    if (d.x !== 0 || d.y !== 0) {
      p.vx += d.x * PLAYER.accel * dt;
      p.vy += d.y * PLAYER.accel * dt;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > PLAYER.maxSpeed) {
        p.vx = (p.vx / sp) * PLAYER.maxSpeed;
        p.vy = (p.vy / sp) * PLAYER.maxSpeed;
      }
    } else {
      const f = Math.exp(-PLAYER.friction * dt);
      p.vx *= f;
      p.vy *= f;
    }
  } else {
    const f = Math.exp(-PLAYER.friction * dt);
    p.vx *= f;
    p.vy *= f;
  }

  // Knockback decays independently so pads/repulsor feel punchy but recover.
  const kbF = Math.exp(-PLAYER.kbDecay * dt);
  p.kbx *= kbF;
  p.kby *= kbF;
  if (Math.abs(p.kbx) < 1) p.kbx = 0;
  if (Math.abs(p.kby) < 1) p.kby = 0;

  p.x += (p.vx + p.kbx) * dt;
  p.y += (p.vy + p.kby) * dt;

  // --- collision resolution (two passes keeps corners stable) ---
  const r = PLAYER.radius;
  for (let pass = 0; pass < 2; pass++) {
    for (const c of world.covers) {
      if (c.hp <= 0) continue;
      const push = circleRectPush(p.x, p.y, r, c.x, c.y, c.w / 2, c.h / 2);
      if (push) {
        p.x += push.x;
        p.y += push.y;
      }
    }
    for (const w of world.tempWalls) {
      if (w.phase !== 1) continue;
      const push = circleRectPush(p.x, p.y, r, w.x, w.y, w.w / 2, w.h / 2);
      if (push) {
        if (p.dashT > 0) {
          // Dashing shatters energy walls instead of stopping the dash.
          w.phase = 2;
          w.t = 0;
          hooks?.onWallBreak?.(w);
        } else {
          p.x += push.x;
          p.y += push.y;
        }
      }
    }
    resolveCircleArena(arena, p, r);
  }

  // --- bounce pads ---
  if (p.alive && p.padCd <= 0) {
    for (const pad of world.pads) {
      const dx = p.x - pad.x;
      const dy = p.y - pad.y;
      if (dx * dx + dy * dy < (pad.r + 4) * (pad.r + 4)) {
        const surge = pad.surgeT > 0;
        const power = PADS.power * (surge ? PADS.surgeMul : 1);
        p.kbx = pad.dx * power;
        p.kby = pad.dy * power;
        p.padCd = PADS.retrigger;
        p.dashT = 0; // pad launch overrides an in-progress dash
        hooks?.onPad?.(p, pad, surge);
        break;
      }
    }
  }
}

/** Gentle circle-vs-circle separation between the two fighters. */
export function separatePlayers(a: PlayerState, b: PlayerState): void {
  if (!a.alive || !b.alive) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  const min = PLAYER.radius * 2;
  if (d2 >= min * min || d2 < 1e-6) return;
  const d = Math.sqrt(d2);
  const push = (min - d) / 2;
  const nx = dx / d;
  const ny = dy / d;
  a.x -= nx * push;
  a.y -= ny * push;
  b.x += nx * push;
  b.y += ny * push;
}

let nextProjId = 1;

export function resetProjectileIds(): void {
  nextProjId = 1;
}

export function spawnProjectile(
  owner: 0 | 1,
  x: number,
  y: number,
  ang: number,
  oc: boolean,
): Projectile {
  const speed = oc ? MODULES.volt.speed : WEAPON.speed;
  return {
    id: nextProjId++,
    owner,
    x, y, px: x, py: y,
    vx: Math.cos(ang) * speed,
    vy: Math.sin(ang) * speed,
    bounces: WEAPON.maxBounces,
    life: WEAPON.life,
    oc,
    grace: 0,
    dead: false,
    trail: [],
  };
}

export interface ProjHooks {
  onBounce: (pr: Projectile, x: number, y: number, nx: number, ny: number, surface: 'wall' | 'cover' | 'tempwall' | 'pad', obj: unknown) => void;
  onDie: (pr: Projectile, x: number, y: number, burst: boolean) => void;
}

/**
 * Swept projectile step vs walls, cover, temp walls and pads.
 * Player hits are handled by the simulation (authority only).
 */
export function stepProjectile(
  pr: Projectile,
  world: CollisionWorld,
  arena: ArenaDef,
  dt: number,
  hooks: ProjHooks,
): void {
  if (pr.dead) return;
  pr.px = pr.x;
  pr.py = pr.y;
  pr.life -= dt;
  if (pr.grace > 0) pr.grace -= dt;
  if (pr.life <= 0) {
    pr.dead = true;
    hooks.onDie(pr, pr.x, pr.y, false);
    return;
  }

  let remaining = dt;
  let guard = 0;
  while (remaining > 1e-5 && !pr.dead && guard++ < 4) {
    const nx0 = pr.x + pr.vx * remaining;
    const ny0 = pr.y + pr.vy * remaining;

    let bestT = Infinity;
    let hitNx = 0;
    let hitNy = 0;
    let surface: 'wall' | 'cover' | 'tempwall' | null = null;
    let hitObj: unknown = null;

    if (pr.grace <= 0) {
      // Arena boundary segments (treated as lines with inward normals).
      for (const s of world.segs) {
        const d0 = (pr.x - s.ax) * s.nx + (pr.y - s.ay) * s.ny;
        const d1 = (nx0 - s.ax) * s.nx + (ny0 - s.ay) * s.ny;
        if (d0 > WEAPON.radius && d1 < WEAPON.radius) {
          const t = (d0 - WEAPON.radius) / (d0 - d1);
          if (t < bestT) {
            bestT = t;
            hitNx = s.nx;
            hitNy = s.ny;
            surface = 'wall';
            hitObj = s;
          }
        }
      }
      for (const c of world.covers) {
        if (c.hp <= 0) continue;
        const hit = segRectHit(pr.x, pr.y, nx0, ny0, c.x, c.y, c.w / 2 + WEAPON.radius, c.h / 2 + WEAPON.radius);
        if (hit && hit.t < bestT) {
          bestT = hit.t;
          hitNx = hit.nx;
          hitNy = hit.ny;
          surface = 'cover';
          hitObj = c;
        }
      }
      for (const w of world.tempWalls) {
        if (w.phase !== 1) continue;
        const hit = segRectHit(pr.x, pr.y, nx0, ny0, w.x, w.y, w.w / 2 + WEAPON.radius, w.h / 2 + WEAPON.radius);
        if (hit && hit.t < bestT) {
          bestT = hit.t;
          hitNx = hit.nx;
          hitNy = hit.ny;
          surface = 'tempwall';
          hitObj = w;
        }
      }
    }

    if (surface === null || !isFinite(bestT)) {
      pr.x = nx0;
      pr.y = ny0;
      remaining = 0;
      break;
    }

    // Move to the impact point.
    const hx = pr.x + (nx0 - pr.x) * bestT;
    const hy = pr.y + (ny0 - pr.y) * bestT;
    pr.x = hx;
    pr.y = hy;
    remaining *= 1 - bestT;

    if (pr.bounces <= 0) {
      pr.dead = true;
      hooks.onBounce(pr, hx, hy, hitNx, hitNy, surface, hitObj);
      hooks.onDie(pr, hx, hy, true);
      return;
    }
    pr.bounces--;
    const rv = reflect(pr.vx, pr.vy, hitNx, hitNy);
    pr.vx = rv.x * WEAPON.bounceKeep;
    pr.vy = rv.y * WEAPON.bounceKeep;
    // Nudge away from the surface + short grace so we can't re-collide
    // with the same wall on consecutive frames.
    pr.x += hitNx * (WEAPON.radius * 0.6 + 1.5);
    pr.y += hitNy * (WEAPON.radius * 0.6 + 1.5);
    pr.grace = 0.016;
    hooks.onBounce(pr, hx, hy, hitNx, hitNy, surface, hitObj);
  }

  // Bounce-pad redirection: pads fling projectiles along their facing.
  if (!pr.dead && pr.grace <= 0) {
    for (const pad of world.pads) {
      const dx = pr.x - pad.x;
      const dy = pr.y - pad.y;
      if (dx * dx + dy * dy < pad.r * pad.r) {
        const sp = Math.hypot(pr.vx, pr.vy) * (pad.surgeT > 0 ? PADS.projBoost : 1);
        pr.vx = pad.dx * sp;
        pr.vy = pad.dy * sp;
        pr.grace = 0.25;
        hooks.onBounce(pr, pr.x, pr.y, pad.dx, pad.dy, 'pad', pad);
        break;
      }
    }
  }
}

/** Sweep the projectile's motion this tick against a player circle. */
export function projectileHitsPlayer(pr: Projectile, p: PlayerState): { x: number; y: number } | null {
  if (!p.alive) return null;
  const t = segCircleHit(pr.px, pr.py, pr.x, pr.y, p.x, p.y, PLAYER.radius + WEAPON.radius);
  if (t < 0) return null;
  return { x: pr.px + (pr.x - pr.px) * t, y: pr.py + (pr.y - pr.py) * t };
}
