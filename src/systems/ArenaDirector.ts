// The Arena Director schedules and runs temporary arena events: laser sweeps,
// crossfire beams, danger zones, temporary energy walls, cover shifts and
// bounce-pad surges. The host runs it authoritatively (seeded RNG, damage);
// the client runs a replica that replays the same descriptors for visuals.

import { DIRECTOR, LASER, PLAYER, TEMP_WALL, ZONE } from '../game/constants';
import type { ArenaDef } from '../game/arena';
import { raycastArena } from '../game/arena';
import type {
  ActiveEvent,
  ArenaEventDesc,
  BeamState,
  Cover,
  DamageSource,
  Pad,
  PlayerState,
  SimEvent,
  TempWall,
  Team,
} from '../game/types';
import { clamp01, dist, pointSegDist } from '../utils/math';
import type { Rng } from '../utils/random';

/** Surface the authoritative simulation exposes to the director. */
export interface DirectorHost {
  arena: ArenaDef;
  players: [PlayerState, PlayerState];
  covers: Cover[];
  tempWalls: TempWall[];
  pads: Pad[];
  rng: Rng;
  time: number;
  suddenDeath: boolean;
  events: SimEvent[];
  damagePlayer(target: Team, dmg: number, src: DamageSource, x: number, y: number): number;
  damageCover(c: Cover, dmg: number, x: number, y: number, nx: number, ny: number): void;
  spawnTempWalls(slots: number[]): void;
  spawnTempCover(slot: number): void;
}

const MAJOR_KINDS = new Set(['laserSweep', 'crossfire', 'dangerZones', 'tempWalls']);

export class ArenaDirector {
  active: ActiveEvent[] = [];
  nextT = 999;
  private nextId = 1;

  constructor(private def: ArenaDef) {}

  reset(rng: Rng | null): void {
    this.active.length = 0;
    this.nextT = rng ? rng.range(DIRECTOR.firstDelay[0], DIRECTOR.firstDelay[1]) : 999;
  }

  intensity(time: number, sd: boolean): 0 | 1 | 2 {
    if (sd) return 2;
    return time >= DIRECTOR.escalationAt ? 1 : 0;
  }

  hasMajorActive(): boolean {
    return this.active.some((e) => !e.done && MAJOR_KINDS.has(e.desc.kind));
  }

  /** Ingest a descriptor (host: freshly generated; client: from the network). */
  applyDesc(desc: ArenaEventDesc): ActiveEvent {
    const ev: ActiveEvent = { desc, t: 0, done: false, beams: [], boomed: [], applied: false };
    if (desc.kind === 'laserSweep') {
      ev.beams = [this.makeBeam(desc.emitter)];
    } else if (desc.kind === 'crossfire') {
      ev.beams = desc.emitters.map((e) => this.makeBeam(e));
    } else if (desc.kind === 'dangerZones') {
      ev.boomed = desc.zones.map(() => false);
    }
    this.active.push(ev);
    return ev;
  }

  private makeBeam(emitterIdx: number): BeamState {
    const e = this.def.emitters[emitterIdx];
    return { x: e.x, y: e.y, ang: e.dir, ex: e.x, ey: e.y, len: 0, active: false, charge: 0, hitCover: false };
  }

  // -------------------------------------------------------------------------
  // Authoritative stepping (host / solo)
  // -------------------------------------------------------------------------

  stepAuth(host: DirectorHost, dt: number, phaseActive: boolean): void {
    if (phaseActive) {
      this.nextT -= dt;
      if (this.nextT <= 0) this.schedule(host);
    }
    for (const ev of this.active) {
      if (!ev.done) this.advance(ev, dt, host.covers, host.tempWalls, host);
    }
    this.prune(host);
  }

  /** Replica stepping (client) — visual timelines only, no damage. */
  stepReplica(covers: Cover[], tempWalls: TempWall[], dt: number): void {
    for (const ev of this.active) {
      if (!ev.done) this.advance(ev, dt, covers, tempWalls, null);
    }
    this.prune(null);
  }

