import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BridgeStatus } from '../../src/stores/bridgeStore';

/**
 * Bridge consent and what the planner is shown about it
 * (SRS-ABR-006/064/065/073).
 *
 * The store is re-imported per test because `enabled` and `url` are read from
 * localStorage at module scope — which is the behaviour under test, not an
 * accident of it: a plan reopened tomorrow must come back with the planner's
 * answer, and a plan opened in another browser must not.
 */

const ENABLED_KEY = 'powerplanner-bridge-enabled';
const URL_KEY = 'powerplanner-bridge-url';

async function freshStore() {
  vi.resetModules();
  return (await import('../../src/stores/bridgeStore')).useBridgeStore;
}

beforeEach(() => {
  localStorage.clear();
});

describe('bridge consent (SRS-ABR-006)', () => {
  it('starts off when this browser has never been asked', async () => {
    const store = await freshStore();
    expect(store.getState().enabled).toBe(false);
    expect(store.getState().status).toBe('off');
  });

  it('comes back on when this browser already said yes', async () => {
    // The control for the test above: without it, "starts off" would pass just
    // as well against a store that hard-codes false and never reads anything.
    localStorage.setItem(ENABLED_KEY, 'true');
    const store = await freshStore();
    expect(store.getState().enabled).toBe(true);
  });

  it('treats any answer but the exact string as off', async () => {
    localStorage.setItem(ENABLED_KEY, 'TRUE');
    expect((await freshStore()).getState().enabled).toBe(false);
    localStorage.setItem(ENABLED_KEY, '1');
    expect((await freshStore()).getState().enabled).toBe(false);
  });

  it('writes the answer down, so a reload does not ask again', async () => {
    const store = await freshStore();
    store.getState().setEnabled(true);
    expect(localStorage.getItem(ENABLED_KEY)).toBe('true');
    store.getState().setEnabled(false);
    expect(localStorage.getItem(ENABLED_KEY)).toBe('false');
  });

  it('clears the status, the error and the agent list when switched off', async () => {
    const store = await freshStore();
    store.getState().setEnabled(true);
    store.getState().setStatus('error', 'nothing answered');
    store.getState().setAgents([{ label: 'codex', role: 'hub', connectedAt: 1 }]);

    store.getState().setEnabled(false);
    expect(store.getState().status).toBe('off');
    expect(store.getState().lastError).toBeNull();
    expect(store.getState().agents).toEqual([]);
  });

  it('survives a browser that refuses local storage', async () => {
    // The portable build is opened from disk, where some browsers block storage
    // outright. A thrown getter must not take the app down with it.
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('access denied');
    });
    try {
      const store = await freshStore();
      expect(store.getState().enabled).toBe(false);
      expect(() => store.getState().setEnabled(true)).not.toThrow();
      expect(store.getState().enabled).toBe(true);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe('the server address (SRS-SET-013)', () => {
  it('starts empty, so the default is resolved at dial time rather than frozen', async () => {
    const store = await freshStore();
    expect(store.getState().url).toBe('');
  });

  it('remembers an address the planner typed', async () => {
    const store = await freshStore();
    store.getState().setUrl('ws://127.0.0.1:6000/agent');
    expect(localStorage.getItem(URL_KEY)).toBe('ws://127.0.0.1:6000/agent');
    expect((await freshStore()).getState().url).toBe('ws://127.0.0.1:6000/agent');
  });
});

describe('what the panel is told (SRS-ABR-064/065/073)', () => {
  it('counts the commands it has served and names the last one', async () => {
    const store = await freshStore();
    expect(store.getState().commandCount).toBe(0);
    store.getState().noteCommand('apply_batch');
    store.getState().noteCommand('get_render');
    expect(store.getState().commandCount).toBe(2);
    expect(store.getState().lastCommand).toBe('get_render');
  });

  it('has a word for every state it can be in', async () => {
    const { BRIDGE_STATUS_LABEL } = await import('../../src/stores/bridgeStore');
    const every: BridgeStatus[] = ['off', 'connecting', 'connected', 'error', 'displaced'];
    for (const status of every) {
      expect(BRIDGE_STATUS_LABEL[status].text.length).toBeGreaterThan(0);
      // A colour from the theme, never a literal: the panel is drawn in three
      // themes and a hex would read in one of them (SRS-SET-006).
      expect(BRIDGE_STATUS_LABEL[status].token).toMatch(/^var\(--/);
    }
    expect(Object.keys(BRIDGE_STATUS_LABEL)).toHaveLength(every.length);
  });

  it('keeps only agents the server actually named', async () => {
    const store = await freshStore();
    store.getState().setAgents([
      { label: 'codex', role: 'hub', connectedAt: 10 },
      { label: '', role: 'peer', connectedAt: 20 },
      { label: 'claude', role: 'peer', connectedAt: 30 },
    ] as never);
    expect(store.getState().agents.map((a) => a.label)).toEqual(['codex', 'claude']);
  });

  it('fills in a role and a time the server left out', async () => {
    const store = await freshStore();
    store.getState().setAgents([{ label: 'codex' }] as never);
    expect(store.getState().agents[0]).toEqual({ label: 'codex', role: 'agent', connectedAt: 0 });
  });
});
