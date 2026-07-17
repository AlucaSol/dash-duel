// Shared gameplay types used by the simulation, renderer, AI and networking.

export type Team = 0 | 1; // 0 = blue, 1 = red
export type ModuleType = 'aegis' | 'repulsor' | 'volt';
export type Difficulty = 'easy' | 'standard' | 'hard';
export type DamageSource = 'proj' | 'laser' | 'zone' | 'field' | 'repulsor';

/** Per-tick control input. `dash`/`module` are edge triggers consumed by the sim. */
export interface InputState {
  mx: number;
  my: number;
  aim: number;
  fire: boolean;
  dash: boolean;
  module: boolean;
}

export function emptyInput(): InputState {
  return { mx: 0, my: 0, aim: 0, fire: false, dash: false, module: false };
}

export interface PlayerState {
  team: Team;
  x: number;
  y: number;
  px: number; // previous tick position, for render interpolation
  py: number;
  vx: number;
  vy: number;
  kbx: number; // knockback velocity (pads / repulsor), decays separately
  kby: number;
  aim: number;
  hp: number;
  alive: boolean;
  fireCd: number;
  dashCd: number;
  dashT: number;
  dashDx: number;
  dashDy: number;
  invulnT: number;
  module: ModuleType;
  moduleCd: number;
  shieldHp: number;
  shieldT: number;
  voltShots: number;
  voltT: number;
  padCd: number;
  laserCd: number;
  zoneCd: number;
  fieldCd: number;
}

export interface Projectile {
  id: number;
  owner: Team;
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  bounces: number;
  life: number;
  oc: boolean; // overcharged (Volt)
  grace: number; // short post-bounce grace so we don't re-hit the same surface
  dead: boolean;
  trail: number[]; // packed x,y history (render only, never networked)
}

export interface Cover {
  id: number;
  x: number; // centre
  y: number;
  w: number;
  h: number;
  hp: number;
  maxHp: number;
  temp: boolean;
  wobble: number; // visual shake timer after taking a hit
}

export type CoverVisualState = 'intact' | 'damaged' | 'critical' | 'destroyed';

export function coverState(c: Cover): CoverVisualState {
  if (c.hp <= 0) return 'destroyed';
  const f = c.hp / c.maxHp;
  if (f > 0.66) return 'intact';
  if (f > 0.33) return 'damaged';
  return 'critical';
}

export type WallPhase = 0 | 1 | 2; // 0 telegraph, 1 solid, 2 collapsing

export interface TempWall {
  id: number;
  slot: number;
  x: number;
  y: number;
  w: number;
  h: number;
  phase: WallPhase;
  t: number; // time in current phase
  life: number; // remaining solid lifetime
}

export interface Pad {
  id: number;
  x: number;
  y: number;
  r: number;
  dx: number; // launch direction (unit)
  dy: number;
  surgeT: number; // >0 while overcharged
}

export interface WallSeg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  nx: number; // inward unit normal
  ny: number;
}

/** Everything movement/projectile physics needs to collide against. */
export interface CollisionWorld {
  segs: WallSeg[];
  covers: Cover[];
  tempWalls: TempWall[];
  pads: Pad[];
}

// ---------------------------------------------------------------------------
// Arena Director event descriptors. The host generates these (seeded RNG) and
// sends them verbatim to the client, which replays the same timeline visually.
// ---------------------------------------------------------------------------

export interface LaserSweepDesc {
  kind: 'laserSweep';
  id: number;
  emitter: number;
  a0: number;
  a1: number;
  warnT: number;
  activeT: number;
}

export interface CrossfireDesc {
  kind: 'crossfire';
  id: number;
  emitters: [number, number];
  warnT: number;
  activeT: number;
}

export interface DangerZonesDesc {
  kind: 'dangerZones';
  id: number;
  zones: { x: number; y: number; r: number }[];
  warnT: number;
  burnT: number;
}

export interface TempWallsDesc {
  kind: 'tempWalls';
  id: number;
  slots: number[];
  warnT: number;
  lifeT: number;
}

