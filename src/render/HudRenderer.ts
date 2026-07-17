// Canvas HUD: player panels (emblem, name, health, dash + module cooldowns),
// centre score block with round pips, and the round timer. Sits in the header
// strip above the arena so it never covers gameplay.

import { COLORS, DASH, MODULES, PLAYER, ROUND, VIEW_W, teamColor } from '../game/constants';
import type { ModuleType, Team, WorldView } from '../game/types';
import { AssetFactory, rgba, roundRect } from './AssetFactory';
import { clamp01 } from '../utils/math';

export class HudRenderer {
  private trailHp: [number, number] = [PLAYER.maxHp, PLAYER.maxHp];
  private readyFlash = { dash: [0, 0], module: [0, 0] };
  private prevCd = { dash: [0, 0], module: [0, 0] };
  private t = 0;

  constructor(private assets: AssetFactory) {}

  resetRound(): void {
    this.trailHp = [PLAYER.maxHp, PLAYER.maxHp];
  }

  draw(ctx: CanvasRenderingContext2D, view: WorldView, dt: number): void {
    this.t += dt;
    for (let i = 0 as Team; i < 2; i = (i + 1) as Team) {
      const p = view.players[i];
      const hp = Math.max(0, p.hp);
      // Trailing delayed-damage bar eases toward the real value.
      if (this.trailHp[i] > hp) {
        this.trailHp[i] = Math.max(hp, this.trailHp[i] - dt * 55 - (this.trailHp[i] - hp) * dt * 4);
      } else {
        this.trailHp[i] = hp;
      }
      // Ready flashes when a cooldown completes.
      for (const key of ['dash', 'module'] as const) {
        const cd = key === 'dash' ? p.dashCd : p.moduleCd;
        if (this.prevCd[key][i] > 0 && cd <= 0) this.readyFlash[key][i] = 1;
        this.prevCd[key][i] = cd;
        this.readyFlash[key][i] = Math.max(0, this.readyFlash[key][i] - dt * 2.4);
      }
    }

    this.drawPanel(ctx, view, 0);
    this.drawPanel(ctx, view, 1);
    this.drawCenter(ctx, view);
  }

