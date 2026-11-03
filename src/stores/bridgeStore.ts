import { create } from 'zustand';

/**
 * Agent bridge connection state.
 *
 * `enabled` lives in localStorage, NOT in the plan (SRS-ABR-006): it is a
 * property of this machine, not of the roadmap. Persisting it into the document
 * would mean a plan sent to a colleague arrives trying to dial a socket on
 * their box — and the bridge now ships in the portable build (SRS-ABR-052), so
 * that document would actually be able to do it.
 *
 * Ported from PowerScroll's `useBridgeStore`, including the default address
 * being the empty string rather than `DEFAULT_BRIDGE_URL`: the field renders
 * empty with the default as its placeholder, and the default is resolved at
 * dial time. Seeding the field would persist an address the planner never
 * typed, and freeze it if the default ever moves.
 */

const ENABLED_KEY = 'powerplanner-bridge-enabled';
const URL_KEY = 'powerplanner-bridge-url';

export type BridgeStatus = 'off' | 'connecting' | 'connected' | 'error' | 'displaced';

/** One agent attached to the bridge, as the server reports it (SRS-ABR-073). */
export interface ConnectedAgent {
  label: string;
  role: string;
  connectedAt: number;
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

function readUrl(fallback: string): string {
  try {
    return localStorage.getItem(URL_KEY) || fallback;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignored — private mode and quota errors are not worth failing a toggle for
  }
}

interface BridgeState {
  enabled: boolean;
  url: string;
  status: BridgeStatus;
  lastError: string | null;
  /** Commands served since the page loaded — the cheapest "it is actually working" signal. */
  commandCount: number;
  lastCommand: string | null;
  /** Agents the server says are attached. Empty until it pushes a list. */
  agents: ConnectedAgent[];

  setEnabled: (enabled: boolean) => void;
  setUrl: (url: string) => void;
  setStatus: (status: BridgeStatus, error?: string | null) => void;
  noteCommand: (cmd: string) => void;
  setAgents: (agents: ConnectedAgent[]) => void;
}

export const useBridgeStore = create<BridgeState>((set) => ({
  enabled: readEnabled(),
  url: readUrl(''),
  status: 'off',
  lastError: null,
  commandCount: 0,
  lastCommand: null,
  agents: [],

  setEnabled: (enabled) => {
    persist(ENABLED_KEY, String(enabled));
    set({
      enabled,
      ...(enabled ? {} : { status: 'off' as BridgeStatus, lastError: null, agents: [] }),
    });
  },

  setUrl: (url) => {
    persist(URL_KEY, url);
    set({ url });
  },

  setStatus: (status, error = null) => set({ status, lastError: error }),

  noteCommand: (cmd) =>
    set((state) => ({ commandCount: state.commandCount + 1, lastCommand: cmd })),

  setAgents: (agents) =>
    set({
      agents: agents
        .filter((a) => typeof a?.label === 'string' && a.label.length > 0)
        .map((a) => ({
          label: a.label,
          role: typeof a.role === 'string' ? a.role : 'agent',
          connectedAt: typeof a.connectedAt === 'number' ? a.connectedAt : 0,
        })),
    }),
}));

/** What the panel and the index print for each state, and the colour they print it in. */
export const BRIDGE_STATUS_LABEL: Record<BridgeStatus, { text: string; token: string }> = {
  off: { text: 'Off', token: 'var(--color-text-dim)' },
  connecting: { text: 'Waiting for agent server…', token: 'var(--color-deadline)' },
  connected: { text: 'Connected', token: 'var(--color-bridge-on)' },
  error: { text: 'Cannot reach server', token: 'var(--color-today)' },
  displaced: { text: 'Another plan took over', token: 'var(--color-deadline)' },
};
