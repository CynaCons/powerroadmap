import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFrame, FrameReader, OPCODE } from '../../mcp/agent-bridge/frames.mjs';

/**
 * The bridge server's topology, driven as two real processes (SRS-ABR-070/071).
 *
 * This is an integration test on purpose: hub election, the lease and
 * displacement are all properties of how several processes and a page behave
 * towards each other, and none of them is observable from inside one module.
 * The page is a hand-rolled WebSocket client here, which also exercises the
 * client-side masking `encodeFrame` grew for peer mode — if that were wrong,
 * every test in this file would hang rather than quietly pass.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = resolve(REPO_ROOT, 'mcp/agent-bridge/server.mjs');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Well clear of the dev server, the e2e bridges and anything else in the repo. */
let nextPort = 5401;
const portFor = () => nextPort++;

interface Server {
  proc: ChildProcessWithoutNullStreams;
  stderr: () => string;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
}

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.proc.kill();
  for (const s of sockets.splice(0)) s.destroy();
});

function startServer(port: number, label: string): Server {
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      POWERPLANNER_BRIDGE_PORT: String(port),
      POWERPLANNER_AGENT_NAME: label,
      POWERPLANNER_BRIDGE_TIMEOUT_MS: '4000',
      POWERPLANNER_LOCK_IDLE_MS: '1500',
    },
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let err = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => { err += chunk; });

  let out = '';
  let nextId = 1;
  const waiters = new Map<number, (value: { text: string; isError: boolean }) => void>();
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    out += chunk;
    let index: number;
    while ((index = out.indexOf('\n')) !== -1) {
      const line = out.slice(0, index).trim();
      out = out.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line) as {
        id?: number;
        result?: { content?: Array<{ text?: string }>; isError?: boolean };
      };
      const waiter = message.id !== undefined ? waiters.get(message.id) : undefined;
      if (!waiter) continue;
      waiters.delete(message.id as number);
      const text = (message.result?.content ?? []).map((c) => c.text ?? '').join('');
      waiter({ text, isError: message.result?.isError === true });
    }
  });

  const server: Server = {
    proc,
    stderr: () => err,
    call(name, args = {}) {
      const id = nextId++;
      return new Promise((resolvePromise) => {
        waiters.set(id, resolvePromise);
        proc.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n',
        );
      });
    },
  };
  servers.push(server);
  return server;
}

