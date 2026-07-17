# Dash Duel

A fast 1v1 sci-fi arena duel for the browser. Best-of-five rounds of ricocheting
energy shots, dashes, power modules and a living arena that fights back with
laser sweeps, danger zones, energy walls, cover shifts and bounce-pad surges.
Play solo against an AI or online against a friend with a 6-character code.

Built with TypeScript, Vite, Canvas 2D, PeerJS and the Web Audio API. No other
runtime dependencies, no backend, no external assets — everything (sprites,
arena, sounds) is generated in code.

## Controls

| Input | Action |
| --- | --- |
| WASD | Move |
| Mouse | Aim |
| Left mouse button | Fire |
| Space | Dash (brief invulnerability) |
| E / right mouse button | Power module |
| Escape | Pause (solo) / menu (online) |
| F3 | Debug overlay (dev builds only) |

Power modules (pick one per match): **Aegis Core** (temporary shield),
**Repulsor Core** (radial pulse that destroys projectiles and shoves the
opponent), **Volt Core** (overcharges your next three shots).

## Development

```bash
npm install
npm run dev      # local dev server
npm run build    # type-check + production build to dist/
npm run preview  # serve the production build
npm run smoke    # headless full-match simulation test (no browser needed)
```

## Deployment

`npm run build` produces a fully static site in `dist/`. The Vite `base` is
`'./'`, so the build works from any subfolder — GitHub Pages, Netlify,
Cloudflare Pages, Neocities, or a directory of an existing site. Just upload
the contents of `dist/`.

## Online play

Networking uses PeerJS over WebRTC data channels with the public PeerJS cloud
signalling server — no server of your own is needed.

1. One player picks **Host Online Match** and gets a 6-character friend code
   (ambiguous characters like `0/O/1/I` are never used).
2. The other picks **Join Online Match** and enters the code.
3. Both choose a power module, ready up, and the host launches the match.

The host is authoritative for all gameplay (positions, damage, arena events,
scores). The joining client sends inputs, predicts its own movement locally,
and interpolates the remote fighter from ~20 Hz snapshots. A ping indicator is
shown during online matches.

### Optional TURN relay

Strict-NAT pairs that cannot connect directly get a clear connection error. If
you have a TURN server, supply it at build time via environment variables (see
`src/network/networkConfig.ts` — never commit credentials):

```
VITE_TURN_URL=turn:turn.example.com:3478
VITE_TURN_USERNAME=user
VITE_TURN_CREDENTIAL=secret
```

### Known limitations

- No reconnection: if the data channel drops mid-match, the match ends with a
  "Connection Lost" screen and no recorded winner.
- The PeerJS cloud signalling server must be reachable to create/join matches.
- Two players behind the same symmetric NAT without TURN may fail to connect.

## Project structure

```
src/main.ts                 entry point
src/game/                   Game orchestrator, Simulation, physics, arena, constants
src/systems/                ArenaDirector, input, particles, audio, screen effects
src/ai/AIController.ts      solo-battle AI (easy / standard / hard)
src/network/                PeerJS manager, typed protocol, client replica, config
src/render/                 canvas renderer, HUD, pre-rendered sprite factory
src/ui/UIManager.ts         DOM menus, lobby, loadout, results, settings
src/utils/                  math, seeded RNG
scripts/smoke.ts            headless match smoke test
```
