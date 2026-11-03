/**
 * Agent bridge client — the browser end of the MCP bridge.
 *
 * Connects OUT to the bridge server's loopback WebSocket, receives method
 * calls, applies them to the existing stores, and answers with results.
 *
 * Two invariants this module exists to protect:
 *
 *  - Every document mutation goes through `applyBatch`, so agent edits get the
 *    same validation, cascade, and single-history-frame semantics as any other
 *    edit (SRS-ABR-010/012/013). There is no second write path.
 *  - Nothing here is reachable unless the user turned the bridge on
 *    (SRS-ABR-001); the module is dynamically imported behind a DEV guard so it
 *    is absent from production output entirely (SRS-ABR-050).
 */

import { useDocumentStore } from '../stores/documentStore';
import { useViewportStore } from '../stores/viewportStore';
import { useSelectionStore, type Selectable } from '../stores/selectionStore';
import { validateDocument } from '../persistence/schema';
import { blankDocument } from '../embed/index';
import type { DocOp } from '../stores/docOps';
import { DocOpError } from '../stores/docOps';
// Serialising, rasterising and the on-screen census live next door so they can
// be tested without a socket; `exportSvg()` in src/persistence/fileIo.ts cannot
// be reused for any of it because it triggers a download (design review F7).
import { renderChart, viewSummary, type ViewSummary } from './feedback';
import { startDocument } from '../app/documentActions';

/** How many frames the census waits for the chart to catch up before giving up. */
const RENDER_WAIT_FRAMES = 30;

/**
 * Resolve once the chart on screen is the revision the caller just wrote.
 *
 * Scrolling and revealing are applied by a React effect in `ChartArea`, so a
 * summary taken synchronously after the store write describes the frame BEFORE
 * the move. The first version waited two animation frames for that, which is a
 * guess — and one frame short in practice. Measured by adding a task over the
 * bridge against a live page: the chart had 34 bars and the agent was told 33,
 * because React commits the store change on a scheduler callback that lands
 * after both frames. Every report therefore described the chart as it had been
 * BEFORE the edit being reported on, which is worse than no report.
 *
 * So this waits for the thing itself: `ChartArea` stamps the revision it drew
 * onto the `<svg>`, and the loop runs until that matches, then gives the
 * browser one more frame to paint it. Bounded, because a page that is never
 * going to catch up must still answer (SRS-ABR-037).
 */
