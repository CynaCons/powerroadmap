#!/usr/bin/env node
/**
 * PowerRoadmap Web Agent Bridge — MCP server.
 *
 * One process, two faces:
 *   - an MCP stdio server, spawned by the agent host via .mcp.json;
 *   - a WebSocket server bound to LOOPBACK ONLY, which the browser page
 *     connects out to.
 *
 * SEVERAL AGENTS (SRS-ABR-070). One MCP server process is spawned per agent
 * session, so several of them race for the same port. The winner becomes the
 * HUB and owns the single page connection; the losers become PEERS and forward
 * their tool calls to the hub over that same loopback port. Exactly one socket
 * reaches the page, so the page needs no notion of multiple servers, and there
 * is one obvious place to hold the lease.
 *
 * Agents may connect freely but may not write concurrently: the hub hands out a
 * lease, held for a call and for a short idle grace after it (SRS-ABR-071). A
 * refused agent is told who holds it and when to retry. Read-only tools bypass
 * the lease, because looking while someone writes is harmless and refusing it
 * would leave a blocked agent unable to find out why (SRS-ABR-072).
 *
 * It is a relay with schemas. It deliberately holds NO document state: the
 * browser's Zustand store is the single source of truth, which is the property
 * that makes agent edits and user edits incapable of desyncing
 * (spec/srs-web/SRS-agent-bridge.md SRS-ABR-010).
 *
 * Scope: the web app only. The native add-in has its own agent surface.
 */

import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { FrameReader, encodeFrame, OPCODE } from './frames.mjs';
const PROTOCOL_VERSION = 1;
const PORT = Number(process.env.POWERPLANNER_BRIDGE_PORT ?? 5199);
const CALL_TIMEOUT_MS = Number(process.env.POWERPLANNER_BRIDGE_TIMEOUT_MS ?? 5000);
const TOKEN_FILE = resolve(process.cwd(), '.powerplanner-bridge.json');

/**
 * Origins allowed to open a bridge socket.
 *
 * WebSocket handshakes are NOT subject to CORS, so without this any page the
 * user has open could connect and start editing their document
 * (SRS-ABR-040). Browsers set `Origin` themselves and pages cannot forge it —
 * which is exactly the attacker this defends against. It does not defend
 * against local code running as the user; that is out of scope by design.
 */
const ALLOWED_ORIGINS = new Set(
  (process.env.POWERPLANNER_BRIDGE_ORIGINS ?? 'http://localhost:5180,http://127.0.0.1:5180')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
);

const SESSION_TOKEN = randomBytes(32).toString('hex');

/** This process's id, used only to arbitrate the lease between processes. */
const AGENT_ID = randomBytes(4).toString('hex');

/**
 * The agent's own name, when its environment gives one. Never invented: a
 * generated name changes on every restart, so one agent that reconnects would
 * show up to the planner as a crowd of strangers.
 */
const ENV_AGENT_NAME = (() => {
  const raw = (process.env.POWERPLANNER_AGENT_NAME ?? '').trim();
  if (!raw) return null;
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(raw)) {
    process.stderr.write(
      `[powerplanner-bridge] POWERPLANNER_AGENT_NAME "${raw}" is not a valid name ` +
        '(^[a-z0-9][a-z0-9._-]{0,39}$); ignoring it.\n',
    );
    return null;
  }
  return raw;
})();

/** How this process is listed to other processes and in get_status. */
const AGENT_LABEL = ENV_AGENT_NAME ?? `unnamed-${AGENT_ID}`;

/** How long after its last call a lease survives, so a turn of several batches is atomic. */
const LOCK_IDLE_MS = Number(process.env.POWERPLANNER_LOCK_IDLE_MS ?? 10_000);
/** After this, a holder yields at its next call boundary — but only if someone waits. */
const LOCK_MAX_HOLD_MS = Number(process.env.POWERPLANNER_LOCK_MAX_HOLD_MS ?? 120_000);

/**
 * Tools that only look. They bypass the lease (SRS-ABR-072): a blocked agent
 * must still be able to read, and above all to call `get_status` and find out
 * what it is blocked on.
 */
const READ_ONLY = new Set(['get_status', 'get_document', 'get_view', 'get_render']);

/** When this process came up, so presence can say how long an agent has been there. */
const STARTED_AT = Date.now();

