// Game orchestrator: owns the state machine (boot → menu → lobby → match →
// result), the fixed-timestep loop, FX/audio routing of sim events, solo AI,
// and the host/client online sessions built on NetworkManager.

import { AIController } from '../ai/AIController';
import { ClientReplica } from '../network/ClientReplica';
import { NetworkManager } from '../network/NetworkManager';
import type { NetErrorInfo } from '../network/NetworkManager';
import type { NetMsg, SnapshotMsg } from '../network/protocol';
import { AssetFactory } from '../render/AssetFactory';
import { Renderer } from '../render/Renderer';
import type { DebugInfo } from '../render/Renderer';
import { AudioSystem } from '../systems/AudioSystem';
import { InputSystem } from '../systems/InputSystem';
import { ParticleSystem } from '../systems/ParticleSystem';
import { ScreenEffects } from '../systems/ScreenEffects';
import { UIManager } from '../ui/UIManager';
import { createArenaDef } from './arena';
import {
  COLORS, MAX_CATCHUP_STEPS, MODULES, NET, PARTICLE_CAPS, ROUND, STEP, WEAPON,
  teamColor,
} from './constants';
import { loadSettings, saveSettings } from './settings';
import type { Settings } from './settings';
import { Simulation } from './Simulation';
import type {
  Difficulty, InputState, ModuleType, Presentation, SimEvent, Team, WorldView,
} from './types';
import { emptyInput } from './types';
import { clamp } from '../utils/math';

type AppState = 'boot' | 'menu' | 'howto' | 'solo' | 'host' | 'join' | 'lobby' | 'match' | 'result' | 'error';
type Mode = 'idle' | 'solo' | 'hostnet' | 'clientnet';

const MENU_SCREENS: AppState[] = ['menu', 'howto', 'solo', 'host', 'join', 'lobby', 'error'];

export class Game {
  private settings: Settings;
  private audio: AudioSystem;
  private input = new InputSystem();
  private particles = new ParticleSystem();
  private effects: ScreenEffects;
  private assets: AssetFactory;
  private renderer: Renderer;
  private ui!: UIManager;
  private net: NetworkManager | null = null;

  private state: AppState = 'boot';
  private mode: Mode = 'idle';
  private sim: Simulation | null = null;
  private replica: ClientReplica | null = null;
  private ai: AIController | null = null;

  // Match flow
  private scores: [number, number] = [0, 0];
  private roundNum = 1;
  private matchWinner: Team | null = null;
  private flowTimer = 0;
  private pres: Presentation | null = null;
  private soloPaused = false;
  private difficulty: Difficulty = 'standard';
  private myModule: ModuleType | null = null;
  private aiModule: ModuleType = 'repulsor';

  // Online lobby state (host authoritative)
  private lobbyPhase: 'loadout' | 'rematch' = 'loadout';
  private hostLoadout: ModuleType | null = null;
  private clientLoadout: ModuleType | null = null;
  private hostReady = false;
  private clientReady = false;

  // Client-side networking
  private inputSeq = 0;
  private edgeDash = false;
  private edgeModule = false;
  private lastSentInput: InputState = emptyInput();
  // Host-side remote input
  private remoteInput: InputState = emptyInput();
  private remoteDashPending = false;
  private remoteModulePending = false;
  private remoteSeq = 0;

  // Loop
  private acc = 0;
  private lastT = 0;
  private rafId = 0;
  private hiddenTimer: number | null = null;
  private fps = 60;
  private lastCount = 99;
  private prevPhase = -1;
  private hintT = 0;
  private seenHints = false;
  private debugOn = 0; // 0 off, 1 overlay, 2 overlay+shapes
  private laserHums = new Map<number, () => void>();

  constructor(private canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.settings = loadSettings();
    this.audio = new AudioSystem(this.settings.volume);
    this.effects = new ScreenEffects(this.settings);
    const arena = createArenaDef();
    this.assets = new AssetFactory(arena);
    this.renderer = new Renderer(canvas, this.assets, this.particles, this.effects, this.settings, arena);
    this.ui = new UIManager(uiRoot, this.settings, {
      onSolo: (d) => this.chooseSolo(d),
      onHost: () => this.startHosting(),
      onJoinConnect: (code) => this.startJoining(code),
      onLoadoutSelect: (m) => this.selectModule(m),
      onLoadoutReady: () => this.loadoutReady(),
      onBack: () => this.backToMenu(),
      onRematch: () => this.requestRematch(),
      onChangeLoadout: () => this.changeLoadout(),
      onMainMenu: () => this.leaveToMenu(),
      onResume: () => this.togglePause(false),
      onQuit: () => this.quitFromPause(),
      onSettingsChanged: () => this.applySettings(),
      onCopyCode: () => this.copyCode(),
      onToggleFullscreen: () => this.toggleFullscreen(),
      uiSound: (k) => this.audio.play(k === 'click' ? 'uiClick' : 'uiHover'),
    });
    this.seenHints = localStorage.getItem('dashduel:hints') === '1';

    this.input.attach(canvas, (sx, sy) => this.renderer.toLogical(sx, sy));
    this.input.onAnyGesture = () => this.audio.unlock();
    this.input.onEscape = () => this.onEscape();
    this.input.onDebugToggle = () => {
      this.debugOn = (this.debugOn + 1) % 3;
    };

    window.addEventListener('resize', () => this.layout());
    document.addEventListener('fullscreenchange', () => this.layout());
    document.addEventListener('visibilitychange', () => this.onVisibility());
    this.layout();
    this.applySettings();
  }

  // ==========================================================================
  // Boot
  // ==========================================================================

