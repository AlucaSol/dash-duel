// Headless smoke test: runs a full solo-style match (Simulation + two AI
// controllers) without a DOM. Verifies the sim steps cleanly, rounds end,
// sudden death fires, and a match winner emerges. Run with `npm run smoke`.

import { AIController } from '../src/ai/AIController';
import { ROUND, STEP } from '../src/game/constants';
import { Simulation } from '../src/game/Simulation';
import type { Team } from '../src/game/types';

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

const seed = 0xc0ffee;
const sim = new Simulation(seed);
sim.setLoadouts('volt', 'repulsor');
const ai0 = new AIController(0, 'hard');
const ai1 = new AIController(1, 'standard');

const scores: [number, number] = [0, 0];
let round = 1;
let events = 0;
let sawSuddenDeath = false;
let matchWinner: Team | null = null;

sim.resetRound(round, false);

const maxTicks = 60 * 60 * 30; // 30 minutes of sim time, hard cap
for (let t = 0; t < maxTicks && matchWinner === null; t++) {
  sim.step([ai0.update(sim, STEP), ai1.update(sim, STEP)]);
  for (const e of sim.drainEvents()) {
    events++;
    if (e.k === 'suddenDeath') sawSuddenDeath = true;
    if (e.k === 'roundEnd') {
      if (e.winner >= 0) scores[e.winner as Team]++;
      if (scores[0] >= ROUND.winsNeeded) matchWinner = 0;
      else if (scores[1] >= ROUND.winsNeeded) matchWinner = 1;
      else {
        round = e.winner === -1 ? round : round + 1;
        sim.resetRound(round, round % 2 === 0);
      }
    }
  }
  const [a, b] = sim.players;
  if (!Number.isFinite(a.x + a.y + b.x + b.y)) fail(`non-finite player position at tick ${t}`);
  if (!Number.isFinite(a.hp + b.hp)) fail(`non-finite hp at tick ${t}`);
}

if (matchWinner === null) fail('no match winner within the tick cap');
if (events < 50) fail(`suspiciously few sim events (${events})`);

console.log(
  `SMOKE OK: winner=P${matchWinner} score=${scores[0]}-${scores[1]} rounds=${round} ` +
  `events=${events} suddenDeath=${sawSuddenDeath}`,
);
