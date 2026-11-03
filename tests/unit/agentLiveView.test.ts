import { describe, it, expect, beforeEach } from 'vitest';
import { afterPaint } from '../../src/agent/AgentBridge';

/**
 * The wait that makes a bridge report describe the edit it is reporting on
 * (SRS-ABR-037).
 *
 * Owner directive 2026-11-02: "when the MCP makes changes, they shall be pushed
 * and updated live on the UI without having a need to refresh". Measured on a
 * running page, the SCREEN was already live; the report was not. `apply_batch`
 * took its census synchronously after the store write, and the three methods
 * that did wait counted two animation frames — which is one short, because
 * React commits on a scheduler callback that lands after both. The chart had
 * 34 bars and the agent was told 33.
 */

/** The chart, as `ChartArea` renders it: a stamped revision on the `<svg>`. */
function mountChart(revision: number | null): SVGSVGElement {
  document.body.innerHTML = '<div class="chart-area"><svg></svg></div>';
  const svg = document.querySelector<SVGSVGElement>('.chart-area svg')!;
  if (revision !== null) svg.dataset.ppRevision = String(revision);
  return svg;
}

/** True when `promise` has settled by the time `frames` have passed. */
async function settledWithin(promise: Promise<void>, frames: number): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; });
  for (let i = 0; i < frames; i++) {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }
  // One macrotask, so a resolution scheduled on the last frame is counted.
  await new Promise((r) => setTimeout(r, 0));
  return done;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('afterPaint waits for the frame that holds the change (SRS-ABR-037)', () => {
  it('does not settle while the chart still shows an older revision', async () => {
    mountChart(0);
    // Six frames is three times what the old implementation waited, so this
    // fails against that implementation rather than merely describing it.
    expect(await settledWithin(afterPaint(1), 6)).toBe(false);
  });

  it('settles once the chart has drawn the revision asked for', async () => {
    const svg = mountChart(0);
    const waiting = afterPaint(1);
    expect(await settledWithin(waiting, 4)).toBe(false);
    svg.dataset.ppRevision = '1';
    expect(await settledWithin(waiting, 4)).toBe(true);
  });

  it('settles at once when the chart is already current', async () => {
    // The control for the first test: with nothing to wait for, the same call
    // must not stall. Without this, "does not settle" could be passing because
    // the promise never settles at all.
    mountChart(3);
    expect(await settledWithin(afterPaint(3), 3)).toBe(true);
  });

  it('settles for a revision the chart has already passed', async () => {
    // A user edit between the write and the census moves the stamp further on,
    // and that must not read as "not drawn yet".
    mountChart(9);
    expect(await settledWithin(afterPaint(4), 3)).toBe(true);
  });

  it('does not wait when there is no chart to wait for', async () => {
    // The compact Office task pane and the unit harness have no chart. Spending
    // thirty frames discovering that would put a third of a second on every
    // call the bridge serves there.
    document.body.innerHTML = '<div class="nothing-here"></div>';
    expect(await settledWithin(afterPaint(5), 3)).toBe(true);
  });

  it('gives up rather than hanging when the chart never catches up', async () => {
    // A page that is never going to draw the revision must still answer: a
    // report that never arrives is worse than a stale one, because the agent
    // cannot even retry.
    mountChart(0);
    expect(await settledWithin(afterPaint(99), 6)).toBe(false);
    expect(await settledWithin(afterPaint(99), 40)).toBe(true);
  }, 10000);

  it('does not wait when the chart carries no stamp at all', async () => {
    // An older build, or a harness that renders the chart without the app.
    mountChart(null);
    expect(await settledWithin(afterPaint(2), 3)).toBe(true);
  });
});