  private prune(host: DirectorHost | null): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const ev = this.active[i];
      if (ev.done) {
        host?.events.push({ k: 'arenaEnd', id: ev.desc.id });
        this.active.splice(i, 1);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private schedule(host: DirectorHost): void {
    const inten = this.intensity(host.time, host.suddenDeath);
    const gapRange =
      inten === 2 ? DIRECTOR.suddenGap : inten === 1 ? DIRECTOR.escalationGap : DIRECTOR.openingGap;
    this.nextT = host.rng.range(gapRange[0], gapRange[1]);

    const majorBusy = this.hasMajorActive();
    type Pick = { kind: ArenaEventDesc['kind']; w: number };
    const picks: Pick[] = [];
    if (!majorBusy) {
      picks.push({ kind: 'laserSweep', w: 3 });
      picks.push({ kind: 'dangerZones', w: 3 });
      picks.push({ kind: 'tempWalls', w: 2.2 });
      if (inten >= 1) picks.push({ kind: 'crossfire', w: 1.6 });
    }
    picks.push({ kind: 'coverShift', w: majorBusy ? 0.9 : 1.8 });
    picks.push({ kind: 'padSurge', w: majorBusy ? 0.9 : 1.8 });

    // Avoid immediately repeating the previous event kind when possible.
    const last = this.lastKind;
    let total = 0;
    for (const p of picks) {
      if (p.kind === last && picks.length > 1) p.w *= 0.35;
      total += p.w;
    }
    let roll = host.rng.next() * total;
    let kind: ArenaEventDesc['kind'] = picks[picks.length - 1].kind;
    for (const p of picks) {
      roll -= p.w;
      if (roll <= 0) {
        kind = p.kind;
        break;
      }
    }

    const desc = this.buildDesc(kind, host, inten);
    if (!desc) {
      // Could not build a valid event right now — try again soon.
      this.nextT = Math.min(this.nextT, 1.2);
      return;
    }
    this.lastKind = desc.kind;
    const ev = this.applyDesc(desc);
    host.events.push({ k: 'arenaEvent', desc });
    // One-shot world ops happen on activation inside advance(); temp walls
    // spawn immediately so their own warn phase telegraphs them.
    if (desc.kind === 'tempWalls') {
      host.spawnTempWalls(desc.slots);
      ev.applied = true;
    }
    if (desc.kind === 'padSurge') {
      for (const i of desc.pads) {
        const pad = host.pads[i];
        if (pad) pad.surgeT = desc.durT;
      }
      ev.applied = true;
    }
  }

  private lastKind: ArenaEventDesc['kind'] | null = null;

  private buildDesc(kind: ArenaEventDesc['kind'], host: DirectorHost, inten: number): ArenaEventDesc | null {
    const rng = host.rng;
    const id = this.nextId++;
    const def = this.def;

    switch (kind) {
      case 'laserSweep': {
        const emitter = rng.int(0, def.emitters.length - 1);
        const e = def.emitters[emitter];
        const span = rng.range(0.55, 0.85);
        const sign = rng.chance(0.5) ? 1 : -1;
        return {
          kind, id, emitter,
          a0: e.dir - span * sign,
          a1: e.dir + span * sign,
          warnT: inten === 2 ? 0.9 : 1.2,
          activeT: rng.range(2.4, 3.2),
        };
      }
      case 'crossfire': {
        // Two parallel beams across different lanes with a safe gap between.
        const horizontal = rng.chance(0.5);
        const emitters: [number, number] = horizontal
          ? (rng.chance(0.5) ? [0, 5] : [2, 3])
          : (rng.chance(0.5) ? [6, 11] : [8, 9]);
        return { kind, id, emitters, warnT: 1.3, activeT: rng.range(2.6, 3.4) };
      }
      case 'dangerZones': {
        const spots = rng.shuffle([...def.zoneSpots]);
        const zones: { x: number; y: number; r: number }[] = [];
        for (const s of spots) {
          if (zones.length >= 3) break;
          let ok = true;
          for (const p of host.players) {
            if (dist(s.x, s.y, p.x, p.y) < DIRECTOR.playerClearance) ok = false;
          }
          for (const z of zones) {
            if (dist(s.x, s.y, z.x, z.y) < 170) ok = false;
          }
          if (ok) zones.push({ x: s.x, y: s.y, r: rng.range(70, 86) });
        }
        if (zones.length < 2) return null;
        return { kind, id, zones, warnT: ZONE.warn, burnT: ZONE.burnTime };
      }
      case 'tempWalls': {
        const free: number[] = [];
        for (let i = 0; i < def.wallSlots.length; i++) {
          if (host.tempWalls.some((w) => w.slot === i)) continue;
          const slot = def.wallSlots[i];
          let ok = true;
          for (const p of host.players) {
            if (
              Math.abs(p.x - slot.x) < slot.w / 2 + PLAYER.radius + 30 &&
              Math.abs(p.y - slot.y) < slot.h / 2 + PLAYER.radius + 30
            ) {
              ok = false;
            }
          }
          if (ok) free.push(i);
        }
        if (free.length === 0) return null;
        rng.shuffle(free);
        const count = free.length > 1 && rng.chance(0.6) ? 2 : 1;
        return { kind, id, slots: free.slice(0, count), warnT: TEMP_WALL.warn, lifeT: TEMP_WALL.life };
      }
      case 'coverShift': {
        const ops: ('repair' | 'raise' | 'collapse')[] = [];
        const critical = host.covers.filter((c) => !c.temp && c.hp > 0 && c.hp / c.maxHp <= 0.33);
        const damaged = host.covers.filter((c) => !c.temp && c.hp > 0 && c.hp < c.maxHp * 0.7);
        const freeSlots: number[] = [];
        for (let i = 0; i < def.coverSlots.length; i++) {
          const slot = def.coverSlots[i];
          const occupied = host.covers.some((c) => c.temp && c.hp > 0 && c.id === 100 + i);
          if (occupied) continue;
          let ok = true;
          for (const p of host.players) {
            if (
              Math.abs(p.x - slot.x) < slot.w / 2 + PLAYER.radius + 24 &&
              Math.abs(p.y - slot.y) < slot.h / 2 + PLAYER.radius + 24
            ) {
              ok = false;
            }
          }
          if (ok) freeSlots.push(i);
        }
        if (critical.length > 0) ops.push('collapse');
        if (damaged.length > 0 && !host.suddenDeath) ops.push('repair');
        if (freeSlots.length > 0) ops.push('raise');
        if (ops.length === 0) return null;
        const op = rng.pick(ops);
        if (op === 'collapse') {
          return { kind, id, op, coverId: rng.pick(critical).id, slot: -1, warnT: 1.1 };
        }
        if (op === 'repair') {
          return { kind, id, op, coverId: rng.pick(damaged).id, slot: -1, warnT: 0.9 };
        }
        return { kind, id, op: 'raise', coverId: -1, slot: rng.pick(freeSlots), warnT: 1.0 };
      }
      case 'padSurge': {
        const pair = rng.chance(0.5) ? [0, 3] : [1, 2];
        return { kind, id, pads: pair, durT: 6 };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event timelines (shared between authoritative and replica stepping)
  // -------------------------------------------------------------------------

  private advance(
    ev: ActiveEvent,
    dt: number,
    covers: Cover[],
    tempWalls: TempWall[],
    host: DirectorHost | null,
  ): void {
    ev.t += dt;
    const d = ev.desc;
    switch (d.kind) {
      case 'laserSweep': {
        const beam = ev.beams[0];
        if (ev.t < d.warnT) {
          beam.charge = clamp01(ev.t / d.warnT);
          beam.active = false;
          beam.ang = d.a0;
        } else if (ev.t < d.warnT + d.activeT) {
          beam.charge = 1;
          beam.active = true;
          const prog = (ev.t - d.warnT) / d.activeT;
          beam.ang = d.a0 + (d.a1 - d.a0) * prog;
        } else {
          beam.active = false;
          ev.done = true;
        }
        this.updateBeam(beam, covers, tempWalls);
        if (host && beam.active) this.beamDamage(beam, host, dt);
        break;
      }
      case 'crossfire': {
        const firing = ev.t >= d.warnT && ev.t < d.warnT + d.activeT;
        for (const beam of ev.beams) {
          beam.charge = ev.t < d.warnT ? clamp01(ev.t / d.warnT) : 1;
          beam.active = firing;
          this.updateBeam(beam, covers, tempWalls);
          if (host && firing) this.beamDamage(beam, host, dt);
        }
        if (ev.t >= d.warnT + d.activeT) ev.done = true;
        break;
      }
      case 'dangerZones': {
        if (ev.t >= d.warnT && host) {
          for (let i = 0; i < d.zones.length; i++) {
            const z = d.zones[i];
            if (!ev.boomed[i]) {
              ev.boomed[i] = true;
              host.events.push({ k: 'zoneBoom', x: z.x, y: z.y, r: z.r });
              for (const p of host.players) {
                if (dist(p.x, p.y, z.x, z.y) < z.r + ZONE.boomRadiusBonus + PLAYER.radius) {
                  host.damagePlayer(p.team, ZONE.boomDamage, 'zone', p.x, p.y);
                }
              }
            }
          }
        } else if (ev.t >= d.warnT) {
          for (let i = 0; i < ev.boomed.length; i++) ev.boomed[i] = true;
        }
        // Lingering burn after detonation.
        if (host && ev.t >= d.warnT && ev.t < d.warnT + d.burnT) {
          for (const p of host.players) {
            if (p.zoneCd > 0) continue;
            for (const z of d.zones) {
              if (dist(p.x, p.y, z.x, z.y) < z.r + PLAYER.radius) {
                const applied = host.damagePlayer(p.team, ZONE.burnDamage, 'zone', p.x, p.y);
                if (applied >= 0) p.zoneCd = ZONE.burnTick;
                break;
              }
            }
          }
        }
        if (ev.t >= d.warnT + d.burnT + 0.45) ev.done = true;
        break;
      }
      case 'tempWalls': {
        // Walls run their own lifecycle in the simulation / replica snapshots;
        // the event just tracks overall duration for scheduling purposes.
        if (ev.t >= d.warnT + d.lifeT + TEMP_WALL.dieTime + 0.2) ev.done = true;
        break;
      }
      case 'coverShift': {
        if (ev.t >= d.warnT && !ev.applied) {
          ev.applied = true;
          if (host) {
            if (d.op === 'repair') {
              const c = host.covers.find((cv) => cv.id === d.coverId);
              if (c && c.hp > 0) {
                c.hp = c.maxHp;
                host.events.push({ k: 'coverRepair', id: c.id });
              }
            } else if (d.op === 'collapse') {
              const c = host.covers.find((cv) => cv.id === d.coverId);
              if (c && c.hp > 0) {
                host.damageCover(c, c.hp + 999, c.x, c.y, 0, -1);
              }
            } else if (d.op === 'raise') {
              host.spawnTempCover(d.slot);
            }
          }
        }
        if (ev.t >= d.warnT + 0.6) ev.done = true;
        break;
      }
      case 'padSurge': {
        if (ev.t >= d.durT) ev.done = true;
        break;
      }
    }
  }

  private updateBeam(beam: BeamState, covers: Cover[], tempWalls: TempWall[]): void {
    const hit = raycastArena(this.def, covers, tempWalls, beam.x, beam.y, beam.ang);
    beam.ex = hit.ex;
    beam.ey = hit.ey;
    beam.len = hit.dist;
    beam.hitCover = hit.cover !== null || hit.wall !== null;
  }

  private beamDamage(beam: BeamState, host: DirectorHost, dt: number): void {
    for (const p of host.players) {
      if (!p.alive || p.laserCd > 0) continue;
      const dd = pointSegDist(p.x, p.y, beam.x, beam.y, beam.ex, beam.ey);
      if (dd < LASER.width / 2 + PLAYER.radius) {
        const applied = host.damagePlayer(p.team, LASER.damage, 'laser', p.x, p.y);
        if (applied >= 0) p.laserCd = LASER.tick;
      }
    }
    // Lasers chew through the cover they terminate on.
    const hit = raycastArena(this.def, host.covers, host.tempWalls, beam.x, beam.y, beam.ang);
    if (hit.cover) {
      host.damageCover(hit.cover, LASER.coverDps * dt, hit.ex, hit.ey, -Math.cos(beam.ang), -Math.sin(beam.ang));
    }
  }
}
