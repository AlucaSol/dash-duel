// Typed network protocol. Every message crossing the wire is defined and
// validated here. The model is host-authoritative: the client sends inputs,
// the host sends snapshots, sim events and match-flow messages.

import { NET } from '../game/constants';
import type { ModuleType, SimEvent, SimPhase, Team, WallPhase } from '../game/types';

export const PROTOCOL_VERSION = NET.protocol;

export interface PlayerSnap {
  x: number; y: number;
  vx: number; vy: number;
  kbx: number; kby: number;
  aim: number;
  hp: number;
  alive: boolean;
  fireCd: number;
  dashCd: number; dashT: number; dashDx: number; dashDy: number;
  invulnT: number;
  moduleCd: number;
  shieldHp: number; shieldT: number;
  voltShots: number; voltT: number;
  padCd: number;
}

export interface ProjSnap {
  id: number;
  o: Team;
  x: number; y: number;
  vx: number; vy: number;
  oc: boolean;
  b: number;
}

export interface CoverSnap {
  id: number;
  hp: number;
  // Geometry only present for dynamically raised (temp) covers.
  x?: number; y?: number; w?: number; h?: number; mhp?: number;
}

export interface WallSnap {
  id: number;
  slot: number;
  ph: WallPhase;
  t: number;
  life: number;
}

export interface SnapshotMsg {
  t: 'snapshot';
  tick: number;
  ack: number;
  phase: SimPhase;
  phaseT: number;
  timer: number;
  sd: boolean;
  sdR: number;
  round: number;
  scores: [number, number];
  swap: boolean;
  p: [PlayerSnap, PlayerSnap];
  projs: ProjSnap[];
  covers: CoverSnap[];
  walls: WallSnap[];
  pads: number[];
}

export type LobbyPhase = 'loadout' | 'rematch';

export type NetMsg =
  | { t: 'hello'; v: number }
  | { t: 'helloAck'; v: number }
  | {
      t: 'lobby';
      phase: LobbyPhase;
      hostLoadout: ModuleType | null;
      clientLoadout: ModuleType | null;
      hostReady: boolean;
      clientReady: boolean;
    }
  | { t: 'loadout'; module: ModuleType }
  | { t: 'ready'; ready: boolean }
  | { t: 'startMatch'; seed: number; hostLoadout: ModuleType; clientLoadout: ModuleType }
  /** Sent by either peer once its match assets are loaded and it is at the gate. */
  | { t: 'matchReady' }
  /** Host → client: both sides are loaded, unfreeze and play. */
  | { t: 'matchGo' }
  | { t: 'roundStart'; round: number; swap: boolean; scores: [number, number] }
  | { t: 'input'; seq: number; mx: number; my: number; aim: number; b: number }
  | SnapshotMsg
  | { t: 'ev'; e: SimEvent }
  | { t: 'roundEnd'; winner: number; scores: [number, number] }
  | { t: 'matchEnd'; winner: number; scores: [number, number] }
  | { t: 'returnToLobby' }
  | { t: 'leave' }
  | { t: 'ping'; ts: number }
  | { t: 'pong'; ts: number };

const MODULE_SET = new Set(['aegis', 'repulsor', 'volt']);
const EVENT_KINDS = new Set([
  'shot', 'projSpawn', 'projDie', 'bounce', 'hit', 'death', 'dash', 'module',
  'shieldBreak', 'pad', 'coverHit', 'coverBreak', 'coverRepair', 'coverRaise',
  'wallUp', 'wallBreak', 'zoneBoom', 'arenaEvent', 'arenaEnd', 'suddenDeath', 'roundEnd',
]);

function num(v: unknown): boolean {
  return typeof v === 'number' && isFinite(v);
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Validate an incoming raw message. Returns the typed message or null.
 * Field-level clamping of gameplay-critical values (inputs) happens here so
 * a hostile peer can't inject NaN positions or impossible movement.
 */
export function validateMsg(raw: unknown): NetMsg | null {
  if (!isRec(raw) || typeof raw.t !== 'string') return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'hello':
    case 'helloAck':
      return num(m.v) ? ({ t: m.t, v: m.v as number } as NetMsg) : null;
    case 'lobby': {
      if (m.phase !== 'loadout' && m.phase !== 'rematch') return null;
      const okMod = (v: unknown) => v === null || (typeof v === 'string' && MODULE_SET.has(v));
      if (!okMod(m.hostLoadout) || !okMod(m.clientLoadout)) return null;
      if (typeof m.hostReady !== 'boolean' || typeof m.clientReady !== 'boolean') return null;
      return raw as NetMsg;
    }
    case 'loadout':
      return typeof m.module === 'string' && MODULE_SET.has(m.module) ? (raw as NetMsg) : null;
    case 'ready':
      return typeof m.ready === 'boolean' ? (raw as NetMsg) : null;
    case 'startMatch':
      if (!num(m.seed)) return null;
      if (typeof m.hostLoadout !== 'string' || !MODULE_SET.has(m.hostLoadout)) return null;
      if (typeof m.clientLoadout !== 'string' || !MODULE_SET.has(m.clientLoadout)) return null;
      return raw as NetMsg;
    case 'roundStart':
      if (!num(m.round) || typeof m.swap !== 'boolean' || !Array.isArray(m.scores)) return null;
      if (!num(m.scores[0]) || !num(m.scores[1])) return null;
      return raw as NetMsg;
    case 'input': {
      if (!num(m.seq) || !num(m.mx) || !num(m.my) || !num(m.aim) || !num(m.b)) return null;
      const mx = Math.max(-1, Math.min(1, m.mx as number));
      const my = Math.max(-1, Math.min(1, m.my as number));
      const b = (m.b as number) & 7;
      return { t: 'input', seq: Math.floor(m.seq as number), mx, my, aim: m.aim as number, b };
    }
    case 'snapshot': {
      if (!num(m.tick) || !num(m.ack) || !num(m.phaseT) || !num(m.timer)) return null;
      if (!Array.isArray(m.p) || m.p.length !== 2) return null;
      if (!Array.isArray(m.projs) || !Array.isArray(m.covers) || !Array.isArray(m.walls) || !Array.isArray(m.pads)) return null;
      return raw as NetMsg;
    }
    case 'ev': {
      if (!isRec(m.e) || typeof (m.e as Record<string, unknown>).k !== 'string') return null;
      if (!EVENT_KINDS.has((m.e as Record<string, unknown>).k as string)) return null;
      return raw as NetMsg;
    }
    case 'roundEnd':
    case 'matchEnd':
      if (!num(m.winner) || !Array.isArray(m.scores) || !num(m.scores[0]) || !num(m.scores[1])) return null;
      return raw as NetMsg;
    case 'matchReady':
    case 'matchGo':
    case 'returnToLobby':
    case 'leave':
      return raw as NetMsg;
    case 'ping':
    case 'pong':
      return num(m.ts) ? (raw as NetMsg) : null;
    default:
      return null;
  }
}
