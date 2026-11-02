import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { layoutDocument } from '../../src/layout/engine';
import { sampleDocument } from '../../src/utils/sample';
import type { GanttDocument } from '../../src/types/document';

/**
 * SRS-LAY-057 — the layout is recomputed only when something it reads changed.
 *
 * `ChartArea` memoised the layout on the whole `doc` object, so editing the
 * document TITLE — which the engine never reads — re-laid-out every row, task,
 * milestone, bracket, dependency and the critical path, and re-rendered 675
 * SVG nodes. Measured before the fix: ten keystrokes in the title cost 21 long
 * tasks and 1,446ms of blocked main thread, with four frames over 50ms.
 *
 * Narrowing a memo's dependencies is the kind of optimisation that goes stale
 * silently: the day someone makes the engine read one more field, the chart
 * stops repainting for it and nothing says so. So this file checks the
 * contract from BOTH ends — what the engine actually reads, and what the memo
 * actually lists — and fails if they drift apart.
 */

const base = (): GanttDocument => sampleDocument();
const render = (doc: GanttDocument) =>
  JSON.stringify(layoutDocument({ doc, viewStart: '2026-01-01', pxPerDay: 2 }));

/** Every `doc.<field>` the engine mentions, read out of its source. */
function fieldsEngineReads(): Set<string> {
  const src = readFileSync('src/layout/engine.ts', 'utf8');
  const found = new Set<string>();
  for (const m of src.matchAll(/\bdoc\.([a-zA-Z_$][\w$]*)/g)) found.add(m[1]);
  return found;
}

/** The dependency array of the layout memo, read out of ChartArea. */
function memoDependencies(): string[] {
  const src = readFileSync('src/app/ChartArea.tsx', 'utf8');
  const i = src.indexOf('layoutDocument(');
  expect(i, 'ChartArea no longer calls layoutDocument').toBeGreaterThan(-1);
  // The deps are the array literal closing the useMemo that wraps that call.
  // Comments stripped first: the dependency list carries an eslint-disable
  // above it, and a comment between the call and the array is not a reason to
  // fail to find the array.
  const after = src.slice(i, i + 1200).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // ...layoutDocument({ … }),  [deps],  );  — the deps are the array literal
  // that closes the useMemo, which is the first one after the call itself.
  const m = after.match(/\)\s*,\s*\[([\s\S]*?)\]\s*,?\s*\)/);
  expect(m, 'could not find the layout memo dependency list').toBeTruthy();
  return m![1].split(',').map((s) => s.trim()).filter(Boolean);
}

describe('the layout memo lists exactly what the engine reads (SRS-LAY-057)', () => {
  it('names every document field the engine touches', () => {
    const reads = fieldsEngineReads();
    const deps = memoDependencies();
    expect(reads.size, 'the engine reads no document fields at all — check the regex').toBeGreaterThan(3);

    const missing = [...reads].filter((f) => !deps.some((d) => d === `doc.${f}` || d.startsWith(`doc.${f}.`)));
    expect(
      missing,
      `the engine reads ${missing.map((f) => `doc.${f}`).join(', ')} but the memo does not depend on it — ` +
        `the chart will not repaint when it changes`,
    ).toEqual([]);
  });

  it('does not depend on the whole document, which is what made it slow', () => {
    const deps = memoDependencies();
    expect(deps, 'the memo is keyed on the whole doc again').not.toContain('doc');
  });

  it('every dependency it lists is one the engine really reads', () => {
    const reads = fieldsEngineReads();
    const docDeps = memoDependencies().filter((d) => d.startsWith('doc.'));
    expect(docDeps.length, 'the memo lists no document fields').toBeGreaterThan(3);
    for (const d of docDeps) {
      const field = d.slice('doc.'.length).split('.')[0];
      expect(reads.has(field), `the memo depends on ${d}, which the engine never reads`).toBe(true);
    }
  });
});

describe('what actually changes a layout, and what does not', () => {
  it('the title does not', () => {
    const a = base();
    const b = { ...base(), title: 'A completely different name' };
    expect(a.title).not.toBe(b.title);
    expect(render(b)).toBe(render(a));
  });

  it('nor the markers, which the engine does not lay out', () => {
    const a = base();
    const b = base();
    b.markers = [...b.markers, { id: 'mk-x', type: 'deadline', label: 'Another gate', date: '2026-09-01' }];
    expect(b.markers.length).toBeGreaterThan(a.markers.length);
    expect(render(b)).toBe(render(a));
  });

  it('nor the theme', () => {
    const b = base();
    b.style = { ...b.style, theme: b.style.theme === 'dark' ? 'light' : 'dark' };
    expect(render(b)).toBe(render(base()));
  });

  // The other half: these MUST change it, or the three cases above prove
  // nothing — a `render` that never varies would pass them all.
  it('but the rows do', () => {
    const b = base();
    b.rows = [...b.rows, { id: 'row-extra', label: 'Extra', groupId: null }];
    expect(render(b)).not.toBe(render(base()));
  });

  it('and the tasks do', () => {
    const b = base();
    b.tasks = [...b.tasks, { id: 't-extra', rowId: b.rows[0].id, label: 'Extra', start: '2026-03-01', end: '2026-03-20' }];
    expect(render(b)).not.toBe(render(base()));
  });

  it('and the milestones do', () => {
    const b = base();
    b.milestones = [...b.milestones, { id: 'ms-extra', rowId: b.rows[0].id, label: 'Extra', date: '2026-04-01' }];
    expect(render(b)).not.toBe(render(base()));
  });

  it('and the dependencies do', () => {
    const b = base();
    const [t1, t2] = b.tasks;
    b.dependencies = [...b.dependencies, { id: 'dep-extra', from: t1.id, to: t2.id, type: 'finish-to-start' }];
    expect(render(b)).not.toBe(render(base()));
  });

  it('and the brackets do', () => {
    const b = base();
    b.brackets = [...b.brackets, { id: 'br-extra', label: 'Phase X', start: '2026-03-01', end: '2026-06-01', rowIds: [b.rows[1].id] }];
    expect(render(b)).not.toBe(render(base()));
  });
});
