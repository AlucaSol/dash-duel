// Central balance and tuning configuration for Dash Duel.
// Gameplay numbers live here rather than scattered through the code.

export const VIEW_W = 1280;
export const VIEW_H = 720;
export const STEP = 1 / 60;
export const MAX_CATCHUP_STEPS = 5;
export const MAX_DPR = 2;

export const PLAYER = {
  radius: 17,
  maxHp: 100,
  accel: 3000,
  maxSpeed: 305,
  /** Exponential friction rate when no input is held. */
  friction: 9.5,
  /** Knockback velocity decay rate. */
  kbDecay: 4.6,
} as const;

export const WEAPON = {
  damage: 16,
  interval: 0.4,
  speed: 560,
  life: 1.4,
  radius: 5,
  maxBounces: 2,
  /** Speed retained after each ricochet. */
  bounceKeep: 0.95,
  coverDamage: 26,
  muzzleOffset: 24,
  recoil: 40,
} as const;

export const DASH = {
  cooldown: 2.8,
  duration: 0.16,
  speed: 1060,
  /** Portion of the dash with damage immunity. */
  invulnTime: 0.15,
} as const;

export const MODULES = {
  aegis: {
    name: 'Aegis Core',
    key: 'aegis',
    cooldown: 8,
    absorb: 35,
    duration: 1.8,
    desc: 'Projects a shield that soaks up to 35 damage for 1.8s.',
  },
  repulsor: {
    name: 'Repulsor Core',
    key: 'repulsor',
    cooldown: 7,
    radius: 165,
    damage: 9,
    knockback: 660,
    desc: 'Radial pulse that wipes nearby shots and hurls the enemy back.',
  },
  volt: {
    name: 'Volt Core',
    key: 'volt',
    cooldown: 9,
    shots: 3,
    speed: 780,
    interval: 0.3,
    damage: 17,
    timeout: 6,
    desc: 'Overcharges your next three shots — faster, meaner, brighter.',
  },
} as const;

export const ROUND = {
  timer: 60,
  countdown: 3.2,
  winsNeeded: 3,
  bestOf: 5,
  /** Seconds the round-over presentation lasts before the next round. */
  resultTime: 2.6,
} as const;

export const SUDDEN_DEATH = {
  startRadius: 800,
  minRadius: 205,
  shrinkRate: 24,
  damage: 6,
  tick: 0.35,
} as const;

export const LASER = {
  damage: 10,
  tick: 0.35,
  width: 11,
  coverDps: 34,
} as const;

export const ZONE = {
  warn: 1.25,
  boomDamage: 22,
  boomRadiusBonus: 6,
  burnTime: 0.9,
  burnDamage: 8,
  burnTick: 0.3,
} as const;

export const PADS = {
  radius: 30,
  power: 780,
  retrigger: 0.85,
  surgeMul: 1.55,
  projBoost: 1.2,
} as const;

export const TEMP_WALL = {
  warn: 1.0,
  life: 7,
  dieTime: 0.35,
} as const;

export const DIRECTOR = {
  firstDelay: [4.5, 6.5] as const,
  openingGap: [6.5, 9] as const,
  escalationGap: [4.5, 6.5] as const,
  suddenGap: [2.8, 4.2] as const,
  escalationAt: 18,
  /** Minimum distance an event hazard keeps from player spawns at creation. */
  playerClearance: 150,
} as const;

export const NET = {
  protocol: 2,
  /** Send client input every N sim ticks. */
  inputEvery: 2,
  /** Host broadcasts a snapshot every N sim ticks. */
  snapshotEvery: 3,
  /** Remote entity interpolation delay in seconds. */
  interpDelay: 0.12,
  pingInterval: 1.0,
  /** Seconds of total silence before the connection is declared lost. */
  silenceTimeout: 8,
  idPrefix: 'dashduel-v2-',
  connectTimeout: 12,
} as const;

export const PARTICLE_CAPS = { low: 150, medium: 350, high: 600 } as const;

export const COLORS = {
  blue: '#3fd4ff',
  blueBright: '#bdf3ff',
  blueDeep: '#1470d8',
  blueTrail: 'rgba(90, 214, 255, ',
  red: '#ff4d5c',
  redBright: '#ffd9cf',
  redDeep: '#b81f44',
  redTrail: 'rgba(255, 110, 96, ',
  redProj: '#ff7043',
  hazard: '#ff3b30',
  warn: '#ffb020',
  pad: '#3dffb4',
  padSurge: '#fff06a',
  energyWall: '#9a6bff',
  floor: '#10151f',
  wall: '#232c3c',
} as const;

export function teamColor(team: 0 | 1): string {
  return team === 0 ? COLORS.blue : COLORS.red;
}

export function teamBright(team: 0 | 1): string {
  return team === 0 ? COLORS.blueBright : COLORS.redBright;
}

export const AI_CONFIGS = {
  easy: {
    decide: 0.26,
    reaction: 0.42,
    aimErr: 0.17,
    aimWander: 2.2,
    prediction: 0.25,
    turnRate: 6,
    dashChance: 0.35,
    moduleChance: 0.5,
    fireHesitation: 0.45,
    bankShots: false,
    threatWeight: 0.7,
  },
  standard: {
    decide: 0.18,
    reaction: 0.26,
    aimErr: 0.09,
    aimWander: 1.7,
    prediction: 0.55,
    turnRate: 9,
    dashChance: 0.65,
    moduleChance: 0.75,
    fireHesitation: 0.2,
    bankShots: true,
    threatWeight: 1,
  },
  hard: {
    decide: 0.12,
    reaction: 0.15,
    aimErr: 0.048,
    aimWander: 1.3,
    prediction: 0.85,
    turnRate: 13,
    dashChance: 0.85,
    moduleChance: 0.9,
    fireHesitation: 0.06,
    bankShots: true,
    threatWeight: 1.25,
  },
} as const;