/** Resolve once `probe` returns true, or fail loudly after `ms`. */
async function until(probe: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface FakePage {
  socket: Socket;
  calls: Array<{ id: number; method: string }>;
  frames: Array<Record<string, unknown>>;
  /** Answer the next call after `delayMs`, so a test can hold the lease open. */
  answer: (handler: (method: string) => unknown, delayMs?: number) => void;
  closed: () => boolean;
}

/**
 * A page, as the server sees one: dials out, says hello, serves calls.
 *
 * Sends no Origin header, which is how a portable build opened from disk
 * arrives — so every test here also exercises the tokenless admit of
 * SRS-ABR-044. The refusal side has its own test below.
 */
async function fakePage(port: number, options: { origin?: string } = {}): Promise<FakePage> {
  const key = randomBytes(16).toString('base64');
  const expected = createHash('sha1').update(key + WS_GUID).digest('base64');
  const socket = connect(port, '127.0.0.1');
  sockets.push(socket);

  const calls: FakePage['calls'] = [];
  const frames: FakePage['frames'] = [];
  let handler: ((method: string) => unknown) | null = null;
  let delay = 0;
  let upgraded = false;
  let closed = false;
  let buffer = Buffer.alloc(0);
  const reader = new FrameReader();

  const send = (payload: unknown) =>
    socket.write(encodeFrame(JSON.stringify(payload), OPCODE.text, { mask: true }));

  socket.on('close', () => { closed = true; });
  socket.on('error', () => { closed = true; });

  await new Promise<void>((resolveConnect, rejectConnect) => {
    socket.on('connect', () => {
      socket.write(
        'GET /agent HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          (options.origin ? `Origin: ${options.origin}\r\n` : '') +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    socket.on('error', rejectConnect);

    socket.on('data', (chunk: Buffer) => {
      if (!upgraded) {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const head = buffer.subarray(0, headerEnd).toString('latin1');
        if (!head.includes('101') || !head.includes(expected)) {
          rejectConnect(new Error(head.split('\r\n')[0]));
          return;
        }
        upgraded = true;
        chunk = buffer.subarray(headerEnd + 4);
        buffer = Buffer.alloc(0);
        resolveConnect();
        if (chunk.length === 0) return;
      }

      for (const action of reader.push(chunk)) {
        if (action.type === 'close') { socket.end(); return; }
        if (action.type === 'pong') continue;
        const message = JSON.parse(action.text) as Record<string, unknown>;
        frames.push(message);
        if (message.type !== 'call') continue;
        calls.push({ id: message.id as number, method: message.method as string });
        const reply = () =>
          send({
            type: 'result',
            id: message.id,
            ok: true,
            data: handler ? handler(message.method as string) : { ok: true },
            revision: 7,
            userEditedSince: false,
            replayed: false,
          });
        if (delay > 0) setTimeout(reply, delay);
        else reply();
      }
    });
  });

  send({
    type: 'hello',
    protocolVersion: 1,
    clientId: `page-${randomBytes(3).toString('hex')}`,
    href: 'file:///C:/plans/roadmap.html',
    title: 'A plan',
    revision: 7,
  });

  return {
    socket,
    calls,
    frames,
    answer(next, delayMs = 0) { handler = next; delay = delayMs; },
    closed: () => closed,
  };
}

/**
 * A tool result's text, as the agent receives it. Typed loosely on purpose: the
 * point of these tests is what the server puts in the payload, and naming a
 * shape here would only restate the assertions below in another place.
 */
const parse = (text: string) => JSON.parse(text) as Record<string, unknown> & {
  bridge: { role: string; me: string; agents: Array<{ label: string }>; lease: Record<string, unknown> };
  error?: string;
  message?: string;
};

describe('bridge server topology (SRS-ABR-070/071/072/007)', () => {
  it('answers get_status with no page attached, and says so', async () => {
    const port = portFor();
    const hub = startServer(port, 'solo');
    await until(() => hub.stderr().includes('hub: listening'), 5000, 'the hub to listen');

    const { text, isError } = await hub.call('get_status');
    const body = parse(text);
    expect(isError).toBe(false);
    expect(body.connected).toBe(false);
    expect(body.bridge.role).toBe('hub');
    expect(body.bridge.me).toBe('solo');
    expect(body.bridge.lease.held).toBe(false);
  }, 20000);

  it('names the route that connects a page when a tool needs one', async () => {
    const port = portFor();
    const hub = startServer(port, 'solo');
    await until(() => hub.stderr().includes('hub: listening'), 5000, 'the hub to listen');

    const { text, isError } = await hub.call('get_document');
    expect(isError).toBe(true);
    // The old text named a header button production builds did not have
    // (SRS-ABR-066), so the wording itself is the requirement.
    expect(parse(text).message).toContain('Settings');
    expect(parse(text).message).toContain('Agent bridge');
  }, 20000);

  it('makes a second server a peer instead of killing it', async () => {
    const port = portFor();
    const hub = startServer(port, 'first');
    await until(() => hub.stderr().includes('hub: listening'), 5000, 'the hub to listen');

    const peer = startServer(port, 'second');
    await until(() => peer.stderr().includes('joined the hub'), 5000, 'the peer to join');

    expect(peer.proc.exitCode).toBeNull();
    expect(peer.stderr()).toContain('joining it as a peer');

    // And the hub knows about it, which is what the page is told (SRS-ABR-073).
    const body = parse((await hub.call('get_status')).text);
    expect(body.bridge.agents.map((a: { label: string }) => a.label).sort()).toEqual(['first', 'second']);
  }, 25000);

  it("forwards a peer's tool call to the page and brings the answer back", async () => {
    const port = portFor();
    const hub = startServer(port, 'first');
    await until(() => hub.stderr().includes('hub: listening'), 5000, 'the hub to listen');
    const peer = startServer(port, 'second');
    await until(() => peer.stderr().includes('joined the hub'), 5000, 'the peer to join');

    const page = await fakePage(port);
    await until(() => hub.stderr().includes('hello from'), 5000, 'the page to be adopted');
    page.answer(() => ({ title: 'A plan', from: 'the page' }));

    const body = parse((await peer.call('get_document')).text);
    expect(body.from).toBe('the page');
    // One socket to the page, whichever process asked (SRS-ABR-070).
    expect(page.calls.map((c) => c.method)).toEqual(['get_document']);
  }, 25000);

  it('refuses a second agent mid-write and names who holds the plan', async () => {
    const port = portFor();
    const hub = startServer(port, 'first');
    await until(() => hub.stderr().includes('hub: listening'), 5000, 'the hub to listen');
    const peer = startServer(port, 'second');
    await until(() => peer.stderr().includes('joined the hub'), 5000, 'the peer to join');

    const page = await fakePage(port);
    await until(() => hub.stderr().includes('hello from'), 5000, 'the page to be adopted');
    // Slow enough that the second call certainly arrives while the first is in
    // flight — which is the only state this test is about.
    page.answer(() => ({ applied: 1 }), 800);

    const first = hub.call('apply_batch', { ops: [{ op: 'set_title', title: 'x' }] });
    await until(() => page.calls.length === 1, 3000, 'the first call to reach the page');

    const blocked = parse((await peer.call('apply_batch', { ops: [{ op: 'set_title', title: 'y' }] })).text);
    expect(blocked.error).toBe('LOCKED');
    expect(blocked.message).toContain('"first"');
    expect(blocked.message).toContain('queued at position 1');

    // The holder's own call still completes, and the page was asked once.
    expect(parse((await first).text).applied).toBe(1);
    expect(page.calls.filter((c) => c.method === 'apply_batch')).toHaveLength(1);
  }, 25000);

  it('lets a blocked agent still read, so it can find out why', async () => {
    const port = portFor();
    const hub = startServer(port, 'first');
    await until(() => hub.stderr().includes('hub: listening'), 5000, 'the hub to listen');
    const peer = startServer(port, 'second');
    await until(() => peer.stderr().includes('joined the hub'), 5000, 'the peer to join');

    const page = await fakePage(port);
    await until(() => hub.stderr().includes('hello from'), 5000, 'the page to be adopted');
    page.answer((method) => (method === 'get_status' ? { connected: true } : { applied: 1 }), 800);

    const first = hub.call('apply_batch', { ops: [{ op: 'set_title', title: 'x' }] });
    await until(() => page.calls.length === 1, 3000, 'the first call to reach the page');

    const status = parse((await peer.call('get_status')).text);
    expect(status.error).toBeUndefined();
    expect(status.bridge.lease.held).toBe(true);
    expect(status.bridge.lease.holder).toBe('first');
    await first;
  }, 25000);

  it('releases the lease once it has been idle, so the next agent can write', async () => {
    const port = portFor();
    const hub = startServer(port, 'first');
    await until(() => hub.stderr().includes('hub: listening'), 5000, 'the hub to listen');
    const peer = startServer(port, 'second');
    await until(() => peer.stderr().includes('joined the hub'), 5000, 'the peer to join');

    const page = await fakePage(port);
    await until(() => hub.stderr().includes('hello from'), 5000, 'the page to be adopted');
    page.answer(() => ({ applied: 1 }));

    expect(parse((await hub.call('apply_batch', { ops: [] })).text).applied).toBe(1);
    // POWERPLANNER_LOCK_IDLE_MS is 1500 for these processes.
    await new Promise((r) => setTimeout(r, 1800));

    const second = parse((await peer.call('apply_batch', { ops: [] })).text);
    expect(second.error).toBeUndefined();
    expect(second.applied).toBe(1);
  }, 25000);

  it('tells the page it displaced to stand down before closing it', async () => {
    const port = portFor();
    const hub = startServer(port, 'first');
    await until(() => hub.stderr().includes('hub: listening'), 5000, 'the hub to listen');

    const firstPage = await fakePage(port);
    await until(() => hub.stderr().includes('hello from'), 5000, 'the first page to be adopted');

    const secondPage = await fakePage(port);
    await until(() => hub.stderr().includes('displacing the previous one'), 5000, 'the displacement');

    await until(() => firstPage.frames.some((f) => f.type === 'displaced'), 3000, 'the stand-down frame');
    const frame = firstPage.frames.find((f) => f.type === 'displaced') as { reason: string };
    expect(frame.reason).toContain('Another plan connected');
    // Sent BEFORE the close, or the displaced page reconnects and the two trade
    // the connection for ever (SRS-ABR-007).
    await until(() => firstPage.closed(), 3000, 'the displaced socket to close');

    secondPage.answer(() => ({ title: 'the newcomer' }));
    expect(parse((await hub.call('get_document')).text).title).toBe('the newcomer');
  }, 25000);

  it('refuses a page whose origin is not allowed', async () => {
    const port = portFor();
    const hub = startServer(port, 'first');
    await until(() => hub.stderr().includes('hub: listening'), 5000, 'the hub to listen');

    // The control for the tokenless admit every other test in this file relies
    // on: an origin the server CAN serve a token to must still present one, and
    // a foreign origin is refused outright (SRS-ABR-040/044).
    await expect(fakePage(port, { origin: 'https://evil.example' })).rejects.toThrow(/403/);
  }, 20000);
});