export interface CoverShiftDesc {
  kind: 'coverShift';
  id: number;
  op: 'repair' | 'raise' | 'collapse';
  coverId: number; // repair/collapse target, -1 otherwise
  slot: number; // raise slot, -1 otherwise
  warnT: number;
}

export interface PadSurgeDesc {
  kind: 'padSurge';
  id: number;
  pads: number[];
  durT: number;
}

export type ArenaEventDesc =
  | LaserSweepDesc
  | CrossfireDesc
  | DangerZonesDesc
  | TempWallsDesc
  | CoverShiftDesc
  | PadSurgeDesc;

export interface BeamState {
  x: number;
  y: number;
  ang: number;
  ex: number;
  ey: number;
  len: number;
  active: boolean;
  /** 0..1 while charging (warning line), 1 when firing */
  charge: number;
  hitCover: boolean;
}

export interface ActiveEvent {
  desc: ArenaEventDesc;
  t: number;
  done: boolean;
  beams: BeamState[];
  boomed: boolean[];
  applied: boolean; // one-shot ops (cover shift etc.)
}

// ---------------------------------------------------------------------------
// Sim events — drained by the Game each tick and routed to FX, audio and the
// network relay. Kept JSON-safe so the host can forward them directly.
// ---------------------------------------------------------------------------

export type SimEvent =
  | { k: 'shot'; team: Team; x: number; y: number; aim: number; oc: boolean }
  | { k: 'projSpawn'; id: number; owner: Team; x: number; y: number; vx: number; vy: number; oc: boolean }
  | { k: 'projDie'; id: number; x: number; y: number; burst: boolean }
  | { k: 'bounce'; x: number; y: number; nx: number; ny: number; pad: boolean }
  | { k: 'hit'; target: Team; dmg: number; x: number; y: number; shield: boolean; src: DamageSource }
  | { k: 'death'; target: Team; x: number; y: number }
  | { k: 'dash'; team: Team; x: number; y: number; dx: number; dy: number }
  | { k: 'module'; team: Team; kind: ModuleType; x: number; y: number }
  | { k: 'shieldBreak'; team: Team; x: number; y: number }
  | { k: 'pad'; team: Team; pad: number; x: number; y: number; dx: number; dy: number; surge: boolean }
  | { k: 'coverHit'; id: number; x: number; y: number; nx: number; ny: number }
  | { k: 'coverBreak'; id: number; x: number; y: number; w: number; h: number }
  | { k: 'coverRepair'; id: number }
  | { k: 'coverRaise'; id: number; x: number; y: number; w: number; h: number }
  | { k: 'wallUp'; id: number; x: number; y: number; w: number; h: number }
  | { k: 'wallBreak'; id: number; x: number; y: number; w: number; h: number }
  | { k: 'zoneBoom'; x: number; y: number; r: number }
  | { k: 'arenaEvent'; desc: ArenaEventDesc }
  | { k: 'arenaEnd'; id: number }
  | { k: 'suddenDeath' }
  | { k: 'roundEnd'; winner: -1 | Team; x: number; y: number };

// ---------------------------------------------------------------------------
// Presentation + render view
// ---------------------------------------------------------------------------

export type PresKind = 'roundIntro' | 'fight' | 'roundEnd' | 'suddenDeath' | 'matchEnd' | 'doubleKo';

export interface Presentation {
  kind: PresKind;
  t: number;
  /** round number / winning team etc, meaning depends on kind */
  data: number;
  text: string;
  sub: string;
}

export interface DirectorView {
  events: ActiveEvent[];
  sdActive: boolean;
  sdR: number;
}

export type SimPhase = 0 | 1 | 2; // countdown, active, over

export interface WorldView {
  players: [PlayerState, PlayerState];
  projectiles: Projectile[];
  covers: Cover[];
  tempWalls: TempWall[];
  pads: Pad[];
  director: DirectorView;
  phase: SimPhase;
  phaseT: number;
  timer: number;
  round: number;
  scores: [number, number];
  suddenDeath: boolean;
  localTeam: Team;
  names: [string, string];
  online: boolean;
  ping: number;
  winner: -1 | Team | null;
}
