// All art is generated in-project: fighters, glow sprites, cover states and
// the full static arena background are pre-rendered to offscreen canvases at
// boot. No external image assets exist. Characters are static sprites — all
// their motion comes from transforms, trails and particles at runtime.

import { COLORS, VIEW_H, VIEW_W } from '../game/constants';
import type { ArenaDef } from '../game/arena';
import type { CoverVisualState } from '../game/types';

const FIGHTER_CANVAS = 128; // drawn at 2x; logical size 64
export const FIGHTER_DRAW = 64;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unsupported');
  return [c, ctx];
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export class AssetFactory {
  fighters: HTMLCanvasElement[] = [];
  fighterFlashes: HTMLCanvasElement[] = [];
  background!: HTMLCanvasElement;
  private glowCache = new Map<string, HTMLCanvasElement>();
  private coverCache = new Map<string, HTMLCanvasElement>();

  constructor(private arena: ArenaDef) {}

  async init(progress: (frac: number, label: string) => void): Promise<void> {
    const yield_ = () => new Promise<void>((r) => setTimeout(r, 0));
    progress(0.05, 'Forging fighters');
    this.fighters = [this.drawBlueFighter(), this.drawRedFighter()];
    this.fighterFlashes = this.fighters.map((f) => this.whiteVersion(f));
    await yield_();
    progress(0.35, 'Charging energy cells');
    this.glow(COLORS.blue);
    this.glow(COLORS.red);
    this.glow(COLORS.redProj);
    this.glow('#ffffff');
    this.glow(COLORS.pad);
    this.glow(COLORS.warn);
    this.glow(COLORS.energyWall);
    await yield_();
    progress(0.6, 'Assembling arena');
    this.background = this.drawBackground();
    await yield_();
    progress(0.95, 'Calibrating systems');
    await yield_();
    progress(1, 'Ready');
  }

  glow(color: string): HTMLCanvasElement {
    const hit = this.glowCache.get(color);
    if (hit) return hit;
    const [c, ctx] = canvas(64, 64);
    const [r, g, b] = hexToRgb(color);
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.95)`);
    grad.addColorStop(0.35, `rgba(${r},${g},${b},0.4)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    this.glowCache.set(color, c);
    return c;
  }

  private whiteVersion(src: HTMLCanvasElement): HTMLCanvasElement {
    const [c, ctx] = canvas(src.width, src.height);
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }

  // -------------------------------------------------------------------------
  // Fighters (drawn facing +X, centred, at 2x scale)
  // -------------------------------------------------------------------------

  private drawBlueFighter(): HTMLCanvasElement {
    const [c, ctx] = canvas(FIGHTER_CANVAS, FIGHTER_CANVAS);
    ctx.translate(64, 64);
    ctx.scale(2, 2);
    ctx.lineJoin = 'round';

    // Sleek teardrop hull with swept rear fins — built to look fast.
    const hull = new Path2D();
    hull.moveTo(24, 0);
    hull.quadraticCurveTo(16, -12, -2, -13);
    hull.quadraticCurveTo(-14, -13, -19, -7);
    hull.lineTo(-19, 7);
    hull.quadraticCurveTo(-14, 13, -2, 13);
    hull.quadraticCurveTo(16, 12, 24, 0);
    hull.closePath();

    // Rear fins.
    const finT = new Path2D();
    finT.moveTo(-8, -11);
    finT.lineTo(-24, -17);
    finT.lineTo(-16, -5);
    finT.closePath();
    const finB = new Path2D();
    finB.moveTo(-8, 11);
    finB.lineTo(-24, 17);
    finB.lineTo(-16, 5);
    finB.closePath();

    ctx.save();
    ctx.shadowColor = rgba(COLORS.blue, 0.55);
    ctx.shadowBlur = 10;
    const finGrad = ctx.createLinearGradient(-24, -16, -6, 0);
    finGrad.addColorStop(0, '#123c7c');
    finGrad.addColorStop(1, '#2c7fe8');
    ctx.fillStyle = finGrad;
    ctx.fill(finT);
    ctx.fill(finB);

    const hullGrad = ctx.createLinearGradient(-16, -14, 18, 12);
    hullGrad.addColorStop(0, '#8fe9ff');
    hullGrad.addColorStop(0.4, '#2b8de8');
    hullGrad.addColorStop(1, '#0b2f66');
    ctx.fillStyle = hullGrad;
    ctx.fill(hull);
    ctx.restore();

    ctx.strokeStyle = 'rgba(6,16,34,0.7)';
    ctx.lineWidth = 1.6;
    ctx.stroke(hull);
    ctx.stroke(finT);
    ctx.stroke(finB);

    // Rim light along the upper edge.
    ctx.strokeStyle = 'rgba(235,252,255,0.75)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(21, -2.5);
    ctx.quadraticCurveTo(14, -10.5, -2, -11.4);
    ctx.stroke();

    // Body stripe.
    ctx.strokeStyle = rgba(COLORS.blue, 0.9);
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(-17, 0);
    ctx.lineTo(8, 0);
    ctx.stroke();

    // Canopy.
    const cano = ctx.createLinearGradient(4, -6, 14, 5);
    cano.addColorStop(0, '#ffffff');
    cano.addColorStop(1, '#5ad2ff');
    ctx.fillStyle = cano;
    ctx.beginPath();
    ctx.ellipse(9, 0, 7.2, 4.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,34,70,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Twin engines with glow.
    ctx.fillStyle = '#0c2650';
    ctx.fillRect(-22, -8.5, 5, 6);
    ctx.fillRect(-22, 2.5, 5, 6);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rgba('#bff6ff', 0.9);
    ctx.beginPath();
    ctx.arc(-21.5, -5.5, 2.6, 0, Math.PI * 2);
    ctx.arc(-21.5, 5.5, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Muzzle emitter at the nose.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rgba(COLORS.blueBright, 0.95);
    ctx.beginPath();
    ctx.arc(22, 0, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    return c;
  }

  private drawRedFighter(): HTMLCanvasElement {
    const [c, ctx] = canvas(FIGHTER_CANVAS, FIGHTER_CANVAS);
    ctx.translate(64, 64);
    ctx.scale(2, 2);
    ctx.lineJoin = 'round';

    // Angular dart with forward-swept blades — built to look dangerous.
    const hull = new Path2D();
    hull.moveTo(25, 0);
    hull.lineTo(6, -8);
    hull.lineTo(-6, -12);
    hull.lineTo(-19, -8);
    hull.lineTo(-15, 0);
    hull.lineTo(-19, 8);
    hull.lineTo(-6, 12);
    hull.lineTo(6, 8);
    hull.closePath();

    const bladeT = new Path2D();
    bladeT.moveTo(2, -8);
    bladeT.lineTo(14, -18);
    bladeT.lineTo(-10, -11.5);
    bladeT.closePath();
    const bladeB = new Path2D();
    bladeB.moveTo(2, 8);
    bladeB.lineTo(14, 18);
    bladeB.lineTo(-10, 11.5);
    bladeB.closePath();

    ctx.save();
    ctx.shadowColor = rgba(COLORS.red, 0.55);
    ctx.shadowBlur = 10;
    const bladeGrad = ctx.createLinearGradient(-8, -18, 10, 0);
    bladeGrad.addColorStop(0, '#5c1230');
    bladeGrad.addColorStop(1, '#e23558');
    ctx.fillStyle = bladeGrad;
    ctx.fill(bladeT);
    ctx.fill(bladeB);

    const hullGrad = ctx.createLinearGradient(-16, -12, 20, 12);
    hullGrad.addColorStop(0, '#ffa38f');
    hullGrad.addColorStop(0.35, '#d92645');
    hullGrad.addColorStop(1, '#3a1026');
    ctx.fillStyle = hullGrad;
    ctx.fill(hull);
    ctx.restore();

    ctx.strokeStyle = 'rgba(26,6,18,0.75)';
    ctx.lineWidth = 1.6;
    ctx.stroke(hull);
    ctx.stroke(bladeT);
    ctx.stroke(bladeB);

    // Graphite spine plate.
    ctx.fillStyle = '#2a2331';
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(0, -5);
    ctx.lineTo(-13, 0);
    ctx.lineTo(0, 5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = rgba('#ff4de1', 0.5);
    ctx.lineWidth = 1;
    ctx.stroke();

    // Rim light.
    ctx.strokeStyle = 'rgba(255,224,214,0.7)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(22, -1.5);
    ctx.lineTo(6, -7.4);
    ctx.lineTo(-5, -11);
    ctx.stroke();

    // Cockpit slit.
    const cano = ctx.createLinearGradient(6, -3, 12, 3);
    cano.addColorStop(0, '#ffe9e2');
    cano.addColorStop(1, '#ff7d6e');
    ctx.fillStyle = cano;
    ctx.beginPath();
    ctx.moveTo(15, 0);
    ctx.lineTo(7, -3.2);
    ctx.lineTo(4, 0);
    ctx.lineTo(7, 3.2);
    ctx.closePath();
    ctx.fill();

    // Engine glow.
    ctx.fillStyle = '#331127';
    ctx.fillRect(-20, -5, 5, 10);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rgba('#ffb3a0', 0.95);
    ctx.beginPath();
    ctx.arc(-19, 0, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Muzzle emitter.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rgba('#ffd9cf', 0.95);
    ctx.beginPath();
    ctx.arc(23, 0, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    return c;
  }

  // -------------------------------------------------------------------------
  // Cover sprites per damage state (cached by size + state + temp flag)
  // -------------------------------------------------------------------------

  cover(w: number, h: number, state: CoverVisualState, temp: boolean): HTMLCanvasElement {
    const key = `${w}x${h}:${state}:${temp ? 't' : 'p'}`;
    const hit = this.coverCache.get(key);
    if (hit) return hit;
    const pad = 8;
    const [c, ctx] = canvas(w + pad * 2, h + pad * 2);
    ctx.translate(pad, pad);

    if (state === 'destroyed') {
      // Flattened rubble — visibly no longer blocking.
      ctx.fillStyle = 'rgba(14,17,24,0.85)';
      roundRect(ctx, 2, 4, w - 4, h - 6, 6);
      ctx.fill();
      ctx.fillStyle = '#1c222e';
      for (let i = 0; i < 7; i++) {
        const rx = 4 + ((i * 53) % (w - 18));
        const ry = 4 + ((i * 37) % (h - 14));
        ctx.save();
        ctx.translate(rx + 6, ry + 5);
        ctx.rotate(i * 1.1);
        ctx.fillRect(-6, -4, 12, 8);
        ctx.restore();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.strokeRect(1, 2, w - 2, h - 4);
      this.coverCache.set(key, c);
      return c;
    }

    const base = temp ? '#1d4340' : '#2b3448';
    const top = temp ? '#2c6b60' : '#3d4a66';
    const edge = temp ? COLORS.pad : '#5f7396';

    // Side (gives the slab a little height).
    ctx.fillStyle = shade(base, -0.35);
    roundRect(ctx, 0, 4, w, h, 7);
    ctx.fill();
    // Top face.
    const grad = ctx.createLinearGradient(0, 0, w * 0.7, h);
    grad.addColorStop(0, shade(top, 0.22));
    grad.addColorStop(1, shade(top, -0.18));
    ctx.fillStyle = grad;
    roundRect(ctx, 0, 0, w, h - 4, 7);
    ctx.fill();
    // Rim highlight + edge line.
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(4, h - 8);
    ctx.lineTo(4, 6);
    ctx.quadraticCurveTo(4, 3, 8, 3);
    ctx.lineTo(w - 6, 3);
    ctx.stroke();
    ctx.strokeStyle = rgba(edge, 0.35);
    ctx.lineWidth = 1;
    roundRect(ctx, 0.5, 0.5, w - 1, h - 5, 7);
    ctx.stroke();
    // Panel seams + bolts.
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.moveTo(w / 2, 4);
    ctx.lineTo(w / 2, h - 8);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (const [bx, by] of [[7, 7], [w - 7, 7], [7, h - 11], [w - 7, h - 11]] as const) {
      ctx.beginPath();
      ctx.arc(bx, by, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (temp) {
      ctx.strokeStyle = rgba(COLORS.pad, 0.5);
      ctx.setLineDash([6, 4]);
      roundRect(ctx, 3.5, 3.5, w - 7, h - 11, 5);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      // Amber service accents, echoing the concept blocks.
      ctx.strokeStyle = rgba(COLORS.warn, 0.5);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(w - 4, h - 18);
      ctx.lineTo(w - 4, h - 9);
      ctx.lineTo(w - 13, h - 9);
      ctx.stroke();
      ctx.strokeStyle = rgba(COLORS.warn, 0.3);
      ctx.beginPath();
      ctx.moveTo(w - 26, 4);
      ctx.lineTo(w - 18, 12);
      ctx.moveTo(w - 18, 4);
      ctx.lineTo(w - 10, 12);
      ctx.stroke();
      ctx.fillStyle = rgba(COLORS.warn, 0.35);
      ctx.fillRect(Math.round(w / 2) - 13, h - 9, 26, 2.5);
    }

    // Damage cracks.
    const cracks = state === 'damaged' ? 2 : state === 'critical' ? 5 : 0;
    ctx.strokeStyle = 'rgba(6,8,12,0.75)';
    ctx.lineWidth = 1.6;
    for (let i = 0; i < cracks; i++) {
      const sx = (w * (i + 0.7)) / (cracks + 1);
      let x = sx;
      let y = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const segs = 4;
      for (let s = 0; s < segs; s++) {
        x += Math.sin(i * 3.7 + s * 2.9) * 10;
        y += (h - 8) / segs;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    if (state === 'critical') {
      // Emissive stress fractures.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(COLORS.warn, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w * 0.25, h * 0.3);
      ctx.lineTo(w * 0.45, h * 0.55);
      ctx.lineTo(w * 0.35, h * 0.8);
      ctx.moveTo(w * 0.7, h * 0.2);
      ctx.lineTo(w * 0.6, h * 0.5);
      ctx.lineTo(w * 0.78, h * 0.72);
      ctx.stroke();
      ctx.restore();
    }
    this.coverCache.set(key, c);
    return c;
  }

  // -------------------------------------------------------------------------
  // Static arena background (rendered once at 2x)
  // -------------------------------------------------------------------------

  private drawBackground(): HTMLCanvasElement {
    const S = 2;
    const [c, ctx] = canvas(VIEW_W * S, VIEW_H * S);
    ctx.scale(S, S);
    const a = this.arena;

    // Deep space-station backdrop.
    ctx.fillStyle = '#07090f';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Header strip behind the HUD.
    const hdr = ctx.createLinearGradient(0, 0, 0, a.top - a.wallThickness);
    hdr.addColorStop(0, '#0b0f18');
    hdr.addColorStop(1, '#080b12');
    ctx.fillStyle = hdr;
    ctx.fillRect(0, 0, VIEW_W, a.top - a.wallThickness);
    ctx.strokeStyle = 'rgba(90,140,200,0.08)';
    ctx.beginPath();
    ctx.moveTo(0, a.top - a.wallThickness - 1);
    ctx.lineTo(VIEW_W, a.top - a.wallThickness - 1);
    ctx.stroke();

    const octagon = (inset: number): Path2D => {
      const p = new Path2D();
      const L = a.left - inset;
      const T = a.top - inset;
      const R = a.right + inset;
      const B = a.bottom + inset;
      const ch = a.chamfer + inset * 0.41;
      p.moveTo(L + ch, T);
      p.lineTo(R - ch, T);
      p.lineTo(R, T + ch);
      p.lineTo(R, B - ch);
      p.lineTo(R - ch, B);
      p.lineTo(L + ch, B);
      p.lineTo(L, B - ch);
      p.lineTo(L, T + ch);
      p.closePath();
      return p;
    };

    // Wall body (outer octagon), then floor (inner octagon).
    const wallPath = octagon(a.wallThickness);
    const wallGrad = ctx.createLinearGradient(0, a.top - 26, 0, a.bottom + 26);
    wallGrad.addColorStop(0, '#313c52');
    wallGrad.addColorStop(0.5, '#222b3d');
    wallGrad.addColorStop(1, '#161c2a');
    ctx.fillStyle = wallGrad;
    ctx.fill(wallPath);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 2;
    ctx.stroke(wallPath);

    // Wall top-edge highlight.
    ctx.strokeStyle = 'rgba(190,220,255,0.14)';
    ctx.lineWidth = 2;
    ctx.stroke(octagon(a.wallThickness - 3));

    // Segmented panel seams across the wall band.
    for (const s of a.segs) {
      const len = Math.hypot(s.bx - s.ax, s.by - s.ay);
      const ux = (s.bx - s.ax) / len;
      const uy = (s.by - s.ay) / len;
      const n = Math.max(1, Math.round(len / 130));
      ctx.lineWidth = 2;
      for (let i = 1; i < n; i++) {
        const px = s.ax + ux * ((len * i) / n);
        const py = s.ay + uy * ((len * i) / n);
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - s.nx * (a.wallThickness - 2), py - s.ny * (a.wallThickness - 2));
        ctx.stroke();
        ctx.strokeStyle = 'rgba(190,220,255,0.07)';
        ctx.beginPath();
        ctx.moveTo(px + ux * 2, py + uy * 2);
        ctx.lineTo(px + ux * 2 - s.nx * (a.wallThickness - 2), py + uy * 2 - s.ny * (a.wallThickness - 2));
        ctx.stroke();
      }
    }

    // Outer bumper tabs break up the silhouette at the wall midpoints.
    const tab = (tx: number, ty: number, tw: number, th: number) => {
      ctx.fillStyle = '#1b2334';
      roundRect(ctx, tx, ty, tw, th, 3);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1.5;
      roundRect(ctx, tx, ty, tw, th, 3);
      ctx.stroke();
      // Small amber status light centred on the tab.
      ctx.save();
      ctx.shadowColor = COLORS.warn;
      ctx.shadowBlur = 6;
      ctx.fillStyle = rgba(COLORS.warn, 0.75);
      ctx.beginPath();
      ctx.arc(tx + tw / 2, ty + th / 2, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    tab(a.left - a.wallThickness - 8, a.cy - 72, 10, 144);
    tab(a.right + a.wallThickness - 2, a.cy - 72, 10, 144);
    tab(a.cx - 96, a.bottom + a.wallThickness - 2, 192, 10);
    tab(a.cx - 96, a.top - a.wallThickness - 6, 192, 8);

    // Inset perimeter lights: blue toward P1, red toward P2, amber elsewhere.
    for (const s of a.segs) {
      const len = Math.hypot(s.bx - s.ax, s.by - s.ay);
      const ux = (s.bx - s.ax) / len;
      const uy = (s.by - s.ay) / len;
      const isDiag = s.nx !== 0 && s.ny !== 0;
      const count = isDiag ? 1 : Math.max(2, Math.round(len / 190));
      for (let i = 0; i < count; i++) {
        const f = (i + 0.5) / count;
        const px = s.ax + ux * len * f - s.nx * a.wallThickness * 0.55;
        const py = s.ay + uy * len * f - s.ny * a.wallThickness * 0.55;
        const color = isDiag
          ? COLORS.warn
          : Math.abs(px - a.cx) < 100 ? COLORS.warn : px < a.cx ? COLORS.blue : COLORS.red;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(Math.atan2(uy, ux));
        // Recessed housing.
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        roundRect(ctx, -11, -3.5, 22, 7, 3);
        ctx.fill();
        // Emissive strip + bright core.
        ctx.shadowColor = color;
        ctx.shadowBlur = 9;
        ctx.fillStyle = rgba(color, 0.85);
        roundRect(ctx, -8, -2, 16, 4, 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        roundRect(ctx, -5, -0.8, 10, 1.6, 0.8);
        ctx.fill();
        ctx.restore();
      }
    }

    // Floor.
    const floorPath = octagon(0);
    ctx.save();
    ctx.clip(floorPath);
    ctx.fillStyle = COLORS.floor;
    ctx.fillRect(a.left, a.top, a.right - a.left, a.bottom - a.top);

    // Metal plates with subtle per-plate tint variation.
    const plate = 64;
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let px = a.left; px < a.right; px += plate) {
      for (let py = a.top; py < a.bottom; py += plate) {
        const v = rnd();
        if (v > 0.55) {
          ctx.fillStyle = `rgba(255,255,255,${0.012 + v * 0.02})`;
          ctx.fillRect(px, py, plate, plate);
        } else if (v < 0.16) {
          ctx.fillStyle = 'rgba(0,0,0,0.14)';
          ctx.fillRect(px, py, plate, plate);
        }
      }
    }
    ctx.strokeStyle = 'rgba(160,200,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let px = a.left; px <= a.right; px += plate) {
      ctx.moveTo(px, a.top);
      ctx.lineTo(px, a.bottom);
    }
    for (let py = a.top; py <= a.bottom; py += plate) {
      ctx.moveTo(a.left, py);
      ctx.lineTo(a.right, py);
    }
    ctx.stroke();

    // Centre light pool + emblem.
    const pool = ctx.createRadialGradient(a.cx, a.cy, 40, a.cx, a.cy, 380);
    pool.addColorStop(0, 'rgba(90,150,255,0.07)');
    pool.addColorStop(1, 'rgba(90,150,255,0)');
    ctx.fillStyle = pool;
    ctx.fillRect(a.left, a.top, a.right - a.left, a.bottom - a.top);
    ctx.strokeStyle = 'rgba(120,190,255,0.1)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(a.cx, a.cy, 120, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(120,190,255,0.06)';
    ctx.beginPath();
    ctx.arc(a.cx, a.cy, 190, 0, Math.PI * 2);
    ctx.moveTo(a.cx, a.top + 8);
    ctx.lineTo(a.cx, a.bottom - 8);
    ctx.stroke();

    // Amber service markings on the floor beneath the wall emitters.
    ctx.strokeStyle = rgba(COLORS.warn, 0.13);
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    for (const [mx, my] of [
      [420, a.top + 30], [860, a.top + 30],
      [420, a.bottom - 30], [860, a.bottom - 30],
    ] as const) {
      ctx.beginPath();
      for (let k = 0; k < 3; k++) {
        ctx.moveTo(mx - 26 + k * 20, my + 6);
        ctx.lineTo(mx - 14 + k * 20, my - 6);
      }
      ctx.stroke();
    }
    ctx.lineCap = 'butt';

    // Spawn markers.
    for (const s of a.spawns) {
      ctx.strokeStyle = 'rgba(200,225,255,0.12)';
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 30, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Temp-wall floor tracks.
    ctx.strokeStyle = rgba(COLORS.energyWall, 0.14);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 6]);
    for (const s of this.arena.wallSlots) {
      ctx.strokeRect(s.x - s.w / 2, s.y - s.h / 2, s.w, s.h);
    }
    ctx.setLineDash([]);
    // Cover-slot corner ticks.
    ctx.strokeStyle = 'rgba(120,255,200,0.12)';
    for (const s of this.arena.coverSlots) {
      const hw = s.w / 2;
      const hh = s.h / 2;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        ctx.beginPath();
        ctx.moveTo(s.x + sx * hw, s.y + sy * (hh - 8));
        ctx.lineTo(s.x + sx * hw, s.y + sy * hh);
        ctx.lineTo(s.x + sx * (hw - 8), s.y + sy * hh);
        ctx.stroke();
      }
    }

    // Pad bases.
    for (const p of a.padDefs) {
      ctx.fillStyle = 'rgba(10,20,20,0.75)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 32, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(COLORS.pad, 0.35);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 28, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = rgba(COLORS.pad, 0.16);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 33, 0, Math.PI * 2);
      ctx.stroke();
      // Direction chevrons.
      const ang = Math.atan2(p.dy, p.dx);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(ang);
      ctx.strokeStyle = rgba(COLORS.pad, 0.55);
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      for (let k = 0; k < 3; k++) {
        const off = -8 + k * 8;
        ctx.beginPath();
        ctx.moveTo(off - 4, -8);
        ctx.lineTo(off + 4, 0);
        ctx.lineTo(off - 4, 8);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Floor vignette.
    const vig = ctx.createRadialGradient(a.cx, a.cy, 240, a.cx, a.cy, 640);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.32)');
    ctx.fillStyle = vig;
    ctx.fillRect(a.left, a.top, a.right - a.left, a.bottom - a.top);
    ctx.restore(); // un-clip floor

    // Inner wall edge glow.
    ctx.strokeStyle = 'rgba(110,190,255,0.2)';
    ctx.lineWidth = 2;
    ctx.stroke(floorPath);
    ctx.strokeStyle = 'rgba(110,190,255,0.06)';
    ctx.lineWidth = 6;
    ctx.stroke(floorPath);

    // Corner accent plates on the chamfers, with amber hazard striping.
    for (const s of a.segs) {
      const isDiag = s.nx !== 0 && s.ny !== 0;
      if (!isDiag) continue;
      ctx.save();
      ctx.translate((s.ax + s.bx) / 2, (s.ay + s.by) / 2);
      ctx.rotate(Math.atan2(s.by - s.ay, s.bx - s.ax));
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(-34, -a.wallThickness, 68, a.wallThickness);
      ctx.beginPath();
      ctx.rect(-34, -a.wallThickness, 68, a.wallThickness);
      ctx.clip();
      ctx.strokeStyle = rgba(COLORS.warn, 0.16);
      ctx.lineWidth = 5;
      ctx.beginPath();
      for (let k = -40; k < 40; k += 16) {
        ctx.moveTo(k, 2);
        ctx.lineTo(k + a.wallThickness + 4, -a.wallThickness - 2);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Laser emitter fixtures.
    for (const e of a.emitters) {
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.rotate(e.dir);
      ctx.fillStyle = '#141a26';
      ctx.beginPath();
      ctx.moveTo(-10, -13);
      ctx.lineTo(4, -8);
      ctx.lineTo(4, 8);
      ctx.lineTo(-10, 13);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(150,180,220,0.25)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,80,70,0.4)';
      ctx.beginPath();
      ctx.arc(1, 0, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    return c;
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function shade(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = (v: number) =>
    Math.round(Math.min(255, Math.max(0, amt >= 0 ? v + (255 - v) * amt : v * (1 + amt))));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

export { roundRect };