export function afterPaint(expectedRevision?: number): Promise<void> {
  return new Promise((resolve) => {
    let frames = 0;
    const drawn = () => {
      const svg = document.querySelector<SVGSVGElement>('.chart-area svg');
      // No chart at all (the compact task pane, a test harness): nothing to
      // wait for, so do not spend 30 frames discovering that.
      if (!svg) return true;
      const stamped = svg.dataset.ppRevision;
      if (stamped === undefined) return true;
      return expectedRevision === undefined || Number(stamped) >= expectedRevision;
    };
    const tick = () => {
      if (drawn() || frames >= RENDER_WAIT_FRAMES) {
        // One more frame, so the geometry read is of a painted picture.
        requestAnimationFrame(() => resolve());
        return;
      }
      frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
import {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_PORT,
  type ApplyBatchParams,
  type BridgeErrorCode,
  type CallMessage,
  type ResultMessage,
  type ServerMessage,
} from './protocol';
import { useBridgeStore } from '../stores/bridgeStore';

/** Bounded replay cache for idempotent retries (SRS-ABR-023). */
const OP_CACHE_LIMIT = 128;

class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface AgentBridgeOptions {
  port?: number;
  onStatusChange?: (connected: boolean) => void;
}

export class AgentBridge {
  private socket: WebSocket | null = null;
  private closedByUser = false;
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly clientId = `client-${Math.random().toString(36).slice(2, 10)}`;
  private readonly applied = new Map<string, ResultMessage>();
  /** userRevision as of the caller's previous call, for `userEditedSince`. */
  private lastSeenUserRevision = useDocumentStore.getState().userRevision;

  constructor(private readonly options: AgentBridgeOptions = {}) {}

  async start(): Promise<void> {
    this.closedByUser = false;
    await this.connect();
  }

  stop(): void {
    // Withdrawal of consent takes effect immediately and locally (SRS-ABR-061).
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.send({ type: 'event', kind: 'bye' });
    }
    this.socket?.close();
    this.socket = null;
    useDocumentStore.getState().setAgentActive(false);
    this.options.onStatusChange?.(false);
  }

  private async connect(): Promise<void> {
    // The bridge server publishes BOTH the token and the port it actually bound
    // to, so an explicitly-configured port (tests, a second bridge) is picked up
    // without the page having to be told separately. A page opened from disk
    // gets neither, and connects without a token (SRS-ABR-044).
    const session = await fetchSession();
    /**
     * Abandon if the bridge was stopped while that was in flight.
     *
     * Without this a stopped instance still opens a socket, and the server
     * adopts whatever says hello — so the page displaces ITSELF. Observed while
     * driving the portable build: ticking the box starts a dial at the default
     * address, typing an address immediately after stops that instance and
     * starts another, and the first one's `fetchSession` had not resolved yet.
     * It then connected, the server took it as a second page, and the live one
     * was told to stand down. The panel read "Another plan took over" with only
     * one plan open, and the agent's edit went nowhere.
     */
    if (this.closedByUser) return;

    const url = this.addressFor(session.port);

    useBridgeStore.getState().setStatus('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      useBridgeStore
        .getState()
        .setStatus('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
    this.socket = socket;

    socket.onopen = () => {
      // Belt to the check above: a socket this instance no longer owns must not
      // announce itself, or it claims the connection on behalf of nobody.
      if (this.closedByUser || this.socket !== socket) {
        socket.close();
        return;
      }
      this.reconnectDelay = 500;
      const state = useDocumentStore.getState();
      this.send({
        type: 'hello',
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        clientId: this.clientId,
        ...(session.token ? { token: session.token } : {}),
        href: location.href,
        title: state.doc.title,
        revision: state.revision,
      });
      state.setAgentActive(true);
      useBridgeStore.getState().setStatus('connected');
      this.options.onStatusChange?.(true);
    };

    socket.onmessage = (event) => {
      let frame: ServerMessage;
      try {
        frame = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return; // unparseable frame — no id to answer, nothing to say
      }

      // Control frames first: neither is a call, and `displaced` must be acted
      // on before the close handler can schedule a reconnect.
      if (frame?.type === 'displaced') {
        this.standDown(frame.reason || 'Another plan took the connection');
        return;
      }
      if (frame?.type === 'agents') {
        useBridgeStore.getState().setAgents(Array.isArray(frame.agents) ? frame.agents : []);
        return;
      }

      if (frame?.type !== 'call') return;
      const call = frame;
      // `get_render` rasterises, which cannot be synchronous. Nothing else
      // awaits, and the server issues one call at a time per client, so the
      // `lastSeenUserRevision` bookkeeping below is not racing itself.
      void this.handleCall(call).then((result) => {
        this.send(result);
        // Counted on success only, so the panel's number means "served",
        // not "attempted" (SRS-ABR-065).
        if (result.ok) useBridgeStore.getState().noteCommand(call.method);
      });
    };

    socket.onclose = () => {
      useDocumentStore.getState().setAgentActive(false);
      this.options.onStatusChange?.(false);
      if (this.closedByUser) return;
      /**
       * A failure already declared is not overwritten by the next attempt.
       *
       * Reporting 'connecting' here unconditionally is what made SRS-ABR-063's
       * defect: the backoff keeps dialling a port nothing is listening on, each
       * close rewrites the status, and the reason the give-up timer wrote is
       * gone within a second. Measured here against a bridge that was not
       * answering: the panel read "Waiting for agent server…" indefinitely with
       * the explanation already computed and thrown away. The retry loop still
       * runs — only the wording holds still until something actually answers.
       */
      if (useBridgeStore.getState().status !== 'error') {
        useBridgeStore.getState().setStatus('connecting');
      }
      this.scheduleReconnect();
    };

    // Deliberately no status here. Browsers put no useful detail on a socket
    // error event, and a server that is merely starting produces one on every
    // attempt — declaring failure is the give-up timer's job, which waits long
    // enough to mean it.
    socket.onerror = () => socket.close();
  }

  /**
   * Where to dial. A planner-typed address wins; otherwise the port the server
   * published, then the default. The store holds the empty string until someone
   * types one, so the default is resolved here rather than persisted.
   */
  private addressFor(publishedPort?: number): string {
    const typed = useBridgeStore.getState().url.trim();
    if (typed) return typed;
    const port = this.options.port ?? publishedPort ?? DEFAULT_BRIDGE_PORT;
    return `ws://127.0.0.1:${port}/agent`;
  }

  /**
   * Stop for good — another page has claimed the connection (SRS-ABR-007).
   *
   * Deliberately does NOT schedule a reconnect: retrying is exactly what causes
   * the flip-flop this frame exists to prevent. The persisted consent is
   * cleared too, so a forgotten background tab cannot silently re-claim the
   * connection after a reload; re-ticking the box takes it back.
   */
  private standDown(reason: string): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.close();
      this.socket = null;
    }
    useDocumentStore.getState().setAgentActive(false);
    this.options.onStatusChange?.(false);
    const store = useBridgeStore.getState();
    store.setEnabled(false);
    // AFTER setEnabled: that call unwinds through the store subscription and
    // stops the bridge, which would otherwise overwrite this with 'off'.
    store.setStatus('displaced', reason);
  }

  private scheduleReconnect(): void {
    // Restarting the agent host is routine and must not disturb the document
    // or require user action (SRS-ABR-003).
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
      // connect() can reject before a socket exists — the token endpoint
      // returns 503 while the bridge server is down, which is the NORMAL state
      // during a restart. Without this catch that rejection is unhandled and
      // the retry loop stops silently. Found by the live gate; the e2e never
      // exercises a server that goes away mid-session.
      this.connect().catch(() => {
        if (!this.closedByUser) this.scheduleReconnect();
      });
    }, this.reconnectDelay);
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private async handleCall(call: CallMessage): Promise<ResultMessage> {
    // Replay rather than re-apply, so a retry after TIMEOUT is safe.
    if (call.opId) {
      const cached = this.applied.get(call.opId);
      if (cached) return { ...cached, id: call.id, replayed: true };
    }

    const before = useDocumentStore.getState();
    const userEditedSince = before.userRevision > this.lastSeenUserRevision;

    let result: ResultMessage;
    try {
      const data = await this.dispatch(call);
      const after = useDocumentStore.getState();
      result = {
        type: 'result',
        id: call.id,
        ok: true,
        data,
        revision: after.revision,
        userEditedSince,
        replayed: false,
      };
    } catch (err) {
      const code: BridgeErrorCode =
        err instanceof BridgeError
          ? err.code
          : err instanceof DocOpError
            ? 'VALIDATION_FAILED'
            : 'VALIDATION_FAILED';
      result = {
        type: 'result',
        id: call.id,
        ok: false,
        error: { code, message: err instanceof Error ? err.message : String(err) },
        revision: useDocumentStore.getState().revision,
        userEditedSince,
        replayed: false,
      };
    }

    this.lastSeenUserRevision = useDocumentStore.getState().userRevision;

    if (call.opId && result.ok) {
      this.applied.set(call.opId, result);
      if (this.applied.size > OP_CACHE_LIMIT) {
        this.applied.delete(this.applied.keys().next().value as string);
      }
    }
    return result;
  }

  /**
   * The view, taken once the chart has drawn the revision the store now holds.
   *
   * Every report an agent reads goes through here, so none of them can describe
   * the chart as it was before the call being reported on (SRS-ABR-037).
   */
  private async settledView(): Promise<ViewSummary> {
    await afterPaint(useDocumentStore.getState().revision);
    return viewSummary();
  }

  private async dispatch(call: CallMessage): Promise<unknown> {
    const params = (call.params ?? {}) as Record<string, unknown>;
    const store = useDocumentStore.getState();

    switch (call.method) {
      case 'get_status': {
        const s = useDocumentStore.getState();
        return {
          connected: true,
          clientId: this.clientId,
          title: s.doc.title,
          revision: s.revision,
          userRevision: s.userRevision,
          counts: {
            rows: s.doc.rows.length,
            tasks: s.doc.tasks.length,
            milestones: s.doc.milestones.length,
            dependencies: s.doc.dependencies.length,
            markers: s.doc.markers.length,
            brackets: s.doc.brackets.length,
          },
          // What the person is actually looking at, not just what exists
          // (SRS-ABR-035). An agent that never reads this can author a chart
          // nobody can see.
          view: await this.settledView(),
        };
      }

      case 'get_document':
        return store.doc;

      case 'get_view':
        return this.settledView();

      case 'get_render': {
        // Evidence to show the user (SRS-ABR-031), and now also something the
        // AGENT can see (SRS-ABR-033/034). Must not trigger a download.
        //
        // The wait comes FIRST: the raster is taken from the live DOM, so
        // rendering before the chart has drawn the current revision hands the
        // agent a picture of the plan as it was.
        const view = await this.settledView();
        const render = await renderChart();
        return { ...render, view };
      }

      case 'apply_batch': {
        const { ops, expectedRevision } = params as unknown as ApplyBatchParams;
        if (!Array.isArray(ops)) throw new BridgeError('VALIDATION_FAILED', 'params.ops must be an array');
        this.assertRevision(expectedRevision);
        store.applyBatch(ops as DocOp[], 'agent');
        return {
          applied: ops.length,
          revision: useDocumentStore.getState().revision,
          view: await this.settledView(),
        };
      }

      case 'new_document': {
        this.assertRevision(params.expectedRevision as number | undefined);
        const doc = blankDocument(typeof params.title === 'string' ? params.title : undefined);
        // Same validation path as loading a file — an agent is untrusted input.
        const validated = validateDocument(doc);
        // `startDocument`, not `replaceDocument`: the save target is module
        // state that outlives the document, so replacing the document without
        // detaching the file left the previous plan's file bound — and the
        // user's next Ctrl+S would write this blank document over the roadmap
        // they had opened. It also clears the selection, which would otherwise
        // still name ids that no longer exist, and starts the plan clean rather
        // than dirty and undoable. This is the same call the UI's New makes.
        startDocument(validated);
        return { title: validated.title, view: await this.settledView() };
      }

      /**
       * The vertical axis, which no method could reach (SRS-ABR-026).
       *
       * Without these, SRS-ABR-035 is diagnosis with no remedy: the view report
       * tells an agent that the row it just wrote to is off screen, and nothing
       * lets it do anything about that. Neither is a document change, so
       * neither is a DocOp and neither makes a history frame (SRS-ABR-016).
       */
      case 'reveal': {
        const rowId = params.rowId;
        if (typeof rowId !== 'string') {
          throw new BridgeError('VALIDATION_FAILED', 'params.rowId must be a string');
        }
        if (!store.doc.rows.some((r) => r.id === rowId)) {
          throw new BridgeError('UNKNOWN_ID', `no row '${rowId}'`);
        }
        // ChartArea owns the arithmetic — it is the only place that knows the
        // plot height, the body height and therefore the scroll ceiling — so
        // this asks for the row and then waits for that pass to run.
        useViewportStore.getState().reveal(rowId);
        return { revealed: rowId, view: await this.settledView() };
      }

      case 'undo':
        store.undo('agent');
        return { revision: useDocumentStore.getState().revision, view: await this.settledView() };

      case 'redo':
        store.redo('agent');
        return { revision: useDocumentStore.getState().revision, view: await this.settledView() };

      case 'set_viewport': {
        const vp = useViewportStore.getState();
        const { startDate, pxPerDay, scrollY } = params as Record<string, string | number | undefined>;
        if (typeof startDate === 'string') vp.setStart(startDate);
        if (typeof pxPerDay === 'number') vp.setPxPerDay(pxPerDay);
        if (typeof scrollY === 'number') {
          // The ceiling comes from what is actually drawn below the fold rather
          // than from a layout number this module cannot see, so it is right
          // for whatever the chart currently contains.
          const below = viewSummary().viewportPx.contentBelow;
          const current = useViewportStore.getState().scrollY;
          vp.scrollBy(scrollY - current, current + below);
        }
        const after = useViewportStore.getState();
        const view = await this.settledView();
        return {
          startDate: after.startDate,
          pxPerDay: after.pxPerDay,
          scrollY: useViewportStore.getState().scrollY,
          view,
        };
      }

      case 'fit_to_tasks': {
        const doc = store.doc;
        const dates = [
          ...doc.tasks.flatMap((t) => [t.start, t.end]),
          ...doc.milestones.map((m) => m.date),
        ];
        if (dates.length === 0) throw new BridgeError('VALIDATION_FAILED', 'document has no dated entities');
        const min = dates.reduce((a, b) => (a < b ? a : b));
        const max = dates.reduce((a, b) => (a > b ? a : b));
        const width = document.querySelector('.chart-area')?.clientWidth ?? 800;
        useViewportStore.getState().fit(min, max, Math.max(100, width - 200));
        return { startDate: min, endDate: max };
      }

      case 'select': {
        const items = params.items;
        if (!Array.isArray(items)) throw new BridgeError('VALIDATION_FAILED', 'params.items must be an array');
        useSelectionStore.getState().setSelection(items as Selectable[]);
        return { selected: items.length };
      }

      default:
        throw new BridgeError('UNKNOWN_METHOD', `unknown method: ${call.method}`);
    }
  }

  /**
   * Opt-in optimistic concurrency (SRS-ABR-021). Absent means "do not check" —
   * mandatory whole-document checking would reject unrelated concurrent user
   * edits and make live sessions unusable (design review F1).
   */
  private assertRevision(expected: number | undefined): void {
    if (expected === undefined) return;
    const actual = useDocumentStore.getState().revision;
    if (expected !== actual) {
      throw new BridgeError(
        'REVISION_CONFLICT',
        `expected revision ${expected} but document is at ${actual}; the user's document stands`,
      );
    }
  }
}

/**
 * Fetch the session token and bound port from the dev server, same-origin
 * (SRS-ABR-042). A foreign origin cannot read it, which is what makes it useful
 * behind the server's origin allowlist.
 */
async function fetchSession(): Promise<{ token?: string; port?: number }> {
  // A page served from disk has no same-origin server, so there is no endpoint
  // to ask and no token to be had (SRS-ABR-044). `fetch` of a relative URL from
  // `file://` rejects rather than returning a status, so both arms degrade to
  // "no token" instead of failing the connection: the server admits a page it
  // could not have given one to, and still demands it from every page it could.
  if (location.protocol === 'file:') return {};

  let response: Response;
  try {
    response = await fetch('/__agent-token');
  } catch {
    return {};
  }
  if (!response.ok) {
    // 503 is the normal state while the bridge server is down, and on a built
    // page served over http there is no middleware at all, so the endpoint is
    // whatever the host serves for an unknown path. Neither is a reason to
    // refuse to dial: the server decides whether a tokenless page is allowed.
    return {};
  }
  const body = (await response.json().catch(() => ({}))) as { token?: string; port?: number };
  return { token: body.token, port: body.port };
}
