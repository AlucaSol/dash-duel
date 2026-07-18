// DOM overlay: menus, lobby, loadout, settings, pause, results and errors.
// The canvas underneath renders the animated backdrop and all gameplay; the
// DOM is kept for what it does best — buttons, inputs and accessible text.

import { MODULES } from '../game/constants';
import type { Settings } from '../game/settings';
import type { Difficulty, ModuleType } from '../game/types';
import { sanitizeFriendCode } from '../utils/random';

export interface UiHandlers {
  onSolo(diff: Difficulty): void;
  onHost(): void;
  onJoinConnect(code: string): void;
  onLoadoutSelect(m: ModuleType): void;
  onLoadoutReady(): void;
  onBack(): void;
  onRematch(): void;
  onChangeLoadout(): void;
  onMainMenu(): void;
  onResume(): void;
  onQuit(): void;
  onSettingsChanged(): void;
  onCopyCode(): void;
  onToggleFullscreen(): void;
  uiSound(kind: 'click' | 'hover'): void;
}

export type ScreenName =
  | 'none' | 'loading' | 'menu' | 'howto' | 'solo' | 'host' | 'join' | 'loadout' | 'result' | 'error';

export interface LobbyUiState {
  online: boolean;
  isHost: boolean;
  rematch: boolean;
  myModule: ModuleType | null;
  oppModule: ModuleType | null;
  myReady: boolean;
  oppReady: boolean;
  contextLine: string;
}

const MODULE_ORDER: ModuleType[] = ['aegis', 'repulsor', 'volt'];

export class UIManager {
  private root: HTMLElement;
  private screens = new Map<ScreenName, HTMLElement>();
  private current: ScreenName = 'none';
  private els: Record<string, HTMLElement> = {};
  private previewTimer = 0;
  private previewRunning = false;
  private lobby: LobbyUiState | null = null;

  constructor(root: HTMLElement, private settings: Settings, private handlers: UiHandlers) {
    this.root = root;
    this.build();
    this.bind();
  }

  // -------------------------------------------------------------------------