  private drawPanel(ctx: CanvasRenderingContext2D, view: WorldView, team: Team): void {
    const right = team === 1;
    const p = view.players[team];
    const col = teamColor(team);
    const x0 = right ? VIEW_W - 12 - 330 : 12;

    ctx.save();
    // Panel backing.
    ctx.fillStyle = 'rgba(9,13,22,0.78)';
    roundRect(ctx, x0, 8, 330, 62, 9);
    ctx.fill();
    ctx.strokeStyle = rgba(col, 0.35);
    ctx.lineWidth = 1;
    roundRect(ctx, x0 + 0.5, 8.5, 329, 61, 9);
    ctx.stroke();
    // Team accent strip on the outer edge.
    ctx.fillStyle = rgba(col, 0.8);
    if (right) ctx.fillRect(x0 + 330 - 3, 12, 3, 54);
    else ctx.fillRect(x0, 12, 3, 54);

    // Emblem: the fighter sprite in a ring.
    const ex = right ? x0 + 330 - 34 : x0 + 34;
    ctx.save();
    ctx.beginPath();
    ctx.arc(ex, 39, 22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(16,22,36,0.9)';
    ctx.fill();
    ctx.strokeStyle = rgba(col, 0.6);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.clip();
    ctx.translate(ex, 39);
    ctx.rotate(right ? Math.PI : 0);
    ctx.drawImage(this.assets.fighters[team], -19, -19, 38, 38);
    ctx.restore();

    // Name.
    const nameX = right ? x0 + 330 - 64 : x0 + 64;
    ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = right ? 'right' : 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = col;
    ctx.fillText(view.names[team].toUpperCase(), nameX, 24);

    // HP number.
    const hp = Math.max(0, Math.ceil(p.hp));
    const low = hp <= 30 && p.alive;
    const numX = right ? x0 + 64 : x0 + 330 - 64;
    ctx.font = '800 20px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = right ? 'left' : 'right';
    ctx.fillStyle = low ? (Math.sin(this.t * 8) > 0 ? '#ff6a6a' : '#ffd2d2') : '#eef4ff';
    ctx.fillText(String(hp), numX, 44);

    // HP bar with trailing damage.
    const barW = 176;
    const barX = right ? x0 + 330 - 64 - barW : x0 + 64;
    const barY = 30;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(ctx, barX, barY, barW, 11, 4);
    ctx.fill();
    const frac = clamp01(Math.max(0, p.hp) / PLAYER.maxHp);
    const trailFrac = clamp01(this.trailHp[team] / PLAYER.maxHp);
    const fillFrom = (f: number) => (right ? barX + barW - barW * f : barX);
    if (trailFrac > frac) {
      ctx.fillStyle = 'rgba(255,150,80,0.75)';
      roundRect(ctx, fillFrom(trailFrac), barY, barW * trailFrac, 11, 4);
      ctx.fill();
    }
    if (frac > 0) {
      const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      grad.addColorStop(0, col);
      grad.addColorStop(1, rgba(col, 0.65));
      ctx.fillStyle = low && Math.sin(this.t * 8) > 0 ? '#ff5d5d' : grad;
      roundRect(ctx, fillFrom(frac), barY, barW * frac, 11, 4);
      ctx.fill();
    }
    // Shield overlay pips on the bar.
    if (p.shieldHp > 0) {
      const sf = clamp01(p.shieldHp / MODULES.aegis.absorb);
      ctx.fillStyle = 'rgba(240,250,255,0.85)';
      roundRect(ctx, fillFrom(sf * 0.999), barY - 3, barW * sf, 3, 1.5);
      ctx.fill();
    }

    // Cooldown icons: dash + module.
    const iconY = 56;
    const icon1X = right ? x0 + 330 - 64 - 11 : x0 + 64 + 11;
    const icon2X = right ? icon1X - 40 : icon1X + 40;
    const locked = view.phase !== 1;
    this.drawCooldownIcon(ctx, icon1X, iconY, 11, p.dashCd / DASH.cooldown, this.readyFlash.dash[team], col, 'dash', p.module, locked, p.dashCd);
    this.drawCooldownIcon(ctx, icon2X, iconY, 11, p.moduleCd / MODULES[p.module].cooldown, this.readyFlash.module[team], col, 'module', p.module, locked, p.moduleCd);
    // Key labels for the local player only.
    if (team === view.localTeam) {
      ctx.font = '600 8px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(190,210,240,0.6)';
      ctx.textAlign = 'center';
      ctx.fillText('SPACE', icon1X, iconY + 19);
      ctx.fillText('E', icon2X, iconY + 19);
    }
    ctx.restore();
  }

  private drawCooldownIcon(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, r: number,
    cdFrac: number, flash: number, col: string,
    kind: 'dash' | 'module', module: ModuleType,
    locked: boolean, cdSeconds: number,
  ): void {
    cdFrac = clamp01(cdFrac);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(18,24,38,0.95)';
    ctx.fill();
    ctx.strokeStyle = locked ? 'rgba(120,130,150,0.35)' : rgba(col, cdFrac > 0 ? 0.3 : 0.85);
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // Icon glyph.
    ctx.strokeStyle = locked ? 'rgba(150,160,180,0.45)' : cdFrac > 0 ? 'rgba(190,205,230,0.5)' : '#eaf2ff';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    if (kind === 'dash') {
      // Lightning dash chevrons.
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 4);
      ctx.lineTo(x, y);
      ctx.lineTo(x - 5, y + 4);
      ctx.moveTo(x + 1, y - 4);
      ctx.lineTo(x + 6, y);
      ctx.lineTo(x + 1, y + 4);
      ctx.stroke();
    } else if (module === 'aegis') {
      ctx.beginPath();
      ctx.moveTo(x, y - 5.5);
      ctx.lineTo(x + 5, y - 3);
      ctx.lineTo(x + 4, y + 3);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 4, y + 3);
      ctx.lineTo(x - 5, y - 3);
      ctx.closePath();
      ctx.stroke();
    } else if (module === 'repulsor') {
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 5.5, -0.4, 1.2);
      ctx.arc(x, y, 5.5, Math.PI - 0.4, Math.PI + 1.2);
      ctx.stroke();
    } else {
      // Volt bolt.
      ctx.beginPath();
      ctx.moveTo(x + 2, y - 6);
      ctx.lineTo(x - 3, y + 1);
      ctx.lineTo(x + 0.5, y + 1);
      ctx.lineTo(x - 2, y + 6);
      ctx.lineTo(x + 3.5, y - 1);
      ctx.lineTo(x, y - 1);
      ctx.closePath();
      ctx.stroke();
    }

    // Radial cooldown mask.
    if (cdFrac > 0 && !locked) {
      ctx.fillStyle = 'rgba(4,6,12,0.72)';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, r - 0.5, -Math.PI / 2, -Math.PI / 2 + cdFrac * Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      if (cdSeconds > 0.15) {
        ctx.font = '700 9px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(cdSeconds >= 3 ? String(Math.ceil(cdSeconds)) : cdSeconds.toFixed(1), x, y + 0.5);
      }
    }
    if (locked) {
      ctx.fillStyle = 'rgba(10,12,20,0.55)';
      ctx.beginPath();
      ctx.arc(x, y, r - 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // Ready flash ring.
    if (flash > 0) {
      ctx.globalAlpha = flash;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 2 + (1 - flash) * 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawCenter(ctx: CanvasRenderingContext2D, view: WorldView): void {
    const cx = VIEW_W / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(9,13,22,0.78)';
    roundRect(ctx, cx - 130, 8, 260, 62, 9);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,160,220,0.25)';
    ctx.lineWidth = 1;
    roundRect(ctx, cx - 130 + 0.5, 8.5, 259, 61, 9);
    ctx.stroke();

    // Logo + format.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '900 italic 15px "Segoe UI", "Arial Black", system-ui, sans-serif';
    ctx.fillStyle = '#eaf4ff';
    ctx.shadowColor = COLORS.blue;
    ctx.shadowBlur = 6;
    ctx.fillText('DASH DUEL', cx, 24);
    ctx.shadowBlur = 0;
    ctx.font = '600 8px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(150,175,210,0.75)';
    ctx.fillText(`BEST OF ${ROUND.bestOf} · FIRST TO ${ROUND.winsNeeded}`, cx, 34);

    // Score + round pips.
    ctx.font = '800 20px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${view.scores[0]}  –  ${view.scores[1]}`, cx, 55);
    for (let s = 0; s < ROUND.winsNeeded; s++) {
      // Blue pips grow leftward, red pips rightward.
      this.pip(ctx, cx - 52 - s * 16, 48, view.scores[0] > s, 0);
      this.pip(ctx, cx + 52 + s * 16, 48, view.scores[1] > s, 1);
    }

    // Timer / sudden death.
    if (view.suddenDeath) {
      const pulse = Math.sin(this.t * 8) > 0;
      ctx.font = '800 11px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = pulse ? '#ff5d5d' : '#ffb4b4';
      ctx.fillText('⚠ SUDDEN DEATH ⚠', cx, 66);
    } else {
      const t = Math.max(0, view.timer);
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      const lowTime = t <= 10;
      ctx.font = '700 12px Consolas, "Segoe UI", monospace';
      ctx.fillStyle = lowTime ? (Math.sin(this.t * 6) > 0 ? '#ff8181' : '#ffd2d2') : 'rgba(210,228,255,0.9)';
      ctx.fillText(`${m}:${String(s).padStart(2, '0')}`, cx, 66);
    }
    ctx.restore();
  }

  private pip(ctx: CanvasRenderingContext2D, x: number, y: number, filled: boolean, team: Team): void {
    const col = teamColor(team);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    if (filled) {
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = 6;
      ctx.fillRect(-4.5, -4.5, 9, 9);
    } else {
      ctx.strokeStyle = rgba(col, 0.4);
      ctx.lineWidth = 1.4;
      ctx.strokeRect(-4.5, -4.5, 9, 9);
    }
    ctx.restore();
  }
}
