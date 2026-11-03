import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentBridge } from '../../src/agent/AgentBridge';

/**
 * A stopped bridge must not open a socket (SRS-ABR-001/007).
 *
 * Found by driving the portable build rather than by reading the code. Ticking
 * the box starts a dial at the default address; typing an address immediately
 * after stops that instance and starts another. The first instance was already
 * awaiting the token lookup, and `connect()` did not re-check afterwards — so it
 * went on to open a socket and say hello. The server adopts whatever says
 * hello, so the page displaced ITSELF: the panel read "Another plan took over"
 * with one plan open, and the agent's next edit went to a socket nobody was
 * reading. Measured as 33 bars before and 33 after an `apply_batch` that
 * reported success.
 */

class FakeSocket {
  // The code under test compares against `WebSocket.OPEN`, which resolves on
  // the stubbed global — so the stub has to carry the real constants.
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    made.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; }
}

/** Every socket the code under test built, in order. */
let made: FakeSocket[] = [];
let releaseToken: (() => void) | null = null;
const realWebSocket = globalThis.WebSocket;

beforeEach(() => {
  made = [];
  releaseToken = null;
  // The token lookup, held open until a test lets it go — which is the window
  // the race lives in.
  vi.stubGlobal(
    'fetch',
    () =>
      new Promise((resolve) => {
        releaseToken = () =>
          resolve(new Response(JSON.stringify({ token: 't', port: 5199 }), { status: 200 }));
      }),
  );
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.WebSocket = realWebSocket;
});

/**
 * Let the handshake get as far as it can.
 *
 * Macrotasks too, not only microtasks: reading the token response body is a
 * real async read, so a microtask-only flush stops before the socket is built
 * and every assertion here would be measuring the flush.
 */
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('a bridge stopped mid-handshake (SRS-ABR-001)', () => {
  it('opens no socket when it is stopped before the token lookup returns', async () => {
    const bridge = new AgentBridge();
    void bridge.start();
    await flush();
    expect(made, 'the dial should still be waiting on the token').toEqual([]);

    bridge.stop();
    releaseToken?.();
    await flush();

    expect(made.length, 'a stopped bridge opened a socket anyway').toBe(0);
  });

  it('opens one when it is not stopped, so the test above is not vacuous', async () => {
    // The control. Without it, "opened nothing" would pass just as well against
    // a stub that never opens anything at all.
    const bridge = new AgentBridge();
    void bridge.start();
    await flush();
    releaseToken?.();
    await flush();

    expect(made).toHaveLength(1);
    expect(made[0].url).toContain('127.0.0.1:5199');
    bridge.stop();
  });

  it('does not announce a socket the instance no longer owns', async () => {
    const bridge = new AgentBridge();
    void bridge.start();
    await flush();
    releaseToken?.();
    await flush();
    expect(made).toHaveLength(1);
    const socket = made[0];

    // The socket opens AFTER the planner has switched the bridge off, which is
    // the order that produced the self-displacement.
    bridge.stop();
    socket.onopen?.();

    expect(socket.sent, 'a disowned socket said hello').toEqual([]);
    expect(socket.closed, 'a disowned socket was left open').toBe(true);
  });

  it('announces a socket it does own, so the guard is not simply off', async () => {
    const bridge = new AgentBridge();
    void bridge.start();
    await flush();
    releaseToken?.();
    await flush();
    const socket = made[0];

    socket.readyState = 1; // OPEN, so `send` is permitted
    socket.onopen?.();

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]).type).toBe('hello');
    bridge.stop();
  });
});
