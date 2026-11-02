import { useState, useCallback, useRef } from 'react';
import { Bot } from 'lucide-react';
import type { AgentBridge } from './AgentBridge';
import { DEFAULT_BRIDGE_PORT } from './protocol';

/** How long a bridge gets to answer before the control admits it is not there. */
const CONNECT_TIMEOUT_MS = 5000;

/**
 * Explicit opt-in control for the agent bridge (SRS-ABR-001).
 *
 * Deliberately NOT auto-connecting: the user grants remote control of their
 * document by pressing this, and the same control revokes it immediately
 * (SRS-ABR-061).
 *
 * The bridge module is imported dynamically so that the production build,
 * where `import.meta.env.DEV` is statically false, drops the import entirely
 * along with everything it reaches (SRS-ABR-050).
 */
export function AgentBridgeToggle() {
  const [state, setState] = useState<'off' | 'connecting' | 'on' | 'error'>('off');
  const [detail, setDetail] = useState<string | null>(null);
  const bridgeRef = useRef<AgentBridge | null>(null);

  const toggle = useCallback(async () => {
    if (bridgeRef.current) {
      bridgeRef.current.stop();
      bridgeRef.current = null;
      setState('off');
      setDetail(null);
      return;
    }

    setState('connecting');
    setDetail(null);
    /**
     * A socket that never opens has to become a failure, not a mood
     * (SRS-ABR-063).
     *
     * `error` was reachable only if `start()` THREW, and it does not: it
     * resolves as soon as the WebSocket object exists, before any handshake.
     * So a bridge that was not there left `onStatusChange(false)` mapping to
     * `connecting` for ever. Observed here: a stale bridge process from a
     * session four days earlier held the fixed port, and this control sat on
     * "Connecting…" with no timeout, no reason, and no hint that the port was
     * the problem.
     */
    let settled = false;
    const giveUp = setTimeout(() => {
      if (settled) return;
      settled = true;
      bridgeRef.current?.stop();
      bridgeRef.current = null;
      setState('error');
      setDetail(
        `No agent bridge answered on port ${DEFAULT_BRIDGE_PORT} within ${CONNECT_TIMEOUT_MS / 1000}s. ` +
          'Start the PowerRoadmap MCP server, or check that nothing else holds that port.',
      );
    }, CONNECT_TIMEOUT_MS);

    try {
      const { AgentBridge: Bridge } = await import('./AgentBridge');
      const bridge = new Bridge({
        onStatusChange: (connected) => {
          if (connected) {
            settled = true;
            clearTimeout(giveUp);
            setState('on');
          } else if (!settled) {
            setState('connecting');
          }
        },
      });
      await bridge.start();
      bridgeRef.current = bridge;
    } catch (err) {
      settled = true;
      clearTimeout(giveUp);
      setState('error');
      setDetail(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const label =
    state === 'on' ? 'Agent on' : state === 'connecting' ? 'Connecting…' : state === 'error' ? 'Agent failed' : 'Agent';

  return (
    <button
      onClick={() => void toggle()}
      title={
        detail ??
        (state === 'on'
          ? 'An agent can edit this document. Click to disconnect.'
          : 'Allow an agent to edit this document (dev only)')
      }
      aria-pressed={state === 'on'}
      className={`app-header__btn label-hideable ${state === 'on' ? 'is-active' : ''}`}
    >
      <Bot size={14} strokeWidth={1.75} />
      <span>{label}</span>
    </button>
  );
}