/** 'starting' until the port race is settled, then 'hub' or 'peer'. */
let mode = 'starting';
/** Set when startup failed for a reason the planner has to fix. */
let startupError = null;

/* ------------------------------------------------------------------ */
/* Tool surface                                                        */
/* ------------------------------------------------------------------ */

const DOC_OP_SCHEMA = {
  type: 'object',
  description: 'A single document operation. See spec/srs-web/SRS-agent-bridge.md.',
  properties: { op: { type: 'string' } },
  required: ['op'],
  additionalProperties: true,
};

const TOOLS = [
  {
    name: 'get_status',
    description:
      'Bridge and document status: whether a plan is attached, which agents are on the bridge, who holds the write lease and for how much longer, plus the document title, revision and entity counts. Answers even when nothing is attached and even while another agent holds the lease, so it is always the way to find out what is going on. Call it first — it distinguishes "nothing connected" from "connected to an empty plan".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_document',
    description:
      'The full GanttDocument as canonical JSON. Reason over this, not over screenshots.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_view',
    description:
      'What the person can actually SEE: the visible date window, px/day, time scale, the grid and weekend settings, the selection, ' +
      'the chart area in pixels, and a census of how many elements of each kind are on screen versus off it (above, below, before or after the view). ' +
      '`warnings` names anything a person would notice and you would not — every marker off screen, a plot taller than its window. ' +
      'The document saying a thing exists is not the same as the user being able to see it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_render',
    description:
      'A PICTURE of the chart as it is on screen right now, returned as a PNG you can look at, plus the same view summary get_view gives. ' +
      'Call it after authoring to check your work the way the user will see it — colours, crowding, truncated names, things that do not fit. ' +
      'The raster carries the page background and the resolved theme colours, so it looks like the app and not like black text on nothing. ' +
      'Does not download a file. If rasterising is refused the reply says why in `pngError` instead of silently handing you markup.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'apply_batch',
    description:
      'Apply an ordered list of document operations as ONE undo frame. All-or-nothing: if any operation is invalid, nothing is applied. This is the primary way to author a chart — prefer one batch over many single calls, so the user can revert your whole turn with a single Ctrl+Z.\n\n' +
      'Operations: set_title, set_scale, set_fiscal_year_start, set_theme, ' +
      'set_grid_delimiter (none|day|week|month|quarter), set_weekend_display (off|shaded), ' +
      'set_allow_overlap, set_style_preset, ' +
      'add_row/update_row/delete_row, add_task/update_task/delete_task, ' +
      'add_milestone/update_milestone/delete_milestone, ' +
      'add_bracket/update_bracket/delete_bracket, ' +
      'add_dependency/update_dependency/delete_dependency, ' +
      'add_marker/update_marker/delete_marker, delete_items, capture_baseline, clear_baseline.\n\n' +
      'Use delete_items to clear a whole selection at once. A batch of single deletes CANNOT do it: ' +
      'delete_task already removes that task’s dependencies, so a dependency named later in the same ' +
      'batch aborts the whole batch and nothing is deleted.\n\n' +
      'Example: {"ops":[{"op":"add_row","row":{"id":"r1","label":"Design","groupId":null}},' +
      '{"op":"add_task","task":{"id":"t1","rowId":"r1","label":"Wireframes","start":"2026-03-02","end":"2026-03-16"}}]}\n\n' +
      'Ids must be supplied and unique. Dates are ISO (YYYY-MM-DD). Later ops may ' +
      'depend on entities created by earlier ops in the same batch.',
    inputSchema: {
      type: 'object',
      properties: {
        ops: { type: 'array', items: DOC_OP_SCHEMA, description: 'Ordered operations to apply.' },
        expectedRevision: {
          type: 'number',
          description:
            'Optional optimistic-concurrency check. Omit unless you need atomicity against concurrent user edits — supplying it makes the call fail if the user touched anything.',
        },
      },
      required: ['ops'],
      additionalProperties: false,
    },
  },
  {
    name: 'new_document',
    description: 'Replace the document with a blank plan. Use this before authoring from scratch — the app boots with sample data.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'undo',
    description: 'Undo the last change.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'redo',
    description: 'Redo the last undone change.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_viewport',
    description:
      'Move the view: the left-hand date, the zoom in px/day, and how far down the plan is scrolled. ' +
      'scrollY is the one that answers the "N tasks are off screen (N below)" report from get_view — without it that report is a diagnosis with no remedy. ' +
      'Clamped to what is actually drawn. Changes no document state and makes no undo frame. Returns the view after the frame has painted.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'ISO date for the left edge of the plot.' },
        pxPerDay: { type: 'number', description: 'Zoom. Clamped to the range the app allows.' },
        scrollY: { type: 'number', description: 'Pixels scrolled down the plan. 0 is the top.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reveal',
    description:
      'Scroll a row into view by id. Prefer this over set_viewport.scrollY after writing to a row: the app does the arithmetic, so it lands correctly whatever the height of the plan and of the window. Makes no undo frame.',
    inputSchema: {
      type: 'object',
      properties: { rowId: { type: 'string' } },
      required: ['rowId'],
      additionalProperties: false,
    },
  },
  {
    name: 'fit_to_tasks',
    description: 'Fit the viewport to the full date range of the document.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'select',
    description: 'Set the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              // Every kind `SelectableKind` admits. 'row' was missing, so an agent
              // could not select the one thing a planner selects most — and the
              // schema refused the call before the page ever saw it.
              kind: { type: 'string', enum: ['task', 'milestone', 'bracket', 'dependency', 'marker', 'row'] },
              id: { type: 'string' },
            },
            required: ['kind', 'id'],
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
];

const MUTATING = new Set(['apply_batch', 'new_document', 'undo', 'redo']);

/* ------------------------------------------------------------------ */
/* WebSocket (RFC 6455, minimal server-side implementation)            */
/* ------------------------------------------------------------------ */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * The one page the bridge drives, or null.
 *
 * A set with a `clientId` argument was the first design (SRS-ABR-005), and it
 * made the agent answer a question only the planner can: which of their open
 * tabs they are looking at. A stale tab from an earlier session is a perfectly
 * valid choice by every test the server can apply. Newest connection wins
 * instead, and the one it displaces is told to stand down (SRS-ABR-007).
 *
 * @type {{socket: import('node:net').Socket, id: string, meta: object, lastSeen: number} | null}
 */
let page = null;
/** Other MCP processes forwarding through this one. @type {Map<object, {agentId: string, label: string, connectedAt: number}>} */
const peers = new Map();
let nextCallId = 1;
/** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
const pending = new Map();

/**
 * The lease. `inFlight` is what stops it expiring underneath a slow call: a
 * render rasterises before it can answer, and an idle-only timer would hand the
 * plan to someone else in the middle of one.
 */
let lock = { holder: null, label: null, inFlight: 0, idleUntil: 0, since: 0 };
/** agentIds waiting, oldest first. Reported, so a blocked agent knows where it stands. */
const waiting = [];

class Locked extends Error {}

function releaseLock(why) {
  if (!lock.holder) return;
  log(`lock released by ${lock.label} (${why})`);
  lock = { holder: null, label: null, inFlight: 0, idleUntil: 0, since: 0 };
}

/**
 * Expiry is evaluated on use rather than on a timer: a timer that fires while
 * nothing is happening tells us nothing, and one that fires mid-call would be
 * wrong anyway.
 */
function currentHolder(now = Date.now()) {
  if (lock.holder && lock.inFlight === 0 && now > lock.idleUntil) releaseLock('idle');
  return lock.holder;
}

function lockStatus(now = Date.now()) {
  const holder = currentHolder(now);
  return {
    held: !!holder,
    holder: holder ? lock.label : null,
    retryAfterMs: holder ? Math.max(0, lock.idleUntil - now) : 0,
    heldForMs: holder ? now - lock.since : 0,
    waiting: waiting.length,
  };
}

/** Grants the lease, or explains who has it and for how much longer. */
function acquireLock(agentId, label) {
  const now = Date.now();
  const holder = currentHolder(now);

  if (holder && holder !== agentId) {
    if (!waiting.includes(agentId)) waiting.push(agentId);
    const st = lockStatus(now);
    throw new Locked(
      `Another agent is editing this plan. "${st.holder}" holds it and has been working for ` +
        `${Math.round(st.heldForMs / 1000)}s; it frees up after about ` +
        `${Math.ceil(st.retryAfterMs / 1000)}s of inactivity. Do other work and retry, or call ` +
        `get_status to check. You are queued at position ${waiting.indexOf(agentId) + 1}.`,
    );
  }

  // A long holder yields at a call boundary, but only when someone is actually
  // waiting — otherwise a long solo task would interrupt itself for nothing.
  if (holder === agentId && now - lock.since > LOCK_MAX_HOLD_MS && waiting.length > 0) {
    const n = waiting.length;
    releaseLock('max hold reached with agents waiting');
    throw new Locked(
      `You have held this plan for over ${Math.round(LOCK_MAX_HOLD_MS / 1000)}s and ${n} ` +
        'agent(s) are waiting, so the lease was handed on. Retry to queue for it again.',
    );
  }

  const queued = waiting.indexOf(agentId);
  if (queued >= 0) waiting.splice(queued, 1);

  if (!holder) {
    lock = { holder: agentId, label, inFlight: 0, idleUntil: now + LOCK_IDLE_MS, since: now };
    log(`lock acquired by ${label}`);
  }
  lock.inFlight += 1;
  return function release() {
    lock.inFlight = Math.max(0, lock.inFlight - 1);
    lock.idleUntil = Date.now() + LOCK_IDLE_MS;
  };
}

/** Fail every call in flight now, rather than letting each one time out. */
function rejectPending(message) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(bridgeFailure('NO_CLIENT', message));
  }
}

