// Streamed background music, kept deliberately separate from AudioSystem —
// that one synthesises short SFX through the Web Audio API, this one just
// drives HTMLAudioElements for the long mp3 tracks.
//
// Two sources: the looping menu theme (loaded during the boot screen, playing
// across every menu and loading screen) and the match playlist, whose opening
// track is fetched right before a match starts while the rest trickle in
// during play, one at a time.

import { clamp } from '../utils/math';
import { MENU_TRACK, PLAYLIST } from './musicManifest';
import type { TrackInfo } from './musicManifest';

export type MusicMode = 'none' | 'menu' | 'playlist';

/** Music sits under the SFX; the curve matches AudioSystem's volume². */
const MUSIC_MIX = 0.5;
/** Give up waiting on a track after this long and carry on regardless. */
const LOAD_TIMEOUT = 20_000;
const FADE_TIME = 0.45;
/** Grace period before the background trickle starts, so the opening of a
 *  match never competes with anything else for bandwidth. */
const BACKGROUND_DELAY = 2500;

function audioUrl(path: string): string {
  return `${import.meta.env.BASE_URL}music/${path}`;
}

/** Resolves once the element has buffered enough to play through, or times out. */
function whenReady(el: HTMLAudioElement, onProgress?: (frac: number) => void): Promise<void> {
  if (el.readyState >= 4) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      window.clearInterval(poll);
      el.removeEventListener('canplaythrough', finish);
      el.removeEventListener('error', finish);
      resolve();
    };
    const timer = window.setTimeout(finish, LOAD_TIMEOUT);
    // Background loads pass no reporter and so cost nothing while a match runs.
    const poll = onProgress
      ? window.setInterval(() => {
          const end = el.buffered.length > 0 ? el.buffered.end(el.buffered.length - 1) : 0;
          if (el.duration > 0) onProgress(clamp(end / el.duration, 0, 1));
        }, 100)
      : 0;
    el.addEventListener('canplaythrough', finish);
    el.addEventListener('error', finish);
    el.load();
  });
}

export class MusicSystem {
  /** Fired whenever the audible track changes (title, and whether skip applies). */
  onTrackChange: ((title: string, canSkip: boolean) => void) | null = null;

  private menuEl: HTMLAudioElement | null = null;
  private trackEls: HTMLAudioElement[] = [];
  private tracks: TrackInfo[] = PLAYLIST;
  private index = 0;
  private mode: MusicMode = 'none';
  private volume: number;
  private firstLoad: Promise<void> | null = null;
  /** Per-track buffering promises, so each track is only ever requested once. */
  private loads = new Map<number, Promise<void>>();
  /** Set when play() was rejected — retried on the next user gesture. */
  private blocked = false;
  private fades = new Map<HTMLAudioElement, number>();

  constructor(initialVolume: number) {
    this.volume = clamp(initialVolume, 0, 1);
  }

  // ---------------------------------------------------------------- loading

  /** Called from the boot loading screen; the menu theme must be ready first. */
  async loadMenu(onProgress?: (frac: number) => void): Promise<void> {
    if (this.menuEl) return;
    const el = new Audio();
    el.src = audioUrl(MENU_TRACK.file);
    el.loop = true;
    el.preload = 'auto';
    el.volume = 0;
    this.menuEl = el;
    await whenReady(el, onProgress);
    onProgress?.(1);
  }

  /**
   * Called right before a match starts (solo launch / host pressing Launch).
   * Only the opening track is downloaded up front — that is all the match needs
   * to begin — and the rest trickle in behind it while the duel is under way.
   * Resolves once, then returns instantly for every later match.
   */
  preparePlaylist(onProgress?: (frac: number) => void): Promise<void> {
    if (this.firstLoad) {
      onProgress?.(1);
      return this.firstLoad;
    }
    this.buildElements();
    this.firstLoad = (async () => {
      if (this.trackEls.length === 0) return;
      await this.request(0, onProgress);
      onProgress?.(1);
      window.setTimeout(() => void this.loadRest(), BACKGROUND_DELAY);
    })();
    return this.firstLoad;
  }

  /** True once the opening track is buffered — i.e. a match may start. */
  get playlistReady(): boolean {
    return this.loads.has(0) && this.trackEls.length > 0 && this.trackEls[0].readyState >= 3;
  }

  /** One element per track, created up front but not yet fetching anything. */
  private buildElements(): void {
    if (this.trackEls.length > 0) return;
    this.trackEls = this.tracks.map((t) => {
      const el = new Audio();
      el.preload = 'none';
      el.src = audioUrl(`playlist/${t.file}`);
      el.volume = 0;
      el.addEventListener('ended', () => this.onTrackEnded(el));
      return el;
    });
  }

