// GENERATED FILE — do not edit by hand.
// Run `npm run music:manifest` (or any dev/build) after changing the mp3s in
// public/music/playlist/. See scripts/gen-music-manifest.ts.

export interface TrackInfo {
  /** File name inside public/music/playlist/. */
  file: string;
  /** Display title, shown in the settings playlist section. */
  title: string;
  /** Credited creator, parsed from the file name. */
  artist: string;
}

export const PLAYLIST: TrackInfo[] = [
  { file: "delo_sound-fast_beat_trap.mp3", title: "Fast Beat Trap", artist: "Delo Sound" },
  { file: "haunt_sync-high_energy_gabber_trance.mp3", title: "High Energy Gabber Trance", artist: "Haunt Sync" },
  { file: "haunt_sync-ridiculous_fast.mp3", title: "Ridiculous Fast", artist: "Haunt Sync" },
  { file: "haunt_sync-simple-gabber-trance.mp3", title: "Simple Gabber Trance", artist: "Haunt Sync" },
  { file: "jakob_welik-we_own_the_night.mp3", title: "We Own The Night", artist: "Jakob Welik" },
];

/** The looping menu / loading-screen theme, in public/music/. */
export const MENU_TRACK = { file: 'menu.mp3', title: 'Menu Theme' } as const;