function log(...parts) {
  // stdout is the MCP transport; every log goes to stderr.
  process.stderr.write(`[powerplanner-bridge] ${parts.join(' ')}\n`);
}

function tokenMatches(provided) {
  const a = createHash('sha256').update(String(provided ?? '')).digest();
  const b = createHash('sha256').update(SESSION_TOKEN).digest();
  return timingSafeEqual(a, b);
}

const httpServer = createServer((req, res) => {
  // The bridge speaks WebSocket only; no HTTP surface to probe.
  res.writeHead(404).end();
});

/**
 * True when the request comes from a page that could not have been given a
 * token (SRS-ABR-044).
 *
 * A single-file build opened from disk has an opaque origin — browsers send
 * `Origin: null`, or omit it — and there is no same-origin server to serve a
 * token from, which SRS-ABR-042 requires. An MCP peer process sends no Origin
 * either, and local code running as the planner is outside the threat model by
 * SRS-ABR-043. What is still refused is a page on a real origin that is not
 * allowed: that is the attacker SRS-ABR-040 names.
 */
function cannotHoldToken(origin) {
  return origin === undefined || origin === 'null' || origin === '';
}

httpServer.on('upgrade', (req, socket) => {
  const origin = req.headers.origin;
  const tokenless = cannotHoldToken(origin);
  if (!tokenless && !ALLOWED_ORIGINS.has(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const client = { socket, id: null, meta: {}, lastSeen: Date.now(), tokenless, kind: null };

  // Fragmentation, masking and control frames are the codec's problem;
  // see mcp/agent-bridge/frames.mjs for why that is a module of its own.
  const reader = new FrameReader();

  socket.on('data', (chunk) => {
    for (const action of reader.push(chunk)) {
      if (action.type === 'close') {
        socket.end();
        return;
      }
      if (action.type === 'pong') {
        socket.write(encodeFrame(action.payload, OPCODE.pong));
        continue;
      }
      handleClientMessage(client, action.text, socket);
    }
  });

  const drop = () => dropConnection(client);
  socket.on('close', drop);
  socket.on('error', drop);
});

function dropConnection(client) {
  if (client.kind === 'peer') {
    const info = peers.get(client);
    peers.delete(client);
    if (info) {
      // A peer that goes away must not keep the plan leased.
      if (lock.holder === info.agentId) releaseLock('peer disconnected');
      const queued = waiting.indexOf(info.agentId);
      if (queued >= 0) waiting.splice(queued, 1);
      log(`peer "${info.label}" disconnected; ${peers.size} peer(s)`);
    }
    pushAgents();
    return;
  }
  if (page === client) {
    page = null;
    // The plan going away invalidates any lease over it.
    releaseLock('page disconnected');
    log('page disconnected');
  }
}

function handleClientMessage(client, raw, socket) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  // A peer MCP process announces itself before anything else; the page says
  // 'hello'. Both arrive on the same port, which is the whole point of the
  // election (SRS-ABR-070).
  if (message.type === 'peer-hello') {
    client.kind = 'peer';
    peers.set(client, {
      agentId: String(message.agentId ?? '').slice(0, 32),
      label: String(message.label ?? 'unnamed'),
      connectedAt: Date.now(),
    });
    log(`peer "${message.label}" connected; ${peers.size} peer(s)`);
    socket.write(encodeFrame(JSON.stringify({ type: 'peer-welcome', hub: AGENT_LABEL })));
    pushAgents();
    return;
  }

  if (client.kind === 'peer' && message.type === 'peer-request') {
    void handlePeerRequest(client, message);
    return;
  }

  if (message.type === 'hello') {
    // A page that could have been handed a token must present the right one; a
    // page that could not is admitted without one (SRS-ABR-044).
    if (!client.tokenless && !tokenMatches(message.token)) {
      socket.write(encodeFrame(JSON.stringify({ type: 'event', kind: 'bye', reason: 'bad token' })));
      socket.end();
      return;
    }
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      socket.write(
        encodeFrame(JSON.stringify({ type: 'event', kind: 'bye', reason: 'protocol version mismatch' })),
      );
      socket.end();
      return;
    }
    client.kind = 'page';
    client.id = message.clientId;
    client.meta = { href: message.href, title: message.title, revision: message.revision };
    client.lastSeen = Date.now();
    adoptPage(client);
    return;
  }

  if (message.type === 'result') {
    client.lastSeen = Date.now();
    const waiter = pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    waiter.resolve(message);
    return;
  }

  if (message.type === 'event' && message.kind === 'bye') {
    dropConnection(client);
    socket.end();
  }
}

