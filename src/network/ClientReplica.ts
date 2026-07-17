// Client-side world replica. The joining player predicts their own movement
// locally with the exact shared physics, interpolates the remote fighter
// between snapshots, dead-reckons projectiles, and replays ArenaDirector
// descriptors for hazard visuals. All damage/authority stays on the host.

import { NET, ROUND, STEP, SUDDEN_DEATH, TEMP_WALL } from '../game/constants';
import type { ArenaDef } from '../game/arena';
import { createArenaDef, makeCovers, makePads } from '../game/arena';
import { makePlayer, stepPlayerMovement, stepProjectile } from '../game/physics';
import type {
  CollisionWorld,
  Cover,
  InputState,
  Pad,
  PlayerState,
  Projectile,
  SimEvent,
  SimPhase,
  Team,
  TempWall,
} from '../game/types';
import { ArenaDirector } from '../systems/ArenaDirector';
import type { PlayerSnap, SnapshotMsg } from './protocol';
import { lerp, lerpAngle } from '../utils/math';

interface RemoteSample {
  at: number;
  x: number;
  y: number;
  aim: number;
  vx: number;
  vy: number;
}

const noopProjHooks = {
  onBounce: () => {},
  onDie: () => {},
};

export class ClientReplica {
  arena: ArenaDef = createArenaDef();
  players: [PlayerState, PlayerState];
  projectiles: Projectile[] = [];
  covers: Cover[];
  tempWalls: TempWall[] = [];
  pads: Pad[];
  director = new ArenaDirector(this.arena);
  readonly localTeam: Team = 1;

  phase: SimPhase = 0;
  phaseT: number = ROUND.countdown;
  timer: number = ROUND.timer;
  suddenDeath = false;
  sdR: number = SUDDEN_DEATH.startRadius;
  round = 1;
  scores: [number, number] = [0, 0];
  swap = false;

  /** Local render-smoothing error offset after reconciliation. */
  errX = 0;
  errY = 0;

  private pendingInputs: { seq: number; inp: InputState }[] = [];
  private remoteBuf: RemoteSample[] = [];
  private latestRemote: PlayerSnap | null = null;

  constructor() {
    this.players = [makePlayer(0, 150, this.arena.cy), makePlayer(1, 1130, this.arena.cy)];
    this.covers = makeCovers(this.arena);
    this.pads = makePads(this.arena);
    this.director.reset(null);
  }

  get world(): CollisionWorld {
    return { segs: this.arena.segs, covers: this.covers, tempWalls: this.tempWalls, pads: this.pads };
  }

  resetRound(round: number, swap: boolean, scores: [number, number]): void {
    this.round = round;
    this.swap = swap;
    this.scores = scores;
    this.phase = 0;
    this.phaseT = ROUND.countdown;
    this.timer = ROUND.timer;
    this.suddenDeath = false;
    this.sdR = SUDDEN_DEATH.startRadius;
    this.projectiles.length = 0;
    this.tempWalls.length = 0;
    this.covers = makeCovers(this.arena);
    for (const pad of this.pads) pad.surgeT = 0;
    this.director.reset(null);
    this.pendingInputs.length = 0;
    this.remoteBuf.length = 0;
    this.errX = 0;
    this.errY = 0;
    const [sa, sb] = this.arena.spawns;
    const p0 = swap ? sb : sa;
    const p1 = swap ? sa : sb;
    const set = (p: PlayerState, s: { x: number; y: number }, aim: number) => {
      p.x = s.x; p.y = s.y; p.px = s.x; p.py = s.y;
      p.vx = 0; p.vy = 0; p.kbx = 0; p.kby = 0;
      p.hp = 100; p.alive = true; p.aim = aim;
      p.dashCd = 0; p.dashT = 0; p.invulnT = 0;
      p.fireCd = 0; p.moduleCd = 0;
      p.shieldHp = 0; p.shieldT = 0;
      p.voltShots = 0; p.voltT = 0;
      p.padCd = 0;
    };
    set(this.players[0], p0, swap ? Math.PI : 0);
    set(this.players[1], p1, swap ? 0 : Math.PI);
  }

  /** Local prediction: advance our own fighter one fixed tick. */
  predictTick(seq: number, inp: InputState, dashFx?: (p: PlayerState) => void, padFx?: (p: PlayerState, pad: Pad, surge: boolean) => void): void {
    const me = this.players[this.localTeam];
    const locked = this.phase !== 1;
    stepPlayerMovement(me, inp, this.world, this.arena, STEP, locked, {
      onDashStart: dashFx,
      onPad: padFx,
    });
    // Local weapon-cooldown estimate so the reticle feels immediate.
    if (me.fireCd > 0) me.fireCd = Math.max(0, me.fireCd - STEP);
    if (me.moduleCd > 0) me.moduleCd = Math.max(0, me.moduleCd - STEP);
    this.pendingInputs.push({ seq, inp: { ...inp } });
    if (this.pendingInputs.length > 240) this.pendingInputs.splice(0, 120);
  }

