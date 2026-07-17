// Arena geometry: a single symmetric battlefield with chamfered corners,
// destructible cover, four bounce pads, laser emitters and event slots.

import type { Cover, Pad, TempWall, WallSeg } from './types';
import { norm, raySegDist, rayRectDist } from '../utils/math';

export interface EmitterDef {
  x: number;
  y: number;
  /** Inward facing angle in radians. */
  dir: number;
}

export interface RectDef {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CoverDef extends RectDef {
  hp: number;
}

export interface ArenaDef {
  left: number;
  top: number;
  right: number;
  bottom: number;
  chamfer: number;
  wallThickness: number;
  cx: number;
  cy: number;
  segs: WallSeg[];
  emitters: EmitterDef[];
  padDefs: { x: number; y: number; dx: number; dy: number }[];
  coverDefs: CoverDef[];
  wallSlots: RectDef[];
  coverSlots: RectDef[];
  zoneSpots: { x: number; y: number }[];
  spawns: [{ x: number; y: number }, { x: number; y: number }];
}

export function createArenaDef(): ArenaDef {
  const left = 42;
  const top = 104;
  const right = 1238;
  const bottom = 678;
  const chamfer = 92;
  const cx = (left + right) / 2; // 640
  const cy = (top + bottom) / 2; // 391

  // Octagon boundary (chamfered rectangle), clockwise in screen space.
  const pts: [number, number][] = [
    [left + chamfer, top],
    [right - chamfer, top],
    [right, top + chamfer],
    [right, bottom - chamfer],
    [right - chamfer, bottom],
    [left + chamfer, bottom],
    [left, bottom - chamfer],
    [left, top + chamfer],
  ];
  const segs: WallSeg[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    // Perpendicular, oriented toward the arena centre.
    let nx = -(by - ay);
    let ny = bx - ax;
    const n = norm(nx, ny);
    nx = n.x;
    ny = n.y;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    if ((cx - mx) * nx + (cy - my) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    segs.push({ ax, ay, bx, by, nx, ny });
  }

  // Laser emitters mounted on the walls: 3 per side, indexed L0..L2 R0..R2 T0..T2 B0..B2.
  const emitters: EmitterDef[] = [
    { x: left, y: 250, dir: 0 },
    { x: left, y: cy, dir: 0 },
    { x: left, y: 532, dir: 0 },
    { x: right, y: 250, dir: Math.PI },
    { x: right, y: cy, dir: Math.PI },
    { x: right, y: 532, dir: Math.PI },
    { x: 420, y: top, dir: Math.PI / 2 },
    { x: cx, y: top, dir: Math.PI / 2 },
    { x: 860, y: top, dir: Math.PI / 2 },
    { x: 420, y: bottom, dir: -Math.PI / 2 },
    { x: cx, y: bottom, dir: -Math.PI / 2 },
    { x: 860, y: bottom, dir: -Math.PI / 2 },
  ];

  // Bounce pads near the four chamfered corners, launching toward the centre.
  const padSpots = [
    { x: 206, y: 268 },
    { x: 1074, y: 268 },
    { x: 206, y: 514 },
    { x: 1074, y: 514 },
  ];
  const padDefs = padSpots.map((p) => {
    const d = norm(cx - p.x, cy - p.y);
    return { x: p.x, y: p.y, dx: d.x, dy: d.y };
  });

  // Destructible cover — symmetric layout.
  const coverDefs: CoverDef[] = [
    { x: cx, y: cy, w: 150, h: 64, hp: 130 }, // centre block
    { x: 400, y: 246, w: 92, h: 58, hp: 95 },
    { x: 880, y: 246, w: 92, h: 58, hp: 95 },
    { x: 400, y: 536, w: 92, h: 58, hp: 95 },
    { x: 880, y: 536, w: 92, h: 58, hp: 95 },
    { x: 240, y: cy, w: 58, h: 112, hp: 105 }, // spawn-side pillars
    { x: 1040, y: cy, w: 58, h: 112, hp: 105 },
  ];

  // Slots where temporary energy walls can rise.
  const wallSlots: RectDef[] = [
    { x: cx, y: 214, w: 190, h: 16 },
    { x: cx, y: 568, w: 190, h: 16 },
    { x: 462, y: cy, w: 16, h: 170 },
    { x: 818, y: cy, w: 16, h: 170 },
  ];

  // Slots where the Cover Shift event can raise a temporary crate.
  const coverSlots: RectDef[] = [
    { x: 520, y: 316, w: 74, h: 48 },
    { x: 760, y: 466, w: 74, h: 48 },
  ];

  // Danger-zone candidate positions (kept away from walls and pads).
  const zoneSpots = [
    { x: 320, y: 180 }, { x: cx, y: 172 }, { x: 960, y: 180 },
    { x: 320, y: cy }, { x: 960, y: cy },
    { x: 320, y: 602 }, { x: cx, y: 610 }, { x: 960, y: 602 },
    { x: 520, y: 288 }, { x: 760, y: 288 },
    { x: 520, y: 494 }, { x: 760, y: 494 },
    { x: cx, y: 280 }, { x: cx, y: 502 },
  ];

  const spawns: [{ x: number; y: number }, { x: number; y: number }] = [
    { x: 150, y: cy },
    { x: 1130, y: cy },
  ];

  return {
    left, top, right, bottom, chamfer,
    wallThickness: 26,
    cx, cy,
    segs, emitters, padDefs, coverDefs, wallSlots, coverSlots, zoneSpots, spawns,
  };
}

export function makeCovers(def: ArenaDef): Cover[] {
  return def.coverDefs.map((c, i) => ({
    id: i,
    x: c.x,
    y: c.y,
    w: c.w,
    h: c.h,
    hp: c.hp,
    maxHp: c.hp,
    temp: false,
    wobble: 0,
  }));
}

export function makePads(def: ArenaDef): Pad[] {
  return def.padDefs.map((p, i) => ({
    id: i,
    x: p.x,
    y: p.y,
    r: 30,
    dx: p.dx,
    dy: p.dy,
    surgeT: 0,
  }));
}

/** Keep a circle inside the octagon boundary; returns true if it was pushed. */
export function resolveCircleArena(def: ArenaDef, p: { x: number; y: number }, r: number): boolean {
  let pushed = false;
  for (const s of def.segs) {
    // Signed distance from the wall line along the inward normal.
    const d = (p.x - s.ax) * s.nx + (p.y - s.ay) * s.ny;
    if (d < r) {
      p.x += (r - d) * s.nx;
      p.y += (r - d) * s.ny;
      pushed = true;
    }
  }
  return pushed;
}

export function pointInArena(def: ArenaDef, x: number, y: number, margin = 0): boolean {
  for (const s of def.segs) {
    const d = (x - s.ax) * s.nx + (y - s.ay) * s.ny;
    if (d < margin) return false;
  }
  return true;
}

export interface RaycastHit {
  ex: number;
  ey: number;
  dist: number;
  cover: Cover | null;
  wall: TempWall | null;
}

/**
 * Cast a ray from a wall emitter through the arena. Stops at the first intact
 * cover / solid temp wall, otherwise at the opposite arena wall.
 * Used for laser beams (both damage on the host and rendering everywhere).
 */
export function raycastArena(
  def: ArenaDef,
  covers: Cover[],
  tempWalls: TempWall[],
  ox: number,
  oy: number,
  ang: number,
): RaycastHit {
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  let best = Infinity;
  for (const s of def.segs) {
    const t = raySegDist(ox, oy, dx, dy, s.ax, s.ay, s.bx, s.by);
    if (t > 1 && t < best) best = t; // t>1 skips the emitter's own wall
  }
  if (!isFinite(best)) best = 1400;
  let cover: Cover | null = null;
  let wall: TempWall | null = null;
  for (const c of covers) {
    if (c.hp <= 0) continue;
    const t = rayRectDist(ox, oy, dx, dy, c.x, c.y, c.w / 2, c.h / 2);
    if (t >= 0 && t < best) {
      best = t;
      cover = c;
      wall = null;
    }
  }
  for (const w of tempWalls) {
    if (w.phase !== 1) continue;
    const t = rayRectDist(ox, oy, dx, dy, w.x, w.y, w.w / 2, w.h / 2);
    if (t >= 0 && t < best) {
      best = t;
      wall = w;
      cover = null;
    }
  }
  return { ex: ox + dx * best, ey: oy + dy * best, dist: best, cover, wall };
}