/**
 * Make this page the one the bridge drives, displacing any previous one
 * (SRS-ABR-007).
 *
 * The stand-down frame goes out BEFORE the close. Without it the displaced
 * page's reconnect backoff fires, it displaces this one in turn, and the two
 * trade the connection indefinitely while each call lands in whichever page
 * happens to hold it — which is how writes reached the wrong document.
 */
function adoptPage(client) {
  const previous = page;
  page = client;
  log(`hello from ${client.meta.title || 'a plan'} (${client.id})`);

  if (!previous || previous === client) {
    pushAgents();
    return;
  }

  log('a second page connected; displacing the previous one');
  try {
    previous.socket.write(
      encodeFrame(
        JSON.stringify({
          type: 'displaced',
          reason: 'Another plan connected to the agent bridge.',
        }),
      ),
    );
  } catch (err) {
    log('could not notify the displaced page:', err?.message ?? String(err));
  }
  previous.socket.end();
  releaseLock('page displaced');
  rejectPending(
    'The plan this call was sent to was displaced by another connection. Retry.',
  );
  pushAgents();
}

/** Who is attached, as the page should show it (SRS-ABR-073). */
function agentsFrame() {
  const agents = [{ label: AGENT_LABEL, role: 'hub', connectedAt: STARTED_AT }];
  for (const info of peers.values()) {
    agents.push({ label: info.label, role: 'peer', connectedAt: info.connectedAt });
  }
  return { type: 'agents', agents };
}

