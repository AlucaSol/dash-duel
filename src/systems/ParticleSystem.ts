// Pooled particle effects: sparks, glow puffs, debris shards, expanding
// rings, floating damage text and dash afterimages. Fixed-capacity arrays —
// nothing is allocated inside the frame loop once pools are warm.

import type { Team } from '../game/types';

interface Particle {
  alive: boolean;
  type: 0 | 1 | 2; // spark, glow, debris
  x: number; y: number;
  vx: number; vy: number;
  rot: number; vr: number;
  t: number; life: number;
  size: number;
  color: string;
  additive: boolean;
  drag: number;
}

interface Ring {
  alive: boolean;
  x: number; y: number;
  r1: number;
  t: number; life: number;
  color: string;
  width: number;
}

interface FloatText {
  alive: boolean;
  x: number; y: number;
  t: number; life: number;
  str: string;
  color: string;
}

interface Afterimage {
  alive: boolean;
  team: Team;
  x: number; y: number;
  rot: number;
  t: number; life: number;
}

function makeParticle(): Particle {
  return {
    alive: false, type: 0, x: 0, y: 0, vx: 0, vy: 0, rot: 0, vr: 0,
    t: 0, life: 1, size: 2, color: '#fff', additive: true, drag: 2,
  };
}

export class ParticleSystem {
  particles: Particle[] = [];
  rings: Ring[] = [];
  texts: FloatText[] = [];
  afterimages: Afterimage[] = [];
  private cap = 350;
  private cursor = 0;

  constructor() {
    this.setCap(600); // allocate the max once; `cap` limits how many we use
    for (let i = 0; i < 28; i++) {
      this.rings.push({ alive: false, x: 0, y: 0, r1: 10, t: 0, life: 1, color: '#fff', width: 2 });
    }
    for (let i = 0; i < 12; i++) {
      this.texts.push({ alive: false, x: 0, y: 0, t: 0, life: 1, str: '', color: '#fff' });
    }
    for (let i = 0; i < 48; i++) {
      this.afterimages.push({ alive: false, team: 0, x: 0, y: 0, rot: 0, t: 0, life: 0.3 });
    }
  }

  setCap(n: number): void {
    this.cap = n;
    while (this.particles.length < 600) this.particles.push(makeParticle());
  }

  clear(): void {
    for (const p of this.particles) p.alive = false;
    for (const r of this.rings) r.alive = false;
    for (const t of this.texts) t.alive = false;
    for (const a of this.afterimages) a.alive = false;
  }

  get liveCount(): number {
    let n = 0;
    for (const p of this.particles) if (p.alive) n++;
    return n;
  }

  private take(): Particle | null {
    // Scan from the cursor for a dead slot within the active cap.
    for (let i = 0; i < this.cap; i++) {
      const idx = (this.cursor + i) % this.cap;
      const p = this.particles[idx];
      if (!p.alive) {
        this.cursor = (idx + 1) % this.cap;
        return p;
      }
    }
    return null; // pool saturated — drop the effect
  }

  spawnSparks(
    x: number, y: number,
    baseAng: number, spread: number,
    count: number, speed: number,
    life: number, size: number,
    color: string, additive = true,
  ): void {
    for (let i = 0; i < count; i++) {
      const p = this.take();
      if (!p) return;
      const a = baseAng + (Math.random() - 0.5) * spread;
      const sp = speed * (0.4 + Math.random() * 0.9);
      p.alive = true;
      p.type = 0;
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.rot = a; p.vr = 0;
      p.t = 0;
      p.life = life * (0.6 + Math.random() * 0.7);
      p.size = size * (0.7 + Math.random() * 0.6);
      p.color = color;
      p.additive = additive;
      p.drag = 4;
    }
  }

  spawnGlow(x: number, y: number, size: number, life: number, color: string): void {
    const p = this.take();
    if (!p) return;
    p.alive = true;
    p.type = 1;
    p.x = x; p.y = y;
    p.vx = (Math.random() - 0.5) * 20;
    p.vy = (Math.random() - 0.5) * 20;
    p.rot = 0; p.vr = 0;
    p.t = 0; p.life = life;
    p.size = size;
    p.color = color;
    p.additive = true;
    p.drag = 1;
  }

  spawnDebris(x: number, y: number, count: number, color: string, baseAng = -Math.PI / 2): void {
    for (let i = 0; i < count; i++) {
      const p = this.take();
      if (!p) return;
      const a = baseAng + (Math.random() - 0.5) * Math.PI * 1.6;
      const sp = 60 + Math.random() * 200;
      p.alive = true;
      p.type = 2;
      p.x = x + (Math.random() - 0.5) * 14;
      p.y = y + (Math.random() - 0.5) * 14;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.rot = Math.random() * Math.PI * 2;
      p.vr = (Math.random() - 0.5) * 12;
      p.t = 0;
      p.life = 0.5 + Math.random() * 0.7;
      p.size = 2.5 + Math.random() * 4;
      p.color = color;
      p.additive = false;
      p.drag = 3.2;
    }
  }

  spawnRing(x: number, y: number, r1: number, life: number, color: string, width = 3): void {
    for (const r of this.rings) {
      if (!r.alive) {
        r.alive = true;
        r.x = x; r.y = y;
        r.r1 = r1;
        r.t = 0; r.life = life;
        r.color = color;
        r.width = width;
        return;
      }
    }
  }

  spawnText(x: number, y: number, str: string, color: string): void {
    for (const t of this.texts) {
      if (!t.alive) {
        t.alive = true;
        t.x = x + (Math.random() - 0.5) * 16;
        t.y = y - 14;
        t.t = 0; t.life = 0.75;
        t.str = str;
        t.color = color;
        return;
      }
    }
  }

  spawnAfterimage(team: Team, x: number, y: number, rot: number): void {
    for (const a of this.afterimages) {
      if (!a.alive) {
        a.alive = true;
        a.team = team;
        a.x = x; a.y = y;
        a.rot = rot;
        a.t = 0;
        a.life = 0.26;
        return;
      }
    }
  }

  update(dt: number): void {
    for (const p of this.particles) {
      if (!p.alive) continue;
      p.t += dt;
      if (p.t >= p.life) {
        p.alive = false;
        continue;
      }
      const drag = Math.exp(-p.drag * dt);
      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    for (const r of this.rings) {
      if (!r.alive) continue;
      r.t += dt;
      if (r.t >= r.life) r.alive = false;
    }
    for (const t of this.texts) {
      if (!t.alive) continue;
      t.t += dt;
      t.y -= 34 * dt;
      if (t.t >= t.life) t.alive = false;
    }
    for (const a of this.afterimages) {
      if (!a.alive) continue;
      a.t += dt;
      if (a.t >= a.life) a.alive = false;
    }
  }
}
