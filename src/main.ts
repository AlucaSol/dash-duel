// Entry point: grab the canvas + UI root, build the Game and boot it.

import './style.css';
import { Game } from './game/Game';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
const uiRoot = document.getElementById('ui-root');

if (!canvas || !uiRoot) {
  throw new Error('Dash Duel: required #game-canvas / #ui-root elements are missing');
}

const game = new Game(canvas, uiRoot);
void game.boot();