function pushAgents() {
  if (!page) return;
  try {
    page.socket.write(encodeFrame(JSON.stringify(agentsFrame())));
  } catch (err) {
    log('could not push the agents frame:', err?.message ?? String(err));
  }
}

/** A peer's tool call, run here with the peer's identity holding the lease. */
async function handlePeerRequest(client, message) {
  const info = peers.get(client) ?? { agentId: 'unknown', label: 'unnamed' };
  const reply = (body) => {
    try {
      client.socket.write(
        encodeFrame(JSON.stringify({ type: 'peer-response', reqId: message.reqId, ...body })),
      );
    } catch (err) {
      log('could not answer a peer:', err?.message ?? String(err));
    }
  };
  try {
    const result = await runTool(message.name, message.args, info.agentId, info.label);
    reply({ ok: true, result });
  } catch (err) {
    reply({
      ok: false,
      error: {
        code: err instanceof Locked ? 'LOCKED' : (err.bridgeCode ?? 'VALIDATION_FAILED'),
        message: err.message,
      },
    });
  }
}

/**
 * The page a call targets (SRS-ABR-004/007).
 *
 * The message names the route that connects one. The old text said "switch the
 * Agent toggle on", which named a header button that production builds did not
 * have — an instruction an agent could not follow (SRS-ABR-066).
 */