  private build(): void {
    this.root.innerHTML = `
      <div class="screen" data-s="loading">
        <div class="logo">DASH DUEL</div>
        <div class="tagline">ARENA COMBAT · BEST OF FIVE</div>
        <div class="load-bar"><div id="load-fill"></div></div>
        <div class="status" id="load-label">Booting…</div>
      </div>

      <div class="screen" data-s="menu">
        <img class="logo-img" id="menu-logo-img" src="${import.meta.env.BASE_URL}branding/logo.png" alt="Dash Duel" />
        <div class="logo" id="menu-logo-text">DASH DUEL</div>
        <div class="tagline">RICOCHET · DASH · OUTPLAY</div>
        <div class="menu-buttons">
          <button class="btn primary" id="btn-solo">Solo Battle</button>
          <button class="btn" id="btn-host">Host Online Match</button>
          <button class="btn" id="btn-join">Join Online Match</button>
          <button class="btn ghost" id="btn-howto">How to Play</button>
          <button class="btn ghost" id="btn-settings">Settings</button>
        </div>
        <div class="footer-note"></div>
      </div>

      <div class="screen" data-s="howto">
        <div class="panel" style="max-width: 760px">
          <h2>How to <span class="accent">Play</span></h2>
          <div class="howto-grid">
            <h3>Controls</h3>
            <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> <span class="k">Move</span></div>
            <div>Mouse <span class="k">Aim</span> · <kbd>LMB</kbd> <span class="k">Fire</span></div>
            <div><kbd>SPACE</kbd> <span class="k">Dash</span> — brief immunity, breaks energy walls</div>
            <div><kbd>E</kbd> / <kbd>RMB</kbd> <span class="k">Power module</span></div>
            <div><kbd>ESC</kbd> <span class="k">Pause / menu</span></div>
            <div><kbd>F</kbd>ullscreen via Settings</div>
            <h3>The Duel</h3>
            <div>Best of 5 — first to <b>3 round wins</b> takes the match.</div>
            <div>Shots <b>ricochet</b> off walls and cover up to 2 times.</div>
            <div>Cover is <b>destructible</b> — it cracks, crumbles, collapses.</div>
            <div>Corner <b>bounce pads</b> fling you (and shots) across the arena.</div>
            <h3>The Arena Fights Back</h3>
            <div><b style="color:#ff6b5e">Laser sweeps &amp; crossfires</b> — dodge the warning lines.</div>
            <div><b style="color:#ff6b5e">Danger zones</b> — leave before they detonate.</div>
            <div><b style="color:#b18cff">Energy walls</b> — temporary barriers; dash straight through.</div>
            <div>At <b style="color:#ffb020">0:00</b>: sudden death — the arena closes in.</div>
          </div>
          <button class="btn small" id="btn-howto-back">Back</button>
        </div>
      </div>

      <div class="screen" data-s="solo">
        <div class="panel">
          <h2>Select <span class="accent">Difficulty</span></h2>
          <div class="card-row">
            <div class="pick-card" data-diff="easy">
              <h3 style="color:#57e389">EASY</h3>
              <p>A training partner. Slow reactions, generous aim.</p>
            </div>
            <div class="pick-card" data-diff="standard">
              <h3 style="color:#3fd4ff">STANDARD</h3>
              <p>A proper duel. Leads shots, dodges, uses cover.</p>
            </div>
            <div class="pick-card" data-diff="hard">
              <h3 style="color:#ff4d5c">HARD</h3>
              <p>A killer. Sharp aim, bank shots, ruthless modules.</p>
            </div>
          </div>
          <button class="btn small" id="btn-solo-back">Back</button>
        </div>
      </div>

      <div class="screen" data-s="host">
        <div class="panel">
          <h2>Host <span class="accent">Online Match</span></h2>
          <p class="sub">Share this friend code. Your opponent picks <b>Join Online Match</b> and enters it.</p>
          <div class="code-box">
            <div class="code-display" id="host-code">······</div>
            <button class="btn small" id="btn-copy">Copy Code</button>
          </div>
          <div class="waiting" id="host-status">Reserving a code<span class="dots"></span></div>
          <button class="btn small ghost" id="btn-host-cancel">Cancel</button>
        </div>
      </div>

      <div class="screen" data-s="join">
        <div class="panel">
          <h2>Join <span class="accent">Online Match</span></h2>
          <p class="sub">Enter the 6-character friend code from the host.</p>
          <input class="code-input" id="join-input" maxlength="6" autocomplete="off" spellcheck="false" placeholder="ABC123" />
          <div class="status" id="join-status"></div>
          <div class="row">
            <button class="btn small ghost" id="btn-join-back">Back</button>
            <button class="btn small primary" id="btn-join-go">Connect</button>
          </div>
        </div>
      </div>

      <div class="screen" data-s="loadout">
        <div class="panel" style="max-width: 860px">
          <h2>Choose your <span class="accent">Power Module</span></h2>
          <div class="status" id="loadout-context"></div>
          <div class="loadout-cards" id="loadout-cards"></div>
          <div class="ready-state" id="lobby-ready" style="display:none">
            <span class="you">YOU <span class="tag" id="ready-you">CHOOSING</span></span>
            <span class="them">OPPONENT <span class="tag" id="ready-them">CHOOSING</span></span>
          </div>
          <div class="row">
            <button class="btn small ghost" id="btn-loadout-back">Leave</button>
            <button class="btn primary" id="btn-loadout-ready" disabled>Start Match</button>
          </div>
        </div>
      </div>

      <div class="screen" data-s="result">
        <div class="result-buttons">
          <button class="btn primary" id="btn-rematch">Rematch</button>
          <button class="btn" id="btn-changeloadout">Change Loadout</button>
          <button class="btn ghost" id="btn-result-menu">Main Menu</button>
          <div class="status" id="result-status"></div>
        </div>
      </div>

      <div class="screen" data-s="error">
        <div class="panel">
          <h2 id="error-title">Connection <span class="accent">Lost</span></h2>
          <p class="sub" id="error-msg"></p>
          <button class="btn" id="btn-error-menu">Main Menu</button>
        </div>
      </div>

      <div class="modal-backdrop" id="modal-pause">
        <div class="panel">
          <h2>Paused</h2>
          <p class="sub" id="pause-note"></p>
          <button class="btn" id="btn-resume">Resume</button>
          <button class="btn ghost" id="btn-pause-settings">Settings</button>
          <button class="btn danger" id="btn-pause-quit">Quit to Menu</button>
        </div>
      </div>

      <div class="modal-backdrop" id="modal-settings">
        <div class="panel">
          <h2>Settings</h2>
          <div class="settings-grid">
            <label for="set-volume">Master volume</label>
            <input type="range" id="set-volume" min="0" max="1" step="0.05" />
            <label for="set-shake">Screen shake</label>
            <input type="range" id="set-shake" min="0" max="1" step="0.1" />
            <label for="set-quality">Effects quality</label>
            <select id="set-quality">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            <label for="set-flash">Reduced flashes</label>
            <input type="checkbox" id="set-flash" />
            <label>Fullscreen</label>
            <button class="btn small" id="btn-fullscreen">Toggle Fullscreen</button>
          </div>
          <hr class="settings-divider" />
          <div class="support-block">
            <div class="support-text">Enjoying Dash Duel?</div>
            <a class="kofi-widget" href="https://ko-fi.com/G2L623AJ3W" target="_blank" rel="noopener noreferrer">
              <img height="36" style="height:36px;border:0" src="https://storage.ko-fi.com/cdn/kofi5.png?v=6" alt="Buy Me a Coffee at ko-fi.com" />
            </a>
          </div>
          <button class="btn small primary" id="btn-settings-close">Done</button>
        </div>
      </div>

      <div id="toast"></div>
    `;

    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>('.screen'))) {
      this.screens.set(el.dataset.s as ScreenName, el);
    }
    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>('[id]'))) {
      this.els[el.id] = el;
    }
    this.buildLoadoutCards();
    this.bindMenuLogo();
  }

  /**
   * Logo art hook: drop an image at public/branding/logo.png (visible at
   * /branding/logo.png in dev and build) to replace the text wordmark. Falls
   * back to the gradient text logo when no image is present.
   */
  private bindMenuLogo(): void {
    const img = this.els['menu-logo-img'] as HTMLImageElement;
    const text = this.els['menu-logo-text'];
    img.style.display = 'none';
    img.addEventListener('load', () => {
      text.style.display = 'none';
      img.style.display = '';
    });
    img.addEventListener('error', () => {
      img.style.display = 'none';
      text.style.display = '';
    });
  }

  private buildLoadoutCards(): void {
    const holder = this.els['loadout-cards'];
    holder.innerHTML = '';
    for (const m of MODULE_ORDER) {
      const def = MODULES[m];
      const card = document.createElement('div');
      card.className = 'pick-card';
      card.dataset.module = m;
      card.innerHTML = `
        <h3 style="color:${m === 'aegis' ? '#5ad2ff' : m === 'repulsor' ? '#b18cff' : '#ffd166'}">${def.name.toUpperCase()}</h3>
        <canvas width="180" height="80"></canvas>
        <p>${def.desc}</p>
        <div class="cd">Cooldown ${def.cooldown}s · Press E</div>
      `;
      holder.appendChild(card);
    }
  }

  private bind(): void {
    const h = this.handlers;
    const click = (id: string, fn: () => void) => {
      this.els[id].addEventListener('click', () => {
        h.uiSound('click');
        fn();
      });
    };
    // Hover blips on every button.
    this.root.addEventListener('mouseover', (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && (t.classList.contains('btn') || t.classList.contains('pick-card'))) {
        h.uiSound('hover');
      }
    });

    click('btn-solo', () => this.show('solo'));
    click('btn-host', () => h.onHost());
    click('btn-join', () => this.show('join'));
    click('btn-howto', () => this.show('howto'));
    click('btn-settings', () => this.openSettings());
    click('btn-howto-back', () => this.show('menu'));
    click('btn-solo-back', () => this.show('menu'));
    click('btn-host-cancel', () => h.onBack());
    click('btn-join-back', () => h.onBack());
    click('btn-join-go', () => this.submitJoin());
    click('btn-copy', () => h.onCopyCode());
    click('btn-loadout-back', () => h.onBack());
    click('btn-loadout-ready', () => h.onLoadoutReady());
    click('btn-rematch', () => h.onRematch());
    click('btn-changeloadout', () => h.onChangeLoadout());
    click('btn-result-menu', () => h.onMainMenu());
    click('btn-error-menu', () => h.onMainMenu());
    click('btn-resume', () => h.onResume());
    click('btn-pause-settings', () => this.openSettings());
    click('btn-pause-quit', () => h.onQuit());
    click('btn-settings-close', () => this.closeSettings());
    click('btn-fullscreen', () => h.onToggleFullscreen());

    // Difficulty cards.
    for (const card of Array.from(this.root.querySelectorAll<HTMLElement>('[data-diff]'))) {
      card.addEventListener('click', () => {
        h.uiSound('click');
        h.onSolo(card.dataset.diff as Difficulty);
      });
    }
    // Module cards.
    this.els['loadout-cards'].addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const card = t.closest<HTMLElement>('[data-module]');
      if (!card) return;
      h.uiSound('click');
      h.onLoadoutSelect(card.dataset.module as ModuleType);
    });

    // Join input.
    const input = this.els['join-input'] as HTMLInputElement;
    input.addEventListener('input', () => {
      const clean = sanitizeFriendCode(input.value);
      if (input.value !== clean) input.value = clean;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submitJoin();
      e.stopPropagation();
    });

    // Settings inputs.
    const vol = this.els['set-volume'] as HTMLInputElement;
    const shake = this.els['set-shake'] as HTMLInputElement;
    const qual = this.els['set-quality'] as HTMLSelectElement;
    const flash = this.els['set-flash'] as HTMLInputElement;
    const push = () => {
      this.settings.volume = parseFloat(vol.value);
      this.settings.shake = parseFloat(shake.value);
      this.settings.quality = qual.value as Settings['quality'];
      this.settings.reducedFlashes = flash.checked;
      h.onSettingsChanged();
    };
    vol.addEventListener('input', push);
    shake.addEventListener('input', push);
    qual.addEventListener('change', push);
    flash.addEventListener('change', push);
  }

  private submitJoin(): void {
    const input = this.els['join-input'] as HTMLInputElement;
    const code = sanitizeFriendCode(input.value);
    if (code.length !== 6) {
      this.setJoinStatus('Codes are 6 characters (letters and 2–9).', 'error');
      return;
    }
    this.handlers.onJoinConnect(code);
  }

  // -------------------------------------------------------------------------
  // Public API used by the Game
  // -------------------------------------------------------------------------

  show(name: ScreenName): void {
    if (this.current === name) return;
    for (const [n, el] of this.screens) el.classList.toggle('active', n === name);
    this.current = name;
    if (name === 'join') {
      const input = this.els['join-input'] as HTMLInputElement;
      input.value = '';
      this.setJoinStatus('', '');
      setTimeout(() => input.focus(), 60);
    }
    if (name === 'loadout') this.startPreviews();
    else this.stopPreviews();
  }

  get currentScreen(): ScreenName {
    return this.current;
  }

  setLayout(scale: number, ox: number, oy: number): void {
    this.root.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
  }

  setLoading(frac: number, label: string): void {
    (this.els['load-fill'] as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
    this.els['load-label'].textContent = label;
  }

  setHostCode(code: string | null): void {
    this.els['host-code'].textContent = code ?? '······';
    this.els['host-status'].innerHTML = code
      ? 'Waiting for an opponent<span class="dots"></span>'
      : 'Reserving a code<span class="dots"></span>';
  }

  setJoinStatus(text: string, kind: '' | 'error' | 'good'): void {
    const el = this.els['join-status'];
    el.textContent = text;
    el.className = `status ${kind}`;
  }

  setJoinBusy(busy: boolean): void {
    (this.els['btn-join-go'] as HTMLButtonElement).disabled = busy;
    (this.els['join-input'] as HTMLInputElement).disabled = busy;
  }

  updateLobby(state: LobbyUiState): void {
    this.lobby = state;
    this.els['loadout-context'].textContent = state.contextLine;
    // Card selection highlight.
    for (const card of Array.from(this.root.querySelectorAll<HTMLElement>('[data-module]'))) {
      card.classList.toggle('selected', card.dataset.module === state.myModule);
    }
    const readyRow = this.els['lobby-ready'];
    readyRow.style.display = state.online ? 'flex' : 'none';
    const btn = this.els['btn-loadout-ready'] as HTMLButtonElement;
    const back = this.els['btn-loadout-back'] as HTMLButtonElement;
    back.textContent = state.online ? 'Leave Match' : 'Back';
    if (!state.online) {
      btn.textContent = state.rematch ? 'Start Rematch' : 'Start Match';
      btn.disabled = state.myModule === null;
      return;
    }
    const youTag = this.els['ready-you'];
    const themTag = this.els['ready-them'];
    youTag.textContent = state.myReady ? 'READY' : state.myModule ? 'PICKED' : 'CHOOSING';
    youTag.className = `tag ${state.myReady ? 'ok' : ''}`;
    themTag.textContent = state.oppReady ? 'READY' : state.oppModule ? 'PICKED' : 'CHOOSING';
    themTag.className = `tag ${state.oppReady ? 'ok' : ''}`;
    if (state.isHost && state.myReady && state.oppReady) {
      btn.textContent = 'Launch Match';
      btn.disabled = false;
    } else if (state.myReady) {
      btn.textContent = state.isHost ? 'Waiting for opponent…' : 'Waiting for host…';
      btn.disabled = true;
    } else {
      btn.textContent = 'Ready';
      btn.disabled = state.myModule === null;
    }
  }

  setResultStatus(text: string): void {
    this.els['result-status'].textContent = text;
  }

  setResultButtons(canRematch: boolean, canChange: boolean): void {
    (this.els['btn-rematch'] as HTMLButtonElement).disabled = !canRematch;
    (this.els['btn-changeloadout'] as HTMLButtonElement).disabled = !canChange;
  }

  showError(title: string, message: string): void {
    this.els['error-title'].innerHTML = title;
    this.els['error-msg'].textContent = message;
    this.show('error');
  }

  openPause(online: boolean): void {
    this.els['pause-note'].textContent = online
      ? 'The duel continues while this menu is open.'
      : 'The duel is frozen.';
    (this.els['btn-pause-quit'] as HTMLButtonElement).textContent = online ? 'Forfeit & Leave' : 'Quit to Menu';
    this.els['modal-pause'].classList.add('active');
  }

  closePause(): void {
    this.els['modal-pause'].classList.remove('active');
  }

  get pauseOpen(): boolean {
    return this.els['modal-pause'].classList.contains('active');
  }

  openSettings(): void {
    this.syncSettings();
    this.els['modal-settings'].classList.add('active');
  }

  closeSettings(): void {
    this.els['modal-settings'].classList.remove('active');
  }

  get settingsOpen(): boolean {
    return this.els['modal-settings'].classList.contains('active');
  }

  syncSettings(): void {
    (this.els['set-volume'] as HTMLInputElement).value = String(this.settings.volume);
    (this.els['set-shake'] as HTMLInputElement).value = String(this.settings.shake);
    (this.els['set-quality'] as HTMLSelectElement).value = this.settings.quality;
    (this.els['set-flash'] as HTMLInputElement).checked = this.settings.reducedFlashes;
  }

  toast(msg: string): void {
    const t = this.els['toast'];
    t.textContent = msg;
    t.classList.add('show');
    window.setTimeout(() => t.classList.remove('show'), 1600);
  }

  // -------------------------------------------------------------------------
  // Loadout preview animations (tiny self-contained canvas loops)
  // -------------------------------------------------------------------------

  private startPreviews(): void {
    if (this.previewRunning) return;
    this.previewRunning = true;
    const loop = () => {
      if (!this.previewRunning) return;
      this.previewTimer += 1 / 60;
      const cards = Array.from(this.root.querySelectorAll<HTMLElement>('[data-module]'));
      for (const card of cards) {
        const canvas = card.querySelector('canvas');
        if (canvas) this.drawPreview(canvas, card.dataset.module as ModuleType, this.previewTimer);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private stopPreviews(): void {
    this.previewRunning = false;
  }

  private drawPreview(canvas: HTMLCanvasElement, module: ModuleType, t: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    // Little fighter dot.
    ctx.fillStyle = '#3fd4ff';
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(-7, -6);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-7, 6);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    if (module === 'aegis') {
      const p = (Math.sin(t * 3) + 1) / 2;
      ctx.strokeStyle = `rgba(90,210,255,${0.5 + p * 0.4})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, 20 + p * 3, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 3; i++) {
        const a = t * 2 + (i * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.arc(0, 0, 24, a, a + 0.8);
        ctx.stroke();
      }
    } else if (module === 'repulsor') {
      for (let i = 0; i < 3; i++) {
        const f = ((t * 0.9 + i / 3) % 1);
        ctx.strokeStyle = `rgba(177,140,255,${(1 - f) * 0.8})`;
        ctx.lineWidth = 3 * (1 - f) + 0.5;
        ctx.beginPath();
        ctx.arc(0, 0, 6 + f * 34, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else {
      for (let i = 0; i < 3; i++) {
        const f = ((t * 1.4 + i * 0.18) % 1);
        const x = -20 + f * 95;
        ctx.fillStyle = `rgba(255,209,102,${1 - f * 0.6})`;
        ctx.beginPath();
        ctx.arc(x, Math.sin(f * 20 + i) * 2, 3.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255,240,180,${(1 - f) * 0.5})`;
        ctx.fillRect(x - 14, -1, 12, 2);
      }
    }
    ctx.restore();
    void this.lobby;
  }
}