  /** Buffers one track, at most once. */
  private request(i: number, onProgress?: (frac: number) => void): Promise<void> {
    const inFlight = this.loads.get(i);
    if (inFlight) return inFlight;
    const el = this.trackEls[i];
    if (!el) return Promise.resolve();
    el.preload = 'auto';
    const p = whenReady(el, onProgress);
    this.loads.set(i, p);
    return p;
  }

  /** Trickles the remaining tracks in one at a time, never in parallel. */
  private async loadRest(): Promise<void> {
    for (let i = 1; i < this.trackEls.length; i++) {
      await this.request(i);
    }
  }

  // -------------------------------------------------------------- playback

  /** Switch to the looping menu theme (no-op if it is already the source). */
  toMenu(): void {
    if (this.mode === 'menu') return;
    this.mode = 'menu';
    this.stopPlaylistEls();
    const el = this.menuEl;
    if (el) {
      this.start(el);
    }
    this.announce();
  }

  /**
   * Switch to the match playlist. Starts from the first track unless the
   * playlist is already the live source (e.g. a rematch straight from the
   * result screen), in which case it simply keeps going.
   */
  toPlaylist(): void {
    if (this.mode === 'playlist' && this.currentEl && !this.currentEl.paused) return;
    const wasMenu = this.mode !== 'playlist';
    this.mode = 'playlist';
    if (this.menuEl) this.fadeOut(this.menuEl);
    if (wasMenu) this.index = 0;
    this.playCurrent();
    this.announce();
  }

  /** Advance to the next track in the playlist, wrapping at the end. */
  skip(): void {
    if (this.mode !== 'playlist' || this.tracks.length === 0) return;
    const prev = this.currentEl;
    this.index = (this.index + 1) % this.tracks.length;
    if (prev) this.fadeOut(prev);
    this.playCurrent();
    this.announce();
  }

  /** Retry a play() the browser refused before the first user gesture. */
  unlock(): void {
    if (!this.blocked) return;
    const el = this.mode === 'menu' ? this.menuEl : this.currentEl;
    if (el) this.start(el);
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    const el = this.mode === 'menu' ? this.menuEl : this.currentEl;
    if (el && !this.fades.has(el)) el.volume = this.target;
  }

  /** Title of whatever is audible right now, for the settings panel. */
  get currentTitle(): string {
    if (this.mode === 'playlist') return this.tracks[this.index]?.title ?? '—';
    if (this.mode === 'menu') return MENU_TRACK.title;
    return '—';
  }

  get canSkip(): boolean {
    return this.mode === 'playlist' && this.tracks.length > 1;
  }

  // ---------------------------------------------------------------- private

  private get target(): number {
    return this.volume * this.volume * MUSIC_MIX;
  }

  private get currentEl(): HTMLAudioElement | null {
    return this.trackEls[this.index] ?? null;
  }

  private announce(): void {
    this.onTrackChange?.(this.currentTitle, this.canSkip);
  }

  private onTrackEnded(el: HTMLAudioElement): void {
    if (this.mode !== 'playlist' || el !== this.currentEl) return;
    this.skip();
  }

  /**
   * Plays the selected track, pulling it forward in the download queue if the
   * background trickle has not reached it yet (skipping ahead early), and
   * making sure the one after it is buffering before it is needed.
   */
  private playCurrent(): void {
    const el = this.currentEl;
    if (!el) return;
    void this.request(this.index);
    if (el.readyState > 0) el.currentTime = 0;
    this.start(el);
    if (this.trackEls.length > 1) void this.request((this.index + 1) % this.trackEls.length);
  }

  private start(el: HTMLAudioElement): void {
    this.cancelFade(el);
    el.volume = this.target;
    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.then(
        () => {
          this.blocked = false;
        },
        () => {
          // Autoplay policy: wait for a gesture, then unlock() tries again.
          this.blocked = true;
        },
      );
    }
  }

  private stopPlaylistEls(): void {
    for (const el of this.trackEls) {
      if (el && !el.paused) this.fadeOut(el);
    }
  }

  private cancelFade(el: HTMLAudioElement): void {
    const t = this.fades.get(el);
    if (t !== undefined) {
      window.clearInterval(t);
      this.fades.delete(el);
    }
  }

  private fadeOut(el: HTMLAudioElement): void {
    this.cancelFade(el);
    if (el.paused) return;
    const from = el.volume;
    const steps = Math.max(1, Math.round(FADE_TIME * 30));
    let i = 0;
    const timer = window.setInterval(() => {
      i++;
      el.volume = Math.max(0, from * (1 - i / steps));
      if (i >= steps) {
        this.cancelFade(el);
        el.pause();
        el.currentTime = 0;
      }
    }, (FADE_TIME * 1000) / steps);
    this.fades.set(el, timer);
  }
}