function pickClient(requestedId) {
  if (!page) {
    throw bridgeFailure(
      'NO_CLIENT',
      'No PowerRoadmap plan is connected. Open your plan, then turn on ' +
        'Settings \u2192 Agent bridge \u2192 "Let a local agent edit this plan".',
    );
  }
  if (requestedId && page.id !== requestedId) {
    throw bridgeFailure(
      'UNKNOWN_ID',
      `The connected plan is '${page.id}', not '${requestedId}'. The newest page to ` +
        'connect is the one the bridge drives; there is never more than one.',
    );
  }
  return page;
}

function bridgeFailure(code, message) {
  const err = new Error(message);
  err.bridgeCode = code;
  return err;
}

function callClient(method, params, opId, clientId) {
  const client = pickClient(clientId);
  const id = nextCallId++;
  const payload = { type: 'call', id, method, params };
  if (opId) payload.opId = opId;

  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // Retry is safe only with the same opId; the page replays rather than
      // re-applying (SRS-ABR-023/024).
      rejectPromise(
        bridgeFailure(
          'TIMEOUT',
          `No response within ${CALL_TIMEOUT_MS}ms. Safe to retry with the same opId ('${opId ?? 'none'}').`,
        ),
      );
    }, CALL_TIMEOUT_MS);

    pending.set(id, { resolve: resolvePromise, timer });
    try {
      client.socket.write(encodeFrame(JSON.stringify(payload)));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      rejectPromise(err);
    }
  });
}

/* ------------------------------------------------------------------ */
/* MCP stdio                                                           */
/* ------------------------------------------------------------------ */

function writeMcp(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function mcpResult(id, result) {
  writeMcp({ jsonrpc: '2.0', id, result });
}

/**
 * Send a tool result.
 *
 * A `png` field is lifted out into an MCP image block rather than printed as
 * base64 (SRS-ABR-034). Everything used to go back as one text block, which
 * meant an agent asking to see the chart received SVG source to read — it could
 * reason about the markup but it could not look at the picture, and the two are
 * not the same thing when the question is "does this chart read well".
 *
 * The `svg` field is dropped from the text alongside it: it is tens of
 * kilobytes of markup that nothing downstream parses, and sending both the
 * image and its source doubles the cost of every render for no gain. It stays
 * available through the bridge for a caller that wants the markup itself.
 */
function mcpToolText(id, payload, isError = false) {
  const content = [];
  let rest = payload;

  if (payload && typeof payload === 'object' && typeof payload.png === 'string') {
    content.push({ type: 'image', data: payload.png, mimeType: 'image/png' });
    const { png, svg, ...others } = payload;
    rest = { ...others, svgBytes: typeof svg === 'string' ? svg.length : 0 };
  } else if (payload && typeof payload === 'object' && typeof payload.svg === 'string') {
    // Rasterising was refused; say so where the agent is looking, so a missing
    // picture cannot be mistaken for a chart that renders as nothing.
    const { svg, ...others } = payload;
    rest = { ...others, svgBytes: svg.length };
  }

  content.push({
    type: 'text',
    text: typeof rest === 'string' ? rest : JSON.stringify(rest, null, 2),
  });
  mcpResult(id, { content, isError });
}

/**
 * Re-assert ownership of the token file.
 *
 * Several bridges can exist over a machine's lifetime — an e2e run spawns its
 * own, and on Windows a killed process never runs its exit cleanup, so a dead
 * bridge's token can outlive it and shadow a live one. Rather than trying to
 * make cleanup reliable, the live server simply re-writes the file whenever it
 * is asked to do work. Self-healing beats coordinated shutdown.
 */
function ensureTokenFileOwned() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const current = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
      if (current.pid === process.pid && current.token === SESSION_TOKEN) return;
    }
    writeTokenFile();
  } catch {
    writeTokenFile();
  }
}

function writeTokenFile() {
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify({ token: SESSION_TOKEN, port: PORT, pid: process.pid }, null, 2));
  } catch {
    /* non-fatal: the page will report the token endpoint failure */
  }
}

/** What this process knows about the bridge without asking the page. */
function bridgeFacts() {
  return {
    bridge: {
      me: AGENT_LABEL,
      role: mode,
      port: PORT,
      agents: agentsFrame().agents,
      lease: lockStatus(),
    },
  };
}

/**
 * Run a tool on this process, holding `agentId`'s lease while it runs.
 *
 * Called directly for this process's own agent, and through `handlePeerRequest`
 * for every other MCP process, so both travel one path and one lease
 * (SRS-ABR-070/071).
 *
 * Returns the payload an agent should see, or throws `Locked` / a bridge
 * failure.
 */