  applySnapshot(s: SnapshotMsg): void {
    this.phase = s.phase;
    this.phaseT = s.phaseT;
    this.timer = s.timer;
    this.suddenDeath = s.sd;
    this.sdR = s.sdR;
    this.round = s.round;
    this.scores = [s.scores[0], s.scores[1]];
    this.swap = s.swap;

    // ---- remote player: buffer for interpolation ----
    const remote = s.p[0];
    this.latestRemote = remote;
    this.remoteBuf.push({
      at: performance.now() / 1000,
      x: remote.x, y: remote.y, aim: remote.aim, vx: remote.vx, vy: remote.vy,
    });
    while (this.remoteBuf.length > 30) this.remoteBuf.shift();
    // Non-positional fields snap immediately.
    this.copyStatus(this.players[0], remote);

    // ---- own player: authoritative state + input replay reconciliation ----
    const me = this.players[this.localTeam];
    const mine = s.p[1];
    const oldX = me.x + this.errX;
    const oldY = me.y + this.errY;
    this.copyStatus(me, mine);
    me.x = mine.x; me.y = mine.y;
    me.px = mine.x; me.py = mine.y;
    me.vx = mine.vx; me.vy = mine.vy;
    me.kbx = mine.kbx; me.kby = mine.kby;
    me.dashT = mine.dashT;
    me.dashDx = mine.dashDx; me.dashDy = mine.dashDy;
    // Drop acknowledged inputs, replay the rest through shared physics.
    this.pendingInputs = this.pendingInputs.filter((pi) => pi.seq > s.ack);
    const locked = this.phase !== 1;
    for (const pi of this.pendingInputs) {
      stepPlayerMovement(me, pi.inp, this.world, this.arena, STEP, locked);
    }
    const dx = oldX - me.x;
    const dy = oldY - me.y;
    if (dx * dx + dy * dy < 90 * 90) {
      this.errX = dx;
      this.errY = dy;
    } else {
      this.errX = 0; // way off — snap
      this.errY = 0;
    }

    // ---- projectiles: reconcile by id ----
    const seen = new Set<number>();
    for (const ps of s.projs) {
      seen.add(ps.id);
      let pr = this.projectiles.find((q) => q.id === ps.id);
      if (!pr) {
        pr = {
          id: ps.id, owner: ps.o,
          x: ps.x, y: ps.y, px: ps.x, py: ps.y,
          vx: ps.vx, vy: ps.vy,
          bounces: ps.b, life: 2, oc: ps.oc,
          grace: 0, dead: false, trail: [],
        };
        this.projectiles.push(pr);
      } else {
        pr.x = lerp(pr.x, ps.x, 0.4);
        pr.y = lerp(pr.y, ps.y, 0.4);
        pr.vx = ps.vx;
        pr.vy = ps.vy;
        pr.bounces = ps.b;
        pr.life = Math.max(pr.life, 0.2);
      }
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (!seen.has(this.projectiles[i].id)) this.projectiles.splice(i, 1);
    }

    // ---- covers ----
    for (const cs of s.covers) {
      let c = this.covers.find((q) => q.id === cs.id);
      if (!c && cs.x !== undefined && cs.y !== undefined && cs.w !== undefined && cs.h !== undefined) {
        c = {
          id: cs.id, x: cs.x, y: cs.y, w: cs.w, h: cs.h,
          hp: cs.hp, maxHp: cs.mhp ?? Math.max(1, cs.hp), temp: true, wobble: 0,
        };
        this.covers.push(c);
      }
      if (c) {
        if (cs.hp < c.hp) c.wobble = Math.max(c.wobble, 0.15);
        c.hp = cs.hp;
        if (cs.mhp !== undefined) c.maxHp = cs.mhp;
      }
    }

    // ---- temp walls ----
    const wallSeen = new Set<number>();
    for (const ws of s.walls) {
      wallSeen.add(ws.id);
      let w = this.tempWalls.find((q) => q.id === ws.id);
      if (!w) {
        const slot = this.arena.wallSlots[ws.slot];
        if (!slot) continue;
        w = { id: ws.id, slot: ws.slot, x: slot.x, y: slot.y, w: slot.w, h: slot.h, phase: ws.ph, t: ws.t, life: ws.life };
        this.tempWalls.push(w);
      }
      w.phase = ws.ph;
      w.t = ws.t;
      w.life = ws.life;
    }
    for (let i = this.tempWalls.length - 1; i >= 0; i--) {
      if (!wallSeen.has(this.tempWalls[i].id)) this.tempWalls.splice(i, 1);
    }

    // ---- pads ----
    for (let i = 0; i < this.pads.length && i < s.pads.length; i++) {
      this.pads[i].surgeT = s.pads[i];
    }
  }

  private copyStatus(p: PlayerState, s: PlayerSnap): void {
    p.hp = s.hp;
    p.alive = s.alive;
    p.fireCd = s.fireCd;
    p.dashCd = s.dashCd;
    p.invulnT = s.invulnT;
    p.moduleCd = s.moduleCd;
    p.shieldHp = s.shieldHp;
    p.shieldT = s.shieldT;
    p.voltShots = s.voltShots;
    p.voltT = s.voltT;
    p.padCd = s.padCd;
  }