  async boot(): Promise<void> {
    this.ui.show('loading');
    const started = performance.now();
    await this.assets.init((f, label) => this.ui.setLoading(f, label));
    const remain = Math.max(0, 650 - (performance.now() - started));
    await new Promise((r) => setTimeout(r, remain));
    this.toMenu();
    this.lastT = performance.now() / 1000;
    const frame = (tMs: number) => {
      this.rafId = requestAnimationFrame(frame);
      const now = tMs / 1000;
      const dt = clamp(now - this.lastT, 0, 0.1);
      this.lastT = now;
      this.stepFrame(dt);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  private layout(): void {
    const { scale, ox, oy } = this.renderer.resize();
    this.ui.setLayout(scale, ox, oy);
  }

  private applySettings(): void {
    saveSettings(this.settings);
    this.audio.setVolume(this.settings.volume);
    this.particles.setCap(PARTICLE_CAPS[this.settings.quality]);
    this.layout();
  }

  // ==========================================================================
  // State transitions
  // ==========================================================================

  private setState(s: AppState): void {
    this.state = s;
    this.input.capture = s === 'match';
    this.canvas.style.cursor = s === 'match' ? 'none' : 'crosshair';
    // If an online match starts while the tab is hidden (e.g. a rematch
    // auto-launch), rAF is not running — keep the sim ticking from a timer.
    if (s === 'match' && document.hidden && this.mode !== 'solo') this.startHiddenTimer();
  }

  private toMenu(): void {
    this.stopMatchArtifacts();
    this.teardownNet();
    this.mode = 'idle';
    this.sim = null;
    this.replica = null;
    this.ai = null;
    this.pres = null;
    this.soloPaused = false;
    this.ui.closePause();
    this.setState('menu');
    this.ui.show('menu');
  }

  private backToMenu(): void {
    // Cancel from host/join/lobby screens.
    this.teardownNet();
    this.setState('menu');
    this.ui.show('menu');
  }

  private leaveToMenu(): void {
    if (this.net?.connected) this.net.send({ t: 'leave' });
    this.toMenu();
  }

  private stopMatchArtifacts(): void {
    for (const stop of this.laserHums.values()) stop();
    this.laserHums.clear();
    this.particles.clear();
    this.effects.reset();
    this.stopHiddenTimer();
  }

  private teardownNet(): void {
    if (this.net) {
      this.net.destroy();
      this.net = null;
    }
  }

  private onEscape(): void {
    if (this.ui.settingsOpen) {
      this.ui.closeSettings();
      return;
    }
    switch (this.state) {
      case 'match':
        this.togglePause(!this.ui.pauseOpen);
        break;
      case 'howto':
      case 'solo':
      case 'join':
        this.setState('menu');
        this.ui.show('menu');
        break;
      case 'host':
        this.backToMenu();
        break;
      default:
        break;
    }
  }

  private togglePause(open: boolean): void {
    if (this.state !== 'match') return;
    if (open) {
      this.ui.openPause(this.mode !== 'solo');
      if (this.mode === 'solo') this.soloPaused = true;
    } else {
      this.ui.closePause();
      this.ui.closeSettings();
      this.soloPaused = false;
    }
  }

  private quitFromPause(): void {
    this.ui.closePause();
    if (this.mode === 'solo') {
      this.toMenu();
    } else {
      this.leaveToMenu();
    }
  }

  private toggleFullscreen(): void {
    const app = document.getElementById('app');
    if (!app) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void app.requestFullscreen().catch(() => this.ui.toast('Fullscreen was blocked by the browser'));
    }
  }

  private copyCode(): void {
    const code = this.net?.code;
    if (!code) return;
    const done = () => this.ui.toast(`Code ${code} copied!`);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done, () => this.fallbackCopy(code, done));
    } else {
      this.fallbackCopy(code, done);
    }
  }

  private fallbackCopy(text: string, done: () => void): void {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch {
      this.ui.toast('Copy failed — note the code down manually');
    }
    ta.remove();
  }

  private onVisibility(): void {
    if (document.hidden) {
      this.audio.resume();
      if (this.state === 'match') {
        if (this.mode === 'solo') {
          this.togglePause(true);
        } else {
          // Keep the online simulation moving while the tab is hidden
          // (rAF stops firing, so drive fixed steps from a timer).
          this.startHiddenTimer();
        }
      }
    } else {
      this.stopHiddenTimer();
      this.audio.resume();
      this.lastT = performance.now() / 1000;
    }
  }

  private startHiddenTimer(): void {
    if (this.hiddenTimer !== null) return;
    this.hiddenTimer = window.setInterval(() => {
      if (this.state === 'match' || this.state === 'result') this.stepFrame(0.05, true);
    }, 50);
  }

  private stopHiddenTimer(): void {
    if (this.hiddenTimer !== null) {
      clearInterval(this.hiddenTimer);
      this.hiddenTimer = null;
    }
  }

  // ==========================================================================
  // Solo flow
  // ==========================================================================

  private chooseSolo(diff: Difficulty): void {
    this.difficulty = diff;
    this.mode = 'solo';
    this.setState('lobby');
    this.ui.show('loadout');
    this.refreshLobbyUi(false);
  }

  private selectModule(m: ModuleType): void {
    this.myModule = m;
    if (this.mode === 'hostnet') {
      this.hostLoadout = m;
      this.broadcastLobby();
    } else if (this.mode === 'clientnet') {
      this.net?.send({ t: 'loadout', module: m });
    }
    this.refreshLobbyUi(this.lobbyPhase === 'rematch');
  }

  private loadoutReady(): void {
    if (this.mode === 'solo') {
      if (!this.myModule) return;
      this.startSoloMatch();
      return;
    }
    if (this.mode === 'hostnet') {
      if (!this.hostReady) {
        if (!this.hostLoadout) return;
        this.hostReady = true;
        this.broadcastLobby();
        this.refreshLobbyUi(this.lobbyPhase === 'rematch');
        this.maybeLaunchOnline(this.lobbyPhase === 'loadout');
      } else if (this.hostReady && this.clientReady) {
        this.launchOnlineMatch();
      }
      return;
    }
    // Client: toggle ready.
    if (!this.myModule) return;
    this.net?.send({ t: 'ready', ready: true });
    this.clientReady = true;
    this.refreshLobbyUi(this.lobbyPhase === 'rematch');
  }

  private startSoloMatch(): void {
    if (!this.myModule) return;
    this.ai = new AIController(1, this.difficulty);
    this.aiModule = this.ai.pickModule();
    this.sim = new Simulation((Math.random() * 0xffffffff) >>> 0);
    this.sim.setLoadouts(this.myModule, this.aiModule);
    this.scores = [0, 0];
    this.roundNum = 1;
    this.matchWinner = null;
    this.setState('match');
    this.ui.show('none');
    this.startRound(1);
  }

  // ==========================================================================
  // Online flow
  // ==========================================================================

  private makeNet(): NetworkManager {
    const net = new NetworkManager();
    net.onError = (e) => this.onNetError(e);
    net.onClosed = () => this.onNetClosed();
    net.onMessage = (m) => this.onNetMessage(m);
    return net;
  }

  private startHosting(): void {
    this.teardownNet();
    this.mode = 'hostnet';
    this.net = this.makeNet();
    this.net.onCode = (code) => {
      this.ui.setHostCode(code);
    };
    this.net.onConnected = () => this.onPeerJoined();
    this.setState('host');
    this.ui.show('host');
    this.ui.setHostCode(null);
    this.net.startHost();
  }

  private startJoining(code: string): void {
    this.teardownNet();
    this.mode = 'clientnet';
    this.setState('join');
    this.net = this.makeNet();
    this.net.onConnected = () => this.onPeerJoined();
    this.ui.setJoinStatus('Connecting…', '');
    this.ui.setJoinBusy(true);
    this.net.join(code);
  }

  private onPeerJoined(): void {
    this.audio.play('connect');
    this.ui.setJoinBusy(false);
    this.lobbyPhase = 'loadout';
    this.hostReady = false;
    this.clientReady = false;
    this.hostLoadout = null;
    this.clientLoadout = null;
    this.myModule = null;
    this.setState('lobby');
    this.ui.show('loadout');
    this.ui.toast(this.mode === 'hostnet' ? 'Challenger connected!' : 'Connected to host!');
    if (this.mode === 'hostnet') this.broadcastLobby();
    this.refreshLobbyUi(false);
  }

  private onNetError(e: NetErrorInfo): void {
    this.audio.play('error');
    if (this.state === 'join') {
      this.ui.setJoinStatus(e.message, 'error');
      this.ui.setJoinBusy(false);
      this.net?.destroy();
      return;
    }
    if (this.state === 'host' && this.ui.currentScreen === 'host') {
      this.ui.showError('Hosting <span class="accent">Failed</span>', e.message);
      this.teardownNet();
      this.setState('error');
      return;
    }
    this.connectionLost(e.message);
  }

  private onNetClosed(): void {
    if (this.state === 'match' || this.state === 'result' || this.state === 'lobby') {
      this.connectionLost('The connection to the other player was lost. No winner is recorded.');
    }
  }

  private connectionLost(message: string): void {
    this.stopMatchArtifacts();
    this.teardownNet();
    this.mode = 'idle';
    this.sim = null;
    this.replica = null;
    this.pres = null;
    this.ui.closePause();
    this.audio.play('error');
    this.setState('error');
    this.ui.showError('Connection <span class="accent">Lost</span>', message);
  }

  private broadcastLobby(): void {
    if (this.mode !== 'hostnet') return;
    this.net?.send({
      t: 'lobby',
      phase: this.lobbyPhase,
      hostLoadout: this.hostLoadout,
      clientLoadout: this.clientLoadout,
      hostReady: this.hostReady,
      clientReady: this.clientReady,
    });
  }

  private refreshLobbyUi(rematch: boolean): void {
    const online = this.mode !== 'solo';
    const isHost = this.mode === 'hostnet';
    const context =
      this.mode === 'solo'
        ? `SOLO BATTLE · VS AI (${this.difficulty.toUpperCase()}) · BEST OF ${ROUND.bestOf}`
        : `ONLINE · CODE ${this.net?.code ?? '—'} · YOU FLY ${isHost ? 'BLUE' : 'RED'}`;
    this.ui.updateLobby({
      online,
      isHost,
      rematch,
      myModule: this.myModule,
      oppModule: online ? (isHost ? this.clientLoadout : this.hostLoadout) : null,
      myReady: isHost ? this.hostReady : this.clientReady,
      oppReady: isHost ? this.clientReady : this.hostReady,
      contextLine: context,
    });
    if (this.state === 'result') {
      this.updateResultStatus();
    }
  }

  private maybeLaunchOnline(requireManualLaunch: boolean): void {
    if (this.mode !== 'hostnet') return;
    if (!this.hostReady || !this.clientReady || !this.hostLoadout || !this.clientLoadout) return;
    // Initial lobby: host presses Launch. Rematch: auto-start once both accept.
    if (!requireManualLaunch) this.launchOnlineMatch();
  }

  private launchOnlineMatch(): void {
    if (this.mode !== 'hostnet' || !this.hostLoadout || !this.clientLoadout) return;
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.net?.send({ t: 'startMatch', seed, hostLoadout: this.hostLoadout, clientLoadout: this.clientLoadout });
    this.sim = new Simulation(seed);
    this.sim.setLoadouts(this.hostLoadout, this.clientLoadout);
    this.myModule = this.hostLoadout;
    this.scores = [0, 0];
    this.roundNum = 1;
    this.matchWinner = null;
    this.remoteInput = emptyInput();
    this.remoteDashPending = false;
    this.remoteModulePending = false;
    this.remoteSeq = 0;
    this.setState('match');
    this.ui.show('none');
    this.startRound(1);
  }

  private clientStartMatch(seed: number, hostLoadout: ModuleType, clientLoadout: ModuleType): void {
    this.replica = new ClientReplica();
    this.replica.players[0].module = hostLoadout;
    this.replica.players[1].module = clientLoadout;
    this.myModule = clientLoadout;
    this.scores = [0, 0];
    this.roundNum = 1;
    this.matchWinner = null;
    this.inputSeq = 0;
    this.edgeDash = false;
    this.edgeModule = false;
    this.setState('match');
    this.ui.show('none');
    this.beginRoundPresentation(1);
    this.replica.resetRound(1, false, [0, 0]);
    this.renderer.resetRound();
    this.renderer.hud.resetRound();
    void seed;
  }

  // ==========================================================================
  // Round / match flow (solo + host authoritative)
  // ==========================================================================

  private startRound(n: number): void {
    if (!this.sim) return;
    this.roundNum = n;
    const swap = n % 2 === 0;
    this.sim.resetRound(n, swap);
    this.particles.clear();
    this.renderer.resetRound();
    this.renderer.hud.resetRound();
    for (const stop of this.laserHums.values()) stop();
    this.laserHums.clear();
    this.flowTimer = 0;
    this.prevPhase = -1;
    this.lastCount = 99;
    this.beginRoundPresentation(n);
    if (this.mode === 'hostnet') {
      this.net?.send({ t: 'roundStart', round: n, swap, scores: [this.scores[0], this.scores[1]] });
    }
  }

  private beginRoundPresentation(n: number): void {
    this.pres = {
      kind: 'roundIntro',
      t: 0,
      data: n,
      text: `ROUND ${n}`,
      sub: this.scores[0] + this.scores[1] > 0 ? `${this.scores[0]} – ${this.scores[1]}` : 'FIRST TO 3',
    };
  }

  private onRoundEnded(winner: -1 | Team): void {
    const local = this.localTeam;
    if (winner >= 0) {
      this.scores[winner as Team]++;
      this.audio.play(winner === local ? 'roundWin' : 'roundLose');
      this.pres = {
        kind: 'roundEnd',
        t: 0,
        data: winner,
        text: winner === local ? 'ROUND WON!' : 'ROUND LOST',
        sub: `${this.scores[0]} – ${this.scores[1]}`,
      };
    } else {
      this.pres = { kind: 'doubleKo', t: 0, data: 0, text: 'DOUBLE K.O.', sub: 'ROUND REPLAYED' };
    }
    this.flowTimer = ROUND.resultTime;
    if (this.mode === 'hostnet') {
      this.net?.send({ t: 'roundEnd', winner, scores: [this.scores[0], this.scores[1]] });
    }
  }

  private advanceFlow(): void {
    // Called when the round-result presentation finishes (solo/host).
    const winIdx = this.scores[0] >= ROUND.winsNeeded ? 0 : this.scores[1] >= ROUND.winsNeeded ? 1 : -1;
    if (winIdx >= 0) {
      this.finishMatch(winIdx as Team);
    } else {
      const next = this.sim && this.sim.winner === -1 ? this.roundNum : this.roundNum + 1;
      this.startRound(next);
    }
  }

  private finishMatch(winner: Team): void {
    this.matchWinner = winner;
    const local = this.localTeam;
    this.audio.play(winner === local ? 'matchWin' : 'matchLose');
    this.pres = {
      kind: 'matchEnd',
      t: 0,
      data: winner,
      text: winner === local ? 'VICTORY' : 'DEFEAT',
      sub: `${this.names[winner]} WINS ${this.scores[0]} – ${this.scores[1]}`,
    };
    this.setState('result');
    this.ui.show('result');
    if (this.mode === 'hostnet') {
      this.net?.send({ t: 'matchEnd', winner, scores: [this.scores[0], this.scores[1]] });
      this.lobbyPhase = 'rematch';
      this.hostReady = false;
      this.clientReady = false;
      this.broadcastLobby();
    }
    if (this.mode === 'clientnet') {
      this.clientReady = false;
      this.hostReady = false;
      this.lobbyPhase = 'rematch';
    }
    this.updateResultStatus();
    this.ui.setResultButtons(true, true);
  }

  private updateResultStatus(): void {
    if (this.mode === 'solo') {
      this.ui.setResultStatus('');
      return;
    }
    const myReady = this.mode === 'hostnet' ? this.hostReady : this.clientReady;
    const oppReady = this.mode === 'hostnet' ? this.clientReady : this.hostReady;
    let text = '';
    if (myReady && oppReady) text = 'Both ready — launching…';
    else if (myReady) text = 'Waiting for your opponent to accept…';
    else if (oppReady) text = 'Your opponent wants a rematch!';
    this.ui.setResultStatus(text);
    this.ui.setResultButtons(!myReady, !myReady);
  }

  private requestRematch(): void {
    if (this.state !== 'result') return;
    if (this.mode === 'solo') {
      this.startSoloMatch();
      return;
    }
    if (this.mode === 'hostnet') {
      this.hostReady = true;
      this.hostLoadout = this.myModule;
      this.broadcastLobby();
      this.updateResultStatus();
      this.maybeLaunchOnline(false);
    } else {
      this.clientReady = true;
      if (this.myModule) this.net?.send({ t: 'loadout', module: this.myModule });
      this.net?.send({ t: 'ready', ready: true });
      this.updateResultStatus();
    }
  }

  private changeLoadout(): void {
    if (this.state !== 'result') return;
    if (this.mode === 'solo') {
      this.setState('lobby');
      this.ui.show('loadout');
      this.refreshLobbyUi(true);
      return;
    }
    // Online: back to the shared lobby (loadout) screen, unready.
    if (this.mode === 'hostnet') {
      this.hostReady = false;
      this.broadcastLobby();
    } else {
      this.clientReady = false;
      this.net?.send({ t: 'ready', ready: false });
    }
    this.setState('lobby');
    this.ui.show('loadout');
    this.refreshLobbyUi(true);
  }

  // ==========================================================================
  // Network messages
  // ==========================================================================

  private onNetMessage(m: NetMsg): void {
    switch (m.t) {
      case 'lobby': {
        if (this.mode !== 'clientnet') return;
        this.lobbyPhase = m.phase;
        this.hostLoadout = m.hostLoadout;
        this.clientLoadout = m.clientLoadout;
        this.hostReady = m.hostReady;
        this.clientReady = m.clientReady;
        this.refreshLobbyUi(m.phase === 'rematch');
        if (this.state === 'result') this.updateResultStatus();
        break;
      }
      case 'loadout': {
        if (this.mode !== 'hostnet') return;
        this.clientLoadout = m.module;
        this.broadcastLobby();
        this.refreshLobbyUi(this.lobbyPhase === 'rematch');
        break;
      }
      case 'ready': {
        if (this.mode !== 'hostnet') return;
        this.clientReady = m.ready;
        this.broadcastLobby();
        this.refreshLobbyUi(this.lobbyPhase === 'rematch');
        if (this.state === 'result') this.updateResultStatus();
        this.maybeLaunchOnline(this.lobbyPhase === 'loadout' && this.state === 'lobby');
        break;
      }
      case 'startMatch': {
        if (this.mode !== 'clientnet') return;
        this.clientStartMatch(m.seed, m.hostLoadout, m.clientLoadout);
        break;
      }
      case 'roundStart': {
        if (this.mode !== 'clientnet' || !this.replica) return;
        this.roundNum = m.round;
        this.scores = [m.scores[0], m.scores[1]];
        this.replica.resetRound(m.round, m.swap, [m.scores[0], m.scores[1]]);
        this.particles.clear();
        this.renderer.resetRound();
        this.renderer.hud.resetRound();
        for (const stop of this.laserHums.values()) stop();
        this.laserHums.clear();
        this.prevPhase = -1;
        this.lastCount = 99;
        this.beginRoundPresentation(m.round);
        if (this.state === 'result') {
          this.setState('match');
          this.ui.show('none');
        }
        break;
      }
      case 'snapshot': {
        if (this.mode !== 'clientnet' || !this.replica) return;
        this.replica.applySnapshot(m as SnapshotMsg);
        break;
      }
      case 'ev': {
        if (this.mode !== 'clientnet') return;
        this.replica?.applyEvent(m.e);
        this.handleSimEvent(m.e, true);
        break;
      }
      case 'input': {
        if (this.mode !== 'hostnet') return;
        if (m.seq <= this.remoteSeq) return; // stale/duplicate
        this.remoteSeq = m.seq;
        this.remoteInput.mx = m.mx;
        this.remoteInput.my = m.my;
        this.remoteInput.aim = m.aim;
        this.remoteInput.fire = (m.b & 1) !== 0;
        if ((m.b & 2) !== 0) this.remoteDashPending = true;
        if ((m.b & 4) !== 0) this.remoteModulePending = true;
        break;
      }
      case 'roundEnd': {
        if (this.mode !== 'clientnet') return;
        this.scores = [m.scores[0], m.scores[1]];
        const winner = m.winner as -1 | Team;
        const local = this.localTeam;
        if (winner >= 0) {
          this.audio.play(winner === local ? 'roundWin' : 'roundLose');
          this.pres = {
            kind: 'roundEnd', t: 0, data: winner,
            text: winner === local ? 'ROUND WON!' : 'ROUND LOST',
            sub: `${this.scores[0]} – ${this.scores[1]}`,
          };
        } else {
          this.pres = { kind: 'doubleKo', t: 0, data: 0, text: 'DOUBLE K.O.', sub: 'ROUND REPLAYED' };
        }
        break;
      }
      case 'matchEnd': {
        if (this.mode !== 'clientnet') return;
        this.scores = [m.scores[0], m.scores[1]];
        this.finishMatch(m.winner as Team);
        break;
      }
      case 'returnToLobby': {
        this.setState('lobby');
        this.ui.show('loadout');
        this.refreshLobbyUi(true);
        break;
      }
      case 'leave': {
        this.connectionLost('Your opponent left the match.');
        break;
      }
      default:
        break;
    }
  }

  // ==========================================================================
  // Fixed-step ticks per mode
  // ==========================================================================

  private get localTeam(): Team {
    return this.mode === 'clientnet' ? 1 : 0;
  }

  private get names(): [string, string] {
    if (this.mode === 'solo') return ['YOU', `AI · ${this.difficulty.toUpperCase()}`];
    if (this.mode === 'hostnet') return ['YOU', 'CHALLENGER'];
    if (this.mode === 'clientnet') return ['HOST', 'YOU'];
    return ['BLUE', 'RED'];
  }

  private fixedTick(): void {
    if (this.mode === 'solo' || this.mode === 'hostnet') {
      const sim = this.sim;
      if (!sim) return;
      const local = sim.players[0];
      const localInput = this.input.sample(local.x, local.y);
      let remote: InputState;
      if (this.mode === 'solo') {
        remote = this.ai ? this.ai.update(sim, STEP) : emptyInput();
      } else {
        remote = {
          mx: this.remoteInput.mx,
          my: this.remoteInput.my,
          aim: this.remoteInput.aim,
          fire: this.remoteInput.fire,
          dash: this.remoteDashPending,
          module: this.remoteModulePending,
        };
        this.remoteDashPending = false;
        this.remoteModulePending = false;
      }
      sim.step([localInput, remote]);
      for (const e of sim.drainEvents()) {
        this.handleSimEvent(e, false);
        if (this.mode === 'hostnet') this.net?.send({ t: 'ev', e });
        if (e.k === 'roundEnd') this.onRoundEnded(e.winner);
      }
      if (this.mode === 'hostnet' && sim.tick % NET.snapshotEvery === 0) {
        this.net?.send(this.buildSnapshot(sim));
      }
      return;
    }

    if (this.mode === 'clientnet') {
      const rep = this.replica;
      if (!rep) return;
      const me = rep.players[1];
      const inp = this.input.sample(me.x + rep.errX, me.y + rep.errY);
      if (inp.dash) this.edgeDash = true;
      if (inp.module) this.edgeModule = true;

      // Optimistic local fire feedback (authoritative shot comes from host).
      if (inp.fire && me.fireCd <= 0 && rep.phase === 1 && me.alive) {
        const oc = me.voltShots > 0;
        me.fireCd = oc ? MODULES.volt.interval : WEAPON.interval;
        this.renderer.muzzle(1);
        this.audio.play(oc ? 'shotOc' : 'shot', { x: me.x });
      }
      // Optimistic module activation sound.
      if (inp.module && me.moduleCd <= 0 && rep.phase === 1 && me.alive) {
        me.moduleCd = MODULES[me.module].cooldown;
        this.audio.play(me.module === 'aegis' ? 'shieldUp' : me.module === 'volt' ? 'volt' : 'repulsor', { x: me.x });
      }

      rep.predictTick(
        this.inputSeq + 1,
        inp,
        (p) => this.localDashFx(p.x, p.y, p.dashDx, p.dashDy),
        (p, pad, surge) => this.localPadFx(pad.x, pad.y, pad.dx, pad.dy, surge, p.team),
      );

      if ((rep.players[1].padCd, true)) {
        // Send input packets at half tick rate with accumulated edges.
        if ((this.inputTickCounter = (this.inputTickCounter + 1) % NET.inputEvery) === 0) {
          this.inputSeq++;
          let b = 0;
          if (inp.fire) b |= 1;
          if (this.edgeDash) b |= 2;
          if (this.edgeModule) b |= 4;
          this.edgeDash = false;
          this.edgeModule = false;
          this.lastSentInput = inp;
          this.net?.send({ t: 'input', seq: this.inputSeq, mx: inp.mx, my: inp.my, aim: inp.aim, b });
        }
      }
    }
  }

  private inputTickCounter = 0;

  private buildSnapshot(sim: Simulation): SnapshotMsg {
    const p = sim.players.map((pl) => ({
      x: pl.x, y: pl.y, vx: pl.vx, vy: pl.vy, kbx: pl.kbx, kby: pl.kby,
      aim: pl.aim, hp: pl.hp, alive: pl.alive,
      fireCd: pl.fireCd,
      dashCd: pl.dashCd, dashT: pl.dashT, dashDx: pl.dashDx, dashDy: pl.dashDy,
      invulnT: pl.invulnT,
      moduleCd: pl.moduleCd,
      shieldHp: pl.shieldHp, shieldT: pl.shieldT,
      voltShots: pl.voltShots, voltT: pl.voltT,
      padCd: pl.padCd,
    })) as SnapshotMsg['p'];
    return {
      t: 'snapshot',
      tick: sim.tick,
      ack: this.remoteSeq,
      phase: sim.phase,
      phaseT: sim.phase === 0 ? sim.phaseT : 0,
      timer: sim.roundTimer,
      sd: sim.suddenDeath,
      sdR: sim.sdR,
      round: this.roundNum,
      scores: [this.scores[0], this.scores[1]],
      swap: sim.swap,
      p,
      projs: sim.projectiles.map((pr) => ({
        id: pr.id, o: pr.owner, x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy, oc: pr.oc, b: pr.bounces,
      })),
      covers: sim.covers.map((c) =>
        c.temp
          ? { id: c.id, hp: c.hp, x: c.x, y: c.y, w: c.w, h: c.h, mhp: c.maxHp }
          : { id: c.id, hp: c.hp },
      ),
      walls: sim.tempWalls.map((w) => ({ id: w.id, slot: w.slot, ph: w.phase, t: w.t, life: w.life })),
      pads: sim.pads.map((pad) => pad.surgeT),
    };
  }

  // ==========================================================================
  // FX routing
  // ==========================================================================

  private localDashFx(x: number, y: number, dx: number, dy: number): void {
    this.audio.play('dash', { x });
    this.renderer.stretchPlayer(this.localTeam, Math.atan2(dy, dx), 0.55);
    this.particles.spawnSparks(x, y, Math.atan2(-dy, -dx), 0.9, 8, 260, 0.3, 2, teamColor(this.localTeam));
    this.effects.addShake(0.14);
    this.effects.zoomPulse();
  }

  private localPadFx(x: number, y: number, dx: number, dy: number, surge: boolean, team: Team): void {
    this.audio.play('padBounce', { x, rate: surge ? 1.3 : 1 });
    this.particles.spawnRing(x, y, surge ? 70 : 50, 0.4, surge ? COLORS.padSurge : COLORS.pad, 4);
    this.particles.spawnSparks(x, y, Math.atan2(dy, dx), 0.8, 10, 320, 0.35, 2, COLORS.pad);
    this.renderer.stretchPlayer(team, Math.atan2(dy, dx), 0.6);
    this.effects.addShake(surge ? 0.24 : 0.16);
  }

  private handleSimEvent(e: SimEvent, fromNet: boolean): void {
    const local = this.localTeam;
    const isClient = this.mode === 'clientnet';
    switch (e.k) {
      case 'shot': {
        const mine = isClient && fromNet && e.team === local;
        if (!mine) {
          this.renderer.muzzle(e.team);
          this.audio.play(e.oc ? 'shotOc' : 'shot', { x: e.x, rate: e.team === 0 ? 1 : 0.92 });
        }
        break;
      }
      case 'projSpawn':
        break;
      case 'projDie':
        if (e.burst) {
          this.particles.spawnSparks(e.x, e.y, 0, Math.PI * 2, 6, 220, 0.28, 1.8, '#ffe9c9');
          this.particles.spawnGlow(e.x, e.y, 16, 0.22, '#ffffff');
        }
        break;
      case 'bounce': {
        const ang = Math.atan2(e.ny, e.nx);
        if (e.pad) {
          this.audio.play('padBounce', { x: e.x, vol: 0.5, rate: 1.5 });
          this.particles.spawnRing(e.x, e.y, 26, 0.25, COLORS.pad, 3);
        } else {
          this.audio.play('ricochet', { x: e.x, rate: 0.9 + Math.random() * 0.25 });
          this.particles.spawnSparks(e.x, e.y, ang, 1.4, 7, 260, 0.26, 1.7, COLORS.warn);
          this.particles.spawnRing(e.x, e.y, 18, 0.22, '#ffd9a0', 2.5);
          this.effects.addShake(0.05);
        }
        break;
      }
      case 'hit': {
        const col = teamColor(e.target);
        if (e.shield) {
          this.audio.play('hitShield', { x: e.x });
          this.renderer.shieldHit(e.target);
          this.particles.spawnSparks(e.x, e.y, 0, Math.PI * 2, 6, 200, 0.3, 1.6, col);
        } else {
          this.audio.play('hitPlayer', { x: e.x });
          this.renderer.flashPlayer(e.target);
          this.particles.spawnSparks(e.x, e.y, 0, Math.PI * 2, 9, 260, 0.32, 2, col);
          this.particles.spawnRing(e.x, e.y, 24, 0.24, col, 3);
          if (e.src === 'proj' || e.src === 'repulsor') {
            this.particles.spawnText(e.x, e.y, `-${Math.round(e.dmg)}`, e.target === local ? '#ff9c9c' : '#ffe8b0');
          }
          this.effects.addShake(e.target === local ? 0.3 : 0.16);
          if (e.target === local && !this.settings.reducedFlashes) {
            this.effects.flash('#ff2233', 0.1, 0.12);
          }
        }
        break;
      }
      case 'death': {
        this.audio.play('death', { x: e.x });
        this.renderer.markDead(e.target, e.x, e.y);
        const col = teamColor(e.target);
        this.particles.spawnRing(e.x, e.y, 90, 0.55, col, 5);
        this.particles.spawnRing(e.x, e.y, 50, 0.4, '#ffffff', 3);
        this.particles.spawnSparks(e.x, e.y, 0, Math.PI * 2, 26, 420, 0.6, 2.4, col);
        this.particles.spawnDebris(e.x, e.y, 14, '#2c3648');
        this.particles.spawnGlow(e.x, e.y, 60, 0.5, col);
        this.effects.addShake(0.65);
        this.effects.hitstop(0.13);
        this.effects.slowmo(1.0, 0.35);
        this.effects.flash('#ffffff', 0.18, 0.16);
        break;
      }
      case 'dash': {
        const mine = isClient && e.team === local;
        if (!mine) {
          this.audio.play('dash', { x: e.x, vol: 0.8 });
          this.renderer.stretchPlayer(e.team, Math.atan2(e.dy, e.dx), 0.55);
          this.particles.spawnSparks(e.x, e.y, Math.atan2(-e.dy, -e.dx), 0.9, 8, 260, 0.3, 2, teamColor(e.team));
          if (!isClient && e.team === local) {
            this.effects.addShake(0.14);
            this.effects.zoomPulse();
          }
        }
        break;
      }
      case 'module': {
        const mine = isClient && e.team === local;
        if (!mine) {
          this.audio.play(e.kind === 'aegis' ? 'shieldUp' : e.kind === 'volt' ? 'volt' : 'repulsor', { x: e.x });
        }
        if (e.kind === 'repulsor') {
          this.particles.spawnRing(e.x, e.y, MODULES.repulsor.radius, 0.45, COLORS.energyWall, 6);
          this.particles.spawnRing(e.x, e.y, MODULES.repulsor.radius * 0.6, 0.3, '#ffffff', 3);
          this.particles.spawnSparks(e.x, e.y, 0, Math.PI * 2, 16, 420, 0.4, 2, COLORS.energyWall);
          this.effects.addShake(0.3);
        } else if (e.kind === 'aegis') {
          this.particles.spawnRing(e.x, e.y, 40, 0.3, teamColor(e.team), 3);
        } else {
          this.particles.spawnSparks(e.x, e.y, 0, Math.PI * 2, 10, 200, 0.4, 1.8, '#ffd166');
        }
        break;
      }
      case 'shieldBreak':
        this.audio.play('shieldBreak', { x: e.x });
        this.particles.spawnRing(e.x, e.y, 46, 0.35, teamColor(e.team), 4);
        this.particles.spawnSparks(e.x, e.y, 0, Math.PI * 2, 12, 300, 0.4, 1.8, teamColor(e.team));
        break;
      case 'pad': {
        const mine = isClient && e.team === local;
        if (!mine) this.localPadFx(e.x, e.y, e.dx, e.dy, e.surge, e.team);
        break;
      }
      case 'coverHit':
        this.audio.play('coverHit', { x: e.x, vol: 0.7 });
        this.particles.spawnDebris(e.x, e.y, 3, '#39455e', Math.atan2(e.ny, e.nx));
        break;
      case 'coverBreak':
        this.audio.play('coverBreak', { x: e.x });
        this.particles.spawnDebris(e.x, e.y, 16, '#39455e');
        this.particles.spawnGlow(e.x, e.y, 44, 0.4, '#c9d6ef');
        this.particles.spawnRing(e.x, e.y, Math.max(e.w, e.h) * 0.8, 0.4, '#aebfdd', 4);
        this.effects.addShake(0.3);
        break;
      case 'coverRepair':
        this.audio.play('coverRepair');
        break;
      case 'coverRaise':
        this.audio.play('wallUp', { x: e.x });
        this.particles.spawnDebris(e.x, e.y, 8, '#2c5a4c');
        this.particles.spawnRing(e.x, e.y, 40, 0.35, COLORS.pad, 3);
        break;
      case 'wallUp':
        this.audio.play('wallUp', { x: e.x });
        this.particles.spawnSparks(e.x, e.y, -Math.PI / 2, 0.8, 10, 200, 0.35, 2, COLORS.energyWall);
        break;
      case 'wallBreak':
        this.audio.play('wallBreak', { x: e.x });
        this.particles.spawnSparks(e.x, e.y, 0, Math.PI * 2, 14, 320, 0.4, 2, COLORS.energyWall);
        this.particles.spawnRing(e.x, e.y, 40, 0.3, COLORS.energyWall, 3);
        break;
      case 'zoneBoom':
        this.audio.play('zoneBoom', { x: e.x });
        this.particles.spawnRing(e.x, e.y, e.r + 24, 0.4, '#ff8452', 5);
        this.particles.spawnSparks(e.x, e.y, 0, Math.PI * 2, 16, 380, 0.45, 2.2, '#ff8452');
        this.particles.spawnGlow(e.x, e.y, e.r, 0.35, '#ff5a2e');
        this.effects.addShake(0.34);
        break;
      case 'arenaEvent': {
        const k = e.desc.kind;
        if (k === 'laserSweep' || k === 'crossfire') this.audio.play('laserWarn');
        else if (k === 'dangerZones') this.audio.play('zoneWarn');
        else if (k === 'tempWalls') this.audio.play('zoneWarn', { vol: 0.5, rate: 1.4 });
        else if (k === 'padSurge') this.audio.play('volt', { vol: 0.5 });
        else this.audio.play('uiHover', { vol: 0.8 });
        break;
      }
      case 'arenaEnd': {
        const stop = this.laserHums.get(e.id);
        if (stop) {
          stop();
          this.laserHums.delete(e.id);
        }
        break;
      }
      case 'suddenDeath':
        this.audio.play('sudden');
        this.pres = { kind: 'suddenDeath', t: 0, data: 0, text: 'SUDDEN DEATH', sub: '' };
        this.effects.addShake(0.3);
        break;
      case 'roundEnd':
        // Flow handled by onRoundEnded (solo/host) / roundEnd message (client).
        break;
      default:
        break;
    }
  }

  private updateLaserHums(): void {
    const view = this.mode === 'clientnet' ? this.replica : this.sim;
    if (!view) return;
    const events = view.director.active;
    for (const ev of events) {
      const k = ev.desc.kind;
      if (k !== 'laserSweep' && k !== 'crossfire') continue;
      const anyActive = ev.beams.some((b) => b.active);
      if (anyActive && !this.laserHums.has(ev.desc.id)) {
        const beam = ev.beams[0];
        this.laserHums.set(ev.desc.id, this.audio.startLaserHum((beam.x + beam.ex) / 2));
      } else if (!anyActive && this.laserHums.has(ev.desc.id)) {
        const stop = this.laserHums.get(ev.desc.id);
        if (stop) stop();
        this.laserHums.delete(ev.desc.id);
      }
    }
    // Stop hums for events that vanished entirely.
    for (const [id, stop] of this.laserHums) {
      if (!events.some((ev) => ev.desc.id === id)) {
        stop();
        this.laserHums.delete(id);
      }
    }
  }

  // ==========================================================================
  // Frame loop
  // ==========================================================================

  private stepFrame(dtRaw: number, hidden = false): void {
    const timescale = this.effects.update(dtRaw);
    const fxDt = dtRaw * timescale;
    this.fps = this.fps * 0.95 + (dtRaw > 0 ? 1 / dtRaw : 60) * 0.05;

    const inPlay = (this.state === 'match' || this.state === 'result') && this.mode !== 'idle';
    if (inPlay && !this.soloPaused) {
      this.acc += fxDt;
      let steps = 0;
      while (this.acc >= STEP && steps < MAX_CATCHUP_STEPS) {
        this.fixedTick();
        this.acc -= STEP;
        steps++;
      }
      if (steps >= MAX_CATCHUP_STEPS) this.acc = 0;
      this.particles.update(fxDt);
      this.replica?.frame(fxDt);
      this.watchPhase();
      this.updateLaserHums();

      // Round-flow timer (solo / host): presentation → next round or result.
      if ((this.mode === 'solo' || this.mode === 'hostnet') && this.flowTimer > 0) {
        this.flowTimer -= dtRaw;
        if (this.flowTimer <= 0 && this.state === 'match') this.advanceFlow();
      }
    }
    if (this.pres) {
      this.pres.t += dtRaw;
      const expiry =
        this.pres.kind === 'roundIntro' ? 99 :
        this.pres.kind === 'matchEnd' ? 999 :
        this.pres.kind === 'suddenDeath' ? 2.1 :
        this.pres.kind === 'fight' ? 0.7 : 3.2;
      if (this.pres.t > expiry) this.pres = null;
    }
    if (this.hintT > 0) this.hintT -= dtRaw;

    if (hidden) return; // no rendering while the tab is hidden

    if (!inPlay || this.mode === 'idle') {
      if (MENU_SCREENS.includes(this.state) || this.state === 'boot') {
        this.renderer.renderMenu(dtRaw);
      }
      return;
    }

    const view = this.buildView();
    if (!view) return;
    this.renderer.render(view, this.soloPaused ? 0 : fxDt, {
      pres: this.pres,
      showHud: true,
      showReticle: this.state === 'match' && !this.ui.pauseOpen && view.phase !== 2,
      mouseX: this.input.mouseX,
      mouseY: this.input.mouseY,
      hintAlpha: clamp(Math.min(this.hintT, 1), 0, 1) * 0.95,
      debug: this.debugOn > 0 && import.meta.env.DEV ? this.buildDebug(view) : null,
    });
  }

  private watchPhase(): void {
    const phase = this.mode === 'clientnet' ? this.replica?.phase ?? -1 : this.sim?.phase ?? -1;
    const phaseT = this.mode === 'clientnet' ? this.replica?.phaseT ?? 0 : this.sim?.phaseT ?? 0;
    if (phase === 0) {
      const n = Math.ceil(phaseT / 0.8);
      if (phaseT <= 2.4 && n !== this.lastCount && n >= 1 && n <= 3) {
        this.lastCount = n;
        this.audio.play('count');
      }
    }
    if (phase === 1 && this.prevPhase === 0) {
      this.audio.play('go');
      this.pres = { kind: 'fight', t: 0, data: 0, text: 'FIGHT!', sub: '' };
      if (this.mode === 'solo' && !this.seenHints) {
        this.hintT = 6.5;
        this.seenHints = true;
        try { localStorage.setItem('dashduel:hints', '1'); } catch { /* ignore */ }
      }
    }
    this.prevPhase = phase;
  }

  private buildView(): WorldView | null {
    if (this.mode === 'clientnet') {
      const rep = this.replica;
      if (!rep) return null;
      const me = rep.players[1];
      const meView = { ...me, x: me.x + rep.errX, y: me.y + rep.errY };
      return {
        players: [rep.players[0], meView],
        projectiles: rep.projectiles,
        covers: rep.covers,
        tempWalls: rep.tempWalls,
        pads: rep.pads,
        director: { events: rep.director.active, sdActive: rep.suddenDeath, sdR: rep.sdR },
        phase: rep.phase,
        phaseT: rep.phaseT,
        timer: rep.timer,
        round: this.roundNum,
        scores: this.scores,
        suddenDeath: rep.suddenDeath,
        localTeam: 1,
        names: this.names,
        online: true,
        ping: this.net?.ping ?? 0,
        winner: this.matchWinner,
      };
    }
    const sim = this.sim;
    if (!sim) return null;
    return {
      players: sim.players,
      projectiles: sim.projectiles,
      covers: sim.covers,
      tempWalls: sim.tempWalls,
      pads: sim.pads,
      director: { events: sim.director.active, sdActive: sim.suddenDeath, sdR: sim.sdR },
      phase: sim.phase,
      phaseT: sim.phaseT,
      timer: sim.roundTimer,
      round: this.roundNum,
      scores: this.scores,
      suddenDeath: sim.suddenDeath,
      localTeam: 0,
      names: this.names,
      online: this.mode === 'hostnet',
      ping: this.net?.ping ?? 0,
      winner: this.matchWinner,
    };
  }

  private buildDebug(view: WorldView): DebugInfo {
    const evt = view.director.events[0];
    return {
      fps: this.fps,
      tick: this.sim?.tick ?? 0,
      entities: view.projectiles.length + view.covers.length + view.tempWalls.length + 2,
      particles: this.particles.liveCount,
      ping: this.net?.ping ?? 0,
      role: this.mode,
      aiState: this.ai?.state ?? '—',
      event: evt ? evt.desc.kind : 'none',
      shapes: this.debugOn === 2,
    };
  }
}