async function runTool(name, args, agentId, label) {
  const { clientId, opId: callerOpId, ...params } = args ?? {};

  // `get_status` is the one tool that must answer whatever is happening: with
  // no plan attached, and while someone else holds the lease (SRS-ABR-072).
  if (name === 'get_status' && !page) {
    return { ...bridgeFacts(), connected: false };
  }

  const readOnly = READ_ONLY.has(name);
  const release = readOnly ? null : acquireLock(agentId, label);
  try {
    // Mutating calls always carry an idempotency key so a timeout is recoverable.
    const opId = MUTATING.has(name)
      ? (callerOpId ?? `op-${randomBytes(8).toString('hex')}`)
      : undefined;

    const response = await callClient(name, params, opId, clientId);
    if (!response.ok) {
      throw bridgeFailure(
        response.error?.code ?? 'VALIDATION_FAILED',
        response.error?.message ?? 'unknown error',
      );
    }
    return {
      ...(typeof response.data === 'object' && response.data !== null
        ? response.data
        : { result: response.data }),
      ...(name === 'get_status' ? bridgeFacts() : {}),
      revision: response.revision,
      userEditedSince: response.userEditedSince,
      ...(response.replayed ? { replayed: true } : {}),
      ...(opId ? { opId } : {}),
    };
  } finally {
    if (release) release();
  }
}

async function handleToolCall(id, name, args) {
  ensureTokenFileOwned();
  if (startupError) {
    mcpToolText(id, { error: 'NO_CLIENT', message: startupError }, true);
    return;
  }
  const known = TOOLS.some((t) => t.name === name);
  if (!known) {
    mcpToolText(id, `Unknown tool: ${name}`, true);
    return;
  }

  try {
    const payload = mode === 'peer' ? await askHub(name, args) : await runTool(name, args, AGENT_ID, AGENT_LABEL);
    mcpToolText(id, payload);
  } catch (err) {
    mcpToolText(
      id,
      {
        error: err instanceof Locked ? 'LOCKED' : (err.bridgeCode ?? 'VALIDATION_FAILED'),
        message: err.message,
      },
      true,
    );
  }
}

let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let index;
  while ((index = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, index).trim();
    stdinBuffer = stdinBuffer.slice(index + 1);
    if (!line) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }

    switch (request.method) {
      case 'initialize':
        mcpResult(request.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'powerplanner-web-bridge', version: '1.0.0' },
        });
        break;
      case 'tools/list':
        mcpResult(request.id, { tools: TOOLS });
        break;
      case 'tools/call':
        void handleToolCall(request.id, request.params?.name, request.params?.arguments);
        break;
      case 'notifications/initialized':
        break;
      default:
        if (request.id !== undefined) {
          writeMcp({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: `Method not found: ${request.method}` },
          });
        }
    }
  }
});

/* ------------------------------------------------------------------ */
/* Peer mode: forward everything to the hub                            */
/* ------------------------------------------------------------------ */

/** @type {import('node:net').Socket | null} */
let hubSocket = null;
let nextPeerReq = 1;
/** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
const peerPending = new Map();

function rejectPeerPending(message) {
  for (const [reqId, entry] of peerPending) {
    clearTimeout(entry.timer);
    peerPending.delete(reqId);
    entry.reject(bridgeFailure('NO_CLIENT', message));
  }
}

/**
 * Open a WebSocket to the hub by hand.
 *
 * There is no `ws` dependency in this project and the frame codec next door
 * already does both directions, so the client handshake is 20 lines here rather
 * than a package. Client frames must be masked (RFC 6455 §5.1), which is
 * what `encodeFrame`'s `mask` option is for.
 */
