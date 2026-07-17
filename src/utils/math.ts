// Small math helpers used across simulation, AI and rendering.

export const TAU = Math.PI * 2;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential approach. `rate` ~ how fast per second. */
export function expApproach(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function len(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Normalise in place-ish; returns {x, y}. Zero vectors stay zero. */
export function norm(x: number, y: number): { x: number; y: number } {
  const l = Math.sqrt(x * x + y * y);
  if (l < 1e-8) return { x: 0, y: 0 };
  return { x: x / l, y: y / l };
}

export function dot(ax: number, ay: number, bx: number, by: number): number {
  return ax * bx + ay * by;
}

export function angleTo(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}

/** Smallest signed difference between two angles, in (-PI, PI]. */
export function angDiff(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + angDiff(a, b) * t;
}

/** Rotate angle `a` toward `b` by at most `maxStep` radians. */
export function rotateToward(a: number, b: number, maxStep: number): number {
  const d = angDiff(a, b);
  if (Math.abs(d) <= maxStep) return b;
  return a + Math.sign(d) * maxStep;
}

/** Reflect velocity across a unit surface normal. */
export function reflect(vx: number, vy: number, nx: number, ny: number): { x: number; y: number } {
  const d = 2 * (vx * nx + vy * ny);
  return { x: vx - d * nx, y: vy - d * ny };
}

/** Distance from point P to segment AB. */
export function pointSegDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const l2 = abx * abx + aby * aby;
  if (l2 < 1e-8) return dist(px, py, ax, ay);
  let t = ((px - ax) * abx + (py - ay) * aby) / l2;
  t = clamp01(t);
  return dist(px, py, ax + abx * t, ay + aby * t);
}

/**
 * Earliest intersection of the swept segment A->B with a circle (C, r).
 * Returns t in [0, 1] or -1 when there is no hit.
 */
export function segCircleHit(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
  r: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - cx;
  const fy = ay - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-10) return fx * fx + fy * fy <= r * r ? 0 : -1;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  let disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  disc = Math.sqrt(disc);
  const t1 = (-b - disc) / (2 * a);
  const t2 = (-b + disc) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2; // started inside
  return -1;
}

/**
 * Segment vs axis-aligned rect (center cx,cy half extents hw,hh).
 * Returns { t, nx, ny } for the earliest hit or null.
 */
export function segRectHit(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
  hw: number, hh: number,
): { t: number; nx: number; ny: number } | null {
  const dx = bx - ax;
  const dy = by - ay;
  let tMin = 0;
  let tMax = 1;
  let nx = 0;
  let ny = 0;

  // X slab
  if (Math.abs(dx) < 1e-10) {
    if (ax < cx - hw || ax > cx + hw) return null;
  } else {
    const inv = 1 / dx;
    let t1 = (cx - hw - ax) * inv;
    let t2 = (cx + hw - ax) * inv;
    let n = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; n = 1; }
    if (t1 > tMin) { tMin = t1; nx = n; ny = 0; }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  // Y slab
  if (Math.abs(dy) < 1e-10) {
    if (ay < cy - hh || ay > cy + hh) return null;
  } else {
    const inv = 1 / dy;
    let t1 = (cy - hh - ay) * inv;
    let t2 = (cy + hh - ay) * inv;
    let n = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; n = 1; }
    if (t1 > tMin) { tMin = t1; nx = 0; ny = n; }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (tMin <= 0 || tMin > 1) return null; // starting inside or no hit within sweep
  return { t: tMin, nx, ny };
}

/**
 * Circle (cx,cy,r) vs axis-aligned rect (center rx,ry, half extents hw,hh).
 * Returns a minimal push-out vector for the circle, or null when not overlapping.
 */
export function circleRectPush(
  cx: number, cy: number, r: number,
  rx: number, ry: number, hw: number, hh: number,
): { x: number; y: number } | null {
  const nearX = clamp(cx, rx - hw, rx + hw);
  const nearY = clamp(cy, ry - hh, ry + hh);
  const dx = cx - nearX;
  const dy = cy - nearY;
  const d2 = dx * dx + dy * dy;
  if (d2 > r * r) return null;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    const push = (r - d) / d;
    return { x: dx * push, y: dy * push };
  }
  // Centre inside the rect — push along the axis of least penetration.
  const left = cx - (rx - hw);
  const right = rx + hw - cx;
  const top = cy - (ry - hh);
  const bottom = ry + hh - cy;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { x: -(left + r), y: 0 };
  if (m === right) return { x: right + r, y: 0 };
  if (m === top) return { x: 0, y: -(top + r) };
  return { x: 0, y: bottom + r };
}

/** Ray (origin, unit dir) vs segment AB. Returns distance along ray or -1. */
export function raySegDist(
  ox: number, oy: number,
  dx: number, dy: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const sx = bx - ax;
  const sy = by - ay;
  const denom = dx * sy - dy * sx;
  if (Math.abs(denom) < 1e-10) return -1;
  const t = ((ax - ox) * sy - (ay - oy) * sx) / denom; // along ray
  const u = ((ax - ox) * dy - (ay - oy) * dx) / denom; // along segment
  if (t >= 0 && u >= 0 && u <= 1) return t;
  return -1;
}

/** Ray vs axis-aligned rect; returns distance along ray or -1. */
export function rayRectDist(
  ox: number, oy: number,
  dx: number, dy: number,
  cx: number, cy: number,
  hw: number, hh: number,
): number {
  let tMin = -Infinity;
  let tMax = Infinity;
  if (Math.abs(dx) < 1e-10) {
    if (ox < cx - hw || ox > cx + hw) return -1;
  } else {
    const inv = 1 / dx;
    let t1 = (cx - hw - ox) * inv;
    let t2 = (cx + hw - ox) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return -1;
  }
  if (Math.abs(dy) < 1e-10) {
    if (oy < cy - hh || oy > cy + hh) return -1;
  } else {
    const inv = 1 / dy;
    let t1 = (cy - hh - oy) * inv;
    let t2 = (cy + hh - oy) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return -1;
  }
  if (tMax < 0) return -1;
  return tMin >= 0 ? tMin : tMax;
}
