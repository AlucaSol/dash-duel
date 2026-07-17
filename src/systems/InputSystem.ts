// Keyboard + mouse input. Tracks held keys, converts the mouse to logical
// arena coordinates, and queues dash/module edge presses so a tap between
// simulation ticks is never lost. While `capture` is on (i.e. in a match)
// game keys are prevented from scrolling the page.

import type { InputState } from '../game/types';

const GAME_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyE',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

export class InputSystem {
  private keys = new Set<string>();
  mouseX = 640;
  mouseY = 360;
  private fireHeld = false;
  private dashQueued = false;
  private moduleQueued = false;
  /** When true, game keys call preventDefault and edges are recorded. */
  capture = false;
  onAnyGesture: (() => void) | null = null;
  onEscape: (() => void) | null = null;
  onDebugToggle: (() => void) | null = null;

  attach(canvas: HTMLCanvasElement, toLogical: (sx: number, sy: number) => { x: number; y: number }): void {
    window.addEventListener('keydown', (e) => {
      this.onAnyGesture?.();
      if (e.code === 'Escape') {
        this.onEscape?.();
        return;
      }
      if (e.code === 'F3') {
        if (import.meta.env.DEV) {
          e.preventDefault();
          this.onDebugToggle?.();
        }
        return;
      }
      if (this.isTyping(e)) return;
      this.keys.add(e.code);
      if (this.capture && GAME_CODES.has(e.code)) {
        e.preventDefault();
        if (e.code === 'Space' && !e.repeat) this.dashQueued = true;
        if (e.code === 'KeyE' && !e.repeat) this.moduleQueued = true;
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener('mousemove', (e) => {
      const p = toLogical(e.clientX, e.clientY);
      this.mouseX = p.x;
      this.mouseY = p.y;
    });
    window.addEventListener('mousedown', (e) => {
      this.onAnyGesture?.();
      if (!this.capture) return;
      if (e.target instanceof HTMLElement && e.target.closest('#ui-root .panel')) return;
      if (e.button === 0) this.fireHeld = true;
      if (e.button === 2) this.moduleQueued = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
    });
    window.addEventListener('pointerdown', () => this.onAnyGesture?.());
    window.addEventListener('blur', () => this.clearHeld());
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clearHeld();
    });
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target;
    return t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  clearHeld(): void {
    this.keys.clear();
    this.fireHeld = false;
    this.dashQueued = false;
    this.moduleQueued = false;
  }

  /** Build this tick's InputState, consuming queued edge presses. */
  sample(playerX: number, playerY: number): InputState {
    let mx = 0;
    let my = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) my -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) my += 1;
    const aim = Math.atan2(this.mouseY - playerY, this.mouseX - playerX);
    const inp: InputState = {
      mx, my, aim,
      fire: this.fireHeld,
      dash: this.dashQueued,
      module: this.moduleQueued,
    };
    this.dashQueued = false;
    this.moduleQueued = false;
    return inp;
  }
}