function connectToHub() {
  const key = randomBytes(16).toString('base64');
  const expected = createHash('sha1').update(key + WS_GUID).digest('base64');
  const socket = connect(PORT, '127.0.0.1', () => {
    socket.write(
      `GET /agent HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${PORT}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );
  });

  let upgraded = false;
  let buffer = Buffer.alloc(0);
  const reader = new FrameReader();

  socket.on('data', (chunk) => {
    if (!upgraded) {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const head = buffer.subarray(0, headerEnd).toString('latin1');
      if (!head.includes('101') || !head.includes(expected)) {
        log('hub refused the peer handshake; retrying as a candidate hub');
        socket.destroy();
        return;
      }
      upgraded = true;
      hubSocket = socket;
      mode = 'peer';
      startupError = null;
      send({ type: 'peer-hello', agentId: AGENT_ID, label: AGENT_LABEL });
      log(`peer: joined the hub on 127.0.0.1:${PORT} as "${AGENT_LABEL}"`);
      chunk = buffer.subarray(headerEnd + 4);
      buffer = Buffer.alloc(0);
      if (chunk.length === 0) return;
    }

    for (const action of reader.push(chunk)) {
      if (action.type === 'close') {
        socket.end();
        return;
      }
      if (action.type === 'pong') {
        socket.write(encodeFrame(action.payload, OPCODE.pong, { mask: true }));
        continue;
      }
      let message;
      try {
        message = JSON.parse(action.text);
      } catch {
        continue;
      }
      if (message.type !== 'peer-response') continue;
      const entry = peerPending.get(message.reqId);
      if (!entry) continue;
      clearTimeout(entry.timer);
      peerPending.delete(message.reqId);
      entry.resolve(message);
    }
  });

  function send(payload) {
    socket.write(encodeFrame(JSON.stringify(payload), OPCODE.text, { mask: true }));
  }
  socket.sendJson = send;

  const gone = () => {
    if (hubSocket !== socket) return;
    hubSocket = null;
    rejectPeerPending('The agent hub went away. Retrying.');
    // The hub's process exited, so the port is free again. Whoever gets there
    // first becomes the new hub and everyone else re-joins it; the jitter stops
    // every peer racing on the same tick.
    setTimeout(() => void start(), 250 + Math.floor(Math.random() * 500));
  };
  socket.on('close', gone);
  socket.on('error', gone);
}

/** Forward a tool call to the hub and wait for its answer. */
function askHub(name, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!hubSocket) {
      rejectPromise(bridgeFailure('NO_CLIENT', 'Not joined to the agent hub yet. Retry in a moment.'));
      return;
    }
    const reqId = nextPeerReq++;
    // The hub applies its own per-call budget; this one only has to outlast it.
    const timer = setTimeout(() => {
      peerPending.delete(reqId);
      rejectPromise(bridgeFailure('TIMEOUT', `The agent hub did not answer "${name}" in time.`));
    }, CALL_TIMEOUT_MS * 3);
    peerPending.set(reqId, {
      resolve: (message) => {
        if (message.ok) resolvePromise(message.result);
        else {
          const err = new Error(message.error?.message ?? 'unknown error');
          err.bridgeCode = message.error?.code ?? 'VALIDATION_FAILED';
          rejectPromise(err);
        }
      },
      reject: rejectPromise,
      timer,
    });
    hubSocket.sendJson({ type: 'peer-request', reqId, name, args });
  });
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function cleanup() {
  try {
    unlinkSync(TOKEN_FILE);
  } catch {
    /* already gone */
  }
}

/**
 * Own the port, or join whoever already does (SRS-ABR-070).
 *
 * EADDRINUSE used to kill the process, which meant the second agent of a
 * session simply had no bridge: one MCP server is spawned per agent, so two
 * agents always race for a fixed port. Dying also lost the MCP transport, so
 * anything waiting on `initialize` never heard back and could not tell that
 * from a bridge that was merely slow.
 */
function start() {
  return new Promise((resolveStart) => {
    const onError = (err) => {
      httpServer.removeListener('error', onError);
      if (err.code === 'EADDRINUSE') {
        log(`port ${PORT} is held by another bridge; joining it as a peer`);
        connectToHub();
        resolveStart();
        return;
      }
      startupError =
        `Could not start the agent bridge on 127.0.0.1:${PORT}: ${err.message}. ` +
        'Set POWERPLANNER_BRIDGE_PORT to a free port.';
      log(`cannot listen: ${startupError}`);
      resolveStart();
    };
    httpServer.once('error', onError);

    // Loopback only, never a wildcard address (SRS-ABR-002).
    httpServer.listen(PORT, '127.0.0.1', () => {
      httpServer.removeListener('error', onError);
      mode = 'hub';
      startupError = null;
      writeTokenFile();
      log(`hub: listening on 127.0.0.1:${PORT} as "${AGENT_LABEL}"`);
      resolveStart();
    });
  });
}

void start();

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
