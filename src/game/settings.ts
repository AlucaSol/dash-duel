export type Quality = 'low' | 'medium' | 'high';

export interface Settings {
  /** Master volume 0..1 */
  volume: number;
  /** Screen shake strength 0..1 */
  shake: number;
  quality: Quality;
  reducedFlashes: boolean;
}

const KEY = 'dashduel:settings:v1';

export const DEFAULT_SETTINGS: Settings = {
  volume: 0.8,
  shake: 1,
  quality: 'high',
  reducedFlashes: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      volume: clamp01Num(parsed.volume, DEFAULT_SETTINGS.volume),
      shake: clamp01Num(parsed.shake, DEFAULT_SETTINGS.shake),
      quality: parsed.quality === 'low' || parsed.quality === 'medium' || parsed.quality === 'high'
        ? parsed.quality
        : DEFAULT_SETTINGS.quality,
      reducedFlashes: typeof parsed.reducedFlashes === 'boolean'
        ? parsed.reducedFlashes
        : DEFAULT_SETTINGS.reducedFlashes,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private mode etc) — settings just don't persist.
  }
}

function clamp01Num(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
}