  /** Handle relayed sim events that affect replicated state. */
  applyEvent(e: SimEvent): void {
    switch (e.k) {
      case 'projSpawn': {
        if (!this.projectiles.some((q) => q.id === e.id)) {
          this.projectiles.push({
            id: e.id, owner: e.owner,
            x: e.x, y: e.y, px: e.x, py: e.y,
            vx: e.vx, vy: e.vy,
            bounces: 2, life: 1.5, oc: e.oc,
            grace: 0, dead: false, trail: [],
          });
        }
        break;
      }
      case 'projDie': {
        const i = this.projectiles.findIndex((q) => q.id === e.id);
        if (i >= 0) this.projectiles.splice(i, 1);
        break;
      }
      case 'arenaEvent':
        this.director.applyDesc(e.desc);
        break;
      case 'suddenDeath':
        this.suddenDeath = true;
        break;
      case 'coverBreak': {
        const c = this.covers.find((q) => q.id === e.id);
        if (c) c.hp = 0;
        break;
      }
      case 'coverRepair': {
        const c = this.covers.find((q) => q.id === e.id);
        if (c) c.hp = c.maxHp;
        break;
      }
      case 'coverRaise': {
        const c = this.covers.find((q) => q.id === e.id);
        if (c) {
          c.hp = c.maxHp;
        } else {
          this.covers.push({
            id: e.id, x: e.x, y: e.y, w: e.w, h: e.h,
            hp: 55, maxHp: 55, temp: true, wobble: 0.3,
          });
        }
        break;
      }
      case 'wallBreak': {
        const w = this.tempWalls.find((q) => q.id === e.id);
        if (w && w.phase !== 2) {
          w.phase = 2;
          w.t = 0;
        }
        break;
      }
      default:
        break;
    }
  }

  /** Per-render-frame replica advancement (visual smoothness between snapshots). */
  frame(dt: number): void {
    // Error offset decay (reconciliation smoothing).
    const decay = Math.exp(-11 * dt);
    this.errX *= decay;
    this.errY *= decay;
    if (Math.abs(this.errX) < 0.1) this.errX = 0;
    if (Math.abs(this.errY) < 0.1) this.errY = 0;

    // Timers tick locally for smooth display; snapshots correct them.
    if (this.phase === 0) this.phaseT = Math.max(0, this.phaseT - dt);
    else if (this.phase === 1 && !this.suddenDeath) this.timer = Math.max(0, this.timer - dt);
    if (this.suddenDeath && this.phase === 1) {
      this.sdR = Math.max(SUDDEN_DEATH.minRadius, this.sdR - SUDDEN_DEATH.shrinkRate * dt);
    }

    // Projectiles dead-reckon with real collision so ricochets look right.
    for (const pr of this.projectiles) {
      if (!pr.dead) stepProjectile(pr, this.world, this.arena, dt, noopProjHooks);
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (this.projectiles[i].dead) this.projectiles.splice(i, 1);
    }

    // Temp wall + pad + cover timers advance for smooth visuals.
    for (const w of this.tempWalls) {
      if (w.phase === 0) {
        w.t += dt;
        if (w.t >= TEMP_WALL.warn) { w.phase = 1; w.t = 0; }
      } else if (w.phase === 1) {
        w.life -= dt;
      } else {
        w.t += dt;
      }
    }
    for (let i = this.tempWalls.length - 1; i >= 0; i--) {
      const w = this.tempWalls[i];
      if (w.phase === 2 && w.t > TEMP_WALL.dieTime + 0.4) this.tempWalls.splice(i, 1);
    }
    for (const pad of this.pads) {
      if (pad.surgeT > 0) pad.surgeT = Math.max(0, pad.surgeT - dt);
    }
    for (const c of this.covers) {
      if (c.wobble > 0) c.wobble = Math.max(0, c.wobble - dt);
    }

    this.director.stepReplica(this.covers, this.tempWalls, dt);

    // Remote player interpolation at a small delay behind the newest snapshot.
    const now = performance.now() / 1000;
    const target = now - NET.interpDelay;
    const buf = this.remoteBuf;
    const p0 = this.players[0];
    if (buf.length >= 2) {
      let a = buf[0];
      let b = buf[buf.length - 1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].at <= target && buf[i + 1].at >= target) {
          a = buf[i];
          b = buf[i + 1];
          break;
        }
      }
      if (b.at > a.at) {
        const f = Math.min(1.2, Math.max(0, (target - a.at) / (b.at - a.at)));
        p0.px = p0.x;
        p0.py = p0.y;
        p0.x = lerp(a.x, b.x, f);
        p0.y = lerp(a.y, b.y, f);
        p0.aim = lerpAngle(a.aim, b.aim, Math.min(1, f));
        p0.vx = b.vx;
        p0.vy = b.vy;
      }
    } else if (this.latestRemote) {
      p0.x = this.latestRemote.x;
      p0.y = this.latestRemote.y;
      p0.aim = this.latestRemote.aim;
    }
  }
}
