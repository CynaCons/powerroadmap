import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeFor } from '../../src/persistence/fileIo';
import { blankDocument } from '../../src/embed/index';

/**
 * Build-output gate for SRS-ABR-052, replacing the one for SRS-ABR-050.
 *
 * The old row kept the bridge out of the portable build entirely, on the
 * grounds that the file is distributed to third parties. That treated the
 * PRESENCE of the code as the risk. The risk is a CONNECTION, and the code
 * cannot make one: it dials nothing until the planner ticks the box, the answer
 * is stored per browser, and a plan carries no bridge state to turn it on with.
 * Holding the old line cost the feature entirely — the planner the app is for
 * could not use an agent on their own machine, while the requirement was
 * satisfied by a build that simply did not have it.
 *
 * So this gate is the inverse, in three parts that are each checkable: the
 * machinery ships, the consent starts off, and the document carries none of it.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/**
 * `index.html`, not `PowerRoadmap.html`: the former is committed (the in-app
 * updater fetches it from raw.githubusercontent.com at the release tag,
 * DECISIONS.md D9) while the latter is an untracked copy the release workflow
 * makes.
 */
const PORTABLE = resolve(REPO_ROOT, 'dist-template/index.html');

/**
 * String literals a minifier cannot rename, so their presence is evidence the
 * bridge really travels with the file rather than being tree-shaken away.
 * Identifiers are deliberately not on this list — `AgentBridge` becomes a
 * single letter and its absence would prove nothing either way.
 */
const MUST_SHIP = ['powerplanner-bridge-enabled', 'ws://127.0.0.1:', 'Let a local agent edit this plan'];

describe('the bridge ships, inert (SRS-ABR-052)', () => {
  it.runIf(existsSync(PORTABLE))('portable HTML carries the bridge', () => {
    const html = readFileSync(PORTABLE, 'utf8');
    const missing = MUST_SHIP.filter((literal) => !html.includes(literal));
    expect(missing, `the portable build cannot turn the bridge on: ${missing.join(', ')}`).toEqual([]);
  });

  it.runIf(existsSync(PORTABLE))('portable HTML carries no token path', () => {
    // The dev-server endpoint has no counterpart in a file opened from disk, and
    // a build that reached for one would retry a URL that cannot exist. The
    // client checks `location.protocol` before asking (SRS-ABR-044), so the
    // literal may appear — what must not is the Vite middleware's own wording.
    const html = readFileSync(PORTABLE, 'utf8');
    expect(html).not.toContain('bridge server not running');
    expect(html).not.toContain('stale .powerplanner-bridge.json');
  });

  it('names the build this gate needs, rather than passing for want of one', () => {
    if (!existsSync(PORTABLE)) {
      expect.soft(
        false,
        'dist-template/index.html missing — run "npm run build:template" before trusting SRS-ABR-052',
      ).toBe(true);
    }
    expect(PORTABLE).toContain('dist-template');
  });

  it('keeps bridge state out of a saved plan', async () => {
    // A roadmap sent to a colleague must not arrive trying to dial a socket on
    // their machine (SRS-ABR-006). Asserted on the SERIALISED bytes and as a
    // substring anywhere, not as a missing field: a title or an id holding the
    // word would be just as wrong.
    const doc = blankDocument('A plan to send someone');
    const json = await serializeFor('plan.json', doc);
    const yaml = await serializeFor('plan.yaml', doc);
    expect(json.text.toLowerCase()).not.toContain('bridge');
    expect(yaml.text.toLowerCase()).not.toContain('bridge');
  });

  it('would notice if the word were there', async () => {
    // The control: the assertion above reads bytes that could contain the word,
    // so it has a reachable failing state.
    const doc = blankDocument('A plan about the bridge over the river');
    const json = await serializeFor('plan.json', doc);
    expect(json.text.toLowerCase()).toContain('bridge');
  });
});
