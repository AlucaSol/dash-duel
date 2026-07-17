// PeerJS wrapper: friend-code hosting/joining, one reliable JSON data channel,
// message validation, ping measurement and normalised error reporting.

import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';
import { NET } from '../game/constants';
import { genFriendCode } from '../utils/random';
import { getPeerOptions } from './networkConfig';
import { PROTOCOL_VERSION, validateMsg } from './protocol';
import type { NetMsg } from './protocol';

export type NetRole = 'host' | 'client';

export interface NetErrorInfo {
  kind: 'code-not-found' | 'network' | 'incompatible' | 'timeout' | 'version' | 'unknown';
  message: string;
}

export class NetworkManager {
  role: NetRole | null = null;
  code: string | null = null;
  ping = 0;
  connected = false;

  onCode: ((code: string) => void) | null = null;
  onConnected: (() => void) | null = null;
  onMessage: ((m: NetMsg) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  onError: ((e: NetErrorInfo) => void) | null = null;

  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private pingTimer: number | null = null;
  private connectTimeout: number | null = null;
  private hostRetries = 0;
  private destroyed = false;
  private handshakeDone = false;
  private lastHeard = 0;

  // -------------------------------------------------------------------------

  startHost(): void {
    this.destroyed = false;
    this.role = 'host';
    this.hostRetries = 0;
    this.tryHostCode();
  }

  private tryHostCode(): void {
    if (this.destroyed) return;
    this.cleanupPeer();
    const code = genFriendCode(6);
    const peer = new Peer(NET.idPrefix + code, getPeerOptions());
    this.peer = peer;
    peer.on('open', () => {
      if (this.destroyed || this.peer !== peer) return;
      this.code = code;
      this.onCode?.(code);
    });
    peer.on('connection', (conn) => {
      if (this.destroyed || this.peer !== peer) return;
      if (this.conn && this.conn.open) {
        // Only one challenger — politely refuse extras.
        conn.on('open', () => conn.close());
        return;
      }
      this.adoptConnection(conn);
    });
    peer.on('error', (err) => {
      if (this.destroyed || this.peer !== peer) return;
      const type = (err as { type?: string }).type ?? '';
      if (type === 'unavailable-id') {
        if (this.hostRetries++ < 5) {
          this.tryHostCode();
        } else {
          this.onError?.({ kind: 'unknown', message: 'Could not reserve a friend code. Try again.' });
        }
        return;
      }
      this.handlePeerError(type, err as Error);
    });
    peer.on('disconnected', () => {
      // Signalling dropped; PeerJS can reconnect for future connections.
      if (!this.destroyed && this.peer === peer && !this.connected) {
        try { peer.reconnect(); } catch { /* ignore */ }
      }
    });
  }

  join(code: string): void {
    this.destroyed = false;
    this.role = 'client';
    this.code = code;
    this.cleanupPeer();
    const peer = new Peer(getPeerOptions());
    this.peer = peer;
    this.connectTimeout = window.setTimeout(() => {
      if (!this.connected && !this.destroyed) {
        this.onError?.({
          kind: 'timeout',
          message: 'Connection timed out. The host may be offline or blocked by a strict network (no TURN relay configured).',
        });
        this.destroy();
      }
    }, NET.connectTimeout * 1000);
    peer.on('open', () => {
      if (this.destroyed || this.peer !== peer) return;
      const conn = peer.connect(NET.idPrefix + code, { reliable: true, serialization: 'json' });
      this.adoptConnection(conn);
    });
    peer.on('error', (err) => {
      if (this.destroyed || this.peer !== peer) return;
      this.handlePeerError((err as { type?: string }).type ?? '', err as Error);
    });
  }

  private adoptConnection(conn: DataConnection): void {
    this.conn = conn;
    this.handshakeDone = false;
    conn.on('open', () => {
      if (this.destroyed) return;
      if (this.role === 'client') {
        this.sendRaw({ t: 'hello', v: PROTOCOL_VERSION });
      }
    });
    conn.on('data', (raw) => {
      if (this.destroyed) return;
      const msg = validateMsg(raw);
      if (!msg) return;
      this.lastHeard = performance.now();
      this.routeMessage(msg);
    });
    conn.on('close', () => {
      if (this.destroyed) return;
      if (this.connected || this.handshakeDone) {
        this.stopPing();
        this.connected = false;
        this.onClosed?.('Connection closed');
      } else if (this.role === 'host') {
        this.conn = null; // failed handshake; keep waiting
      }
    });
    conn.on('error', () => {
      if (this.destroyed) return;
      if (this.connected) {
        this.stopPing();
        this.connected = false;
        this.onClosed?.('Connection error');
      }
    });
  }

  private routeMessage(msg: NetMsg): void {
    switch (msg.t) {
      case 'hello': {
        if (this.role !== 'host') return;
        if (msg.v !== PROTOCOL_VERSION) {
          this.onError?.({ kind: 'version', message: 'The other player is on a different game version.' });
          this.conn?.close();
          return;
        }
        this.handshakeDone = true;
        this.sendRaw({ t: 'helloAck', v: PROTOCOL_VERSION });
        this.connected = true;
        this.startPing();
        this.onConnected?.();
        return;
      }
      case 'helloAck': {
        if (this.role !== 'client') return;
        if (msg.v !== PROTOCOL_VERSION) {
          this.onError?.({ kind: 'version', message: 'The host is on a different game version.' });
          this.destroy();
          return;
        }
        this.handshakeDone = true;
        this.connected = true;
        if (this.connectTimeout !== null) {
          clearTimeout(this.connectTimeout);
          this.connectTimeout = null;
        }
        this.startPing();
        this.onConnected?.();
        return;
      }
      case 'ping':
        this.sendRaw({ t: 'pong', ts: msg.ts });
        return;
      case 'pong':
        this.ping = Math.max(1, performance.now() - msg.ts);
        return;
      default:
        this.onMessage?.(msg);
    }
  }

  private handlePeerError(type: string, err: Error): void {
    let info: NetErrorInfo;
    switch (type) {
      case 'peer-unavailable':
        info = { kind: 'code-not-found', message: 'No match found for that code. Check the code and make sure the host is still waiting.' };
        break;
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
        info = { kind: 'network', message: 'Could not reach the matchmaking service. Check your internet connection and try again.' };
        break;
      case 'browser-incompatible':
        info = { kind: 'incompatible', message: 'This browser does not support WebRTC connections.' };
        break;
      case 'webrtc':
        info = { kind: 'network', message: 'WebRTC connection failed. A strict firewall/NAT may require a TURN relay.' };
        break;
      default:
        info = { kind: 'unknown', message: err.message || 'Unknown network error.' };
    }
    this.onError?.(info);
  }

  // -------------------------------------------------------------------------

  send(msg: NetMsg): void {
    if (!this.connected) return;
    this.sendRaw(msg);
  }

  private sendRaw(msg: NetMsg): void {
    try {
      if (this.conn && this.conn.open) this.conn.send(msg);
    } catch {
      // Channel raced shut; the close handler will fire.
    }
  }

  private startPing(): void {
    this.stopPing();
    this.lastHeard = performance.now();
    this.pingTimer = window.setInterval(() => {
      // Watchdog: WebRTC can take ~15s to notice an abruptly closed peer;
      // treat prolonged silence as a lost connection instead.
      if (this.connected && performance.now() - this.lastHeard > NET.silenceTimeout * 1000) {
        this.stopPing();
        this.connected = false;
        this.onClosed?.('Connection timed out');
        return;
      }
      this.sendRaw({ t: 'ping', ts: performance.now() });
    }, NET.pingInterval * 1000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private cleanupPeer(): void {
    this.stopPing();
    if (this.conn) {
      try { this.conn.close(); } catch { /* ignore */ }
      this.conn = null;
    }
    if (this.peer) {
      try { this.peer.destroy(); } catch { /* ignore */ }
      this.peer = null;
    }
    this.connected = false;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.connectTimeout !== null) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    this.cleanupPeer();
    this.role = null;
    this.code = null;
    this.ping = 0;
  }
}
