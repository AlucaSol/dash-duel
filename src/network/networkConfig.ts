// Central network configuration. PeerJS uses its public cloud signalling
// server by default. STUN is always configured; an optional TURN relay can be
// supplied via Vite environment variables (never hardcode credentials):
//
//   VITE_TURN_URL=turn:turn.example.com:3478
//   VITE_TURN_USERNAME=user
//   VITE_TURN_CREDENTIAL=secret
//
// The game works without TURN, but some strict-NAT pairs may fail to connect
// directly — they get a clear connection error instead.

import type { PeerJSOption } from 'peerjs';

export function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  const url = import.meta.env.VITE_TURN_URL;
  if (url) {
    servers.push({
      urls: url,
      username: import.meta.env.VITE_TURN_USERNAME ?? '',
      credential: import.meta.env.VITE_TURN_CREDENTIAL ?? '',
    });
  }
  return servers;
}

export function getPeerOptions(): PeerJSOption {
  return {
    // PeerJS cloud signalling (default host); only ICE config is customised.
    debug: 0,
    config: {
      iceServers: getIceServers(),
    },
  };
}
