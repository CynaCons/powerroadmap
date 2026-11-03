/**
 * Keeps the bridge socket in sync with the planner's consent.
 *
 * The bridge ships in every build, including the portable single file
 * (SRS-ABR-052), and does nothing at all until `bridgeStore.enabled` is true.
 * That flag starts false and lives only in this browser (SRS-ABR-006), so a
 * plan opened for the first time — or opened by someone the plan was sent to —
 * dials nothing.
 *
 * Imported statically rather than behind a dynamic import: the portable build
 * is produced by `vite-plugin-singlefile`, and the bridge reaches only stores
 * and helpers the app already carries, so a separate chunk would buy nothing
 * and add a failure mode to the one build that cannot fetch it.
 */

import { AgentBridge } from './AgentBridge';
import { useBridgeStore } from '../stores/bridgeStore';
import { DEFAULT_BRIDGE_PORT } from './protocol';

/**
 * How long the bridge gets to answer before the status admits it is not there.
 *
 * Without this the status sits on "Waiting for agent server…" for ever:
 * `start()` resolves as soon as the WebSocket object exists, before any
 * handshake, and a port nothing is listening on produces no frame to react to
 * (SRS-ABR-063). Observed as a stale bridge process from a session four days
 * earlier holding the port, with the control giving no reason.
 */
export const CONNECT_TIMEOUT_MS = 5000;

let bridge: AgentBridge | null = null;
let giveUp: ReturnType<typeof setTimeout> | null = null;

function clearGiveUp(): void {
  if (giveUp) clearTimeout(giveUp);
  giveUp = null;
}

function describeTarget(): string {
  const typed = useBridgeStore.getState().url.trim();
  return typed || `port ${DEFAULT_BRIDGE_PORT}`;
}

/**
 * Give the bridge its grace, then say what did not answer.
 *
 * Only a status, never a disconnect: the server may simply be starting, and the
 * client's own backoff keeps dialling (SRS-ABR-003). What changes is that the
 * planner is told why nothing is happening — and the message holds, because the
 * client no longer rewrites it on each retry.
 */
function armGiveUp(): void {
  clearGiveUp();
  giveUp = setTimeout(() => {
    giveUp = null;
    const store = useBridgeStore.getState();
    if (store.status === 'connected' || !store.enabled) return;
    store.setStatus(
      'error',
      `No agent bridge answered on ${describeTarget()} within ${CONNECT_TIMEOUT_MS / 1000}s. ` +
        'Start the PowerRoadmap MCP server, or check that nothing else holds that port.',
    );
  }, CONNECT_TIMEOUT_MS);
}

function start(): void {
  if (bridge) return;
  const instance = new AgentBridge({
    onStatusChange: (connected) => {
      // Arm the timer afresh on every disconnection, so a server that goes away
      // mid-session gets the same 5s of grace and then the same explanation,
      // rather than reaching the planner only on the very first attempt.
      if (connected) clearGiveUp();
      else armGiveUp();
    },
  });
  bridge = instance;

  armGiveUp();

  void instance.start().catch((err) => {
    useBridgeStore
      .getState()
      .setStatus('error', err instanceof Error ? err.message : String(err));
  });
}

function stop(): void {
  clearGiveUp();
  if (!bridge) return;
  bridge.stop();
  bridge = null;
}

/**
 * Begin following the store. Returns an unsubscribe function.
 *
 * A change of address while connected needs a full cycle to take effect, since
 * the socket is already open to the old one.
 */
export function initBridge(): () => void {
  const apply = (enabled: boolean) => {
    if (enabled) start();
    else stop();
  };

  const initial = useBridgeStore.getState();
  let prevEnabled = initial.enabled;
  let prevUrl = initial.url;
  apply(prevEnabled);

  return useBridgeStore.subscribe((state) => {
    if (state.enabled === prevEnabled && state.url === prevUrl) return;
    const urlChanged = state.url !== prevUrl;
    prevEnabled = state.enabled;
    prevUrl = state.url;
    if (urlChanged && bridge) stop();
    apply(state.enabled);
  });
}

/** Test seam: drop any live bridge without going through the store. */
export function resetBridgeForTests(): void {
  stop();
}
