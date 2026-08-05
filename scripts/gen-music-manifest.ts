// Regenerates src/systems/musicManifest.ts from the mp3 files sitting in
// public/music/playlist/. Runs automatically before `npm run dev` / `build`
// so dropping a new track into the folder is all that's needed to add it.
//
// Filename convention: `music_creator-name_of_song.mp3` — everything before
// the FIRST hyphen is the artist, the rest is the song title. Underscores and
// hyphens become spaces.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const playlistDir = resolve(here, '../public/music/playlist');
const outFile = resolve(here, '../src/systems/musicManifest.ts');

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const files = readdirSync(playlistDir)
  .filter((f) => f.toLowerCase().endsWith('.mp3'))
  .sort();

const entries = files.map((file) => {
  const stem = file.slice(0, -4);
  const split = stem.indexOf('-');
  const artist = split > 0 ? stem.slice(0, split) : '';
  const title = split > 0 ? stem.slice(split + 1) : stem;
  return { file, title: titleCase(title), artist: titleCase(artist) };
});

const body = entries
  .map((e) => `  { file: ${JSON.stringify(e.file)}, title: ${JSON.stringify(e.title)}, artist: ${JSON.stringify(e.artist)} },`)
  .join('\n');

const out = `// GENERATED FILE — do not edit by hand.
// Run \`npm run music:manifest\` (or any dev/build) after changing the mp3s in
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
${body}
];

/** The looping menu / loading-screen theme, in public/music/. */
export const MENU_TRACK = { file: 'menu.mp3', title: 'Menu Theme' } as const;
`;

let previous = '';
try {
  previous = readFileSync(outFile, 'utf8');
} catch {
  // First run — no manifest yet.
}
if (previous !== out) {
  writeFileSync(outFile, out, 'utf8');
  console.log(`music manifest: wrote ${entries.length} track(s) to src/systems/musicManifest.ts`);
} else {
  console.log(`music manifest: up to date (${entries.length} track(s))`);
}
