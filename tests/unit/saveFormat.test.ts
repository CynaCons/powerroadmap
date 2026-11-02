import { describe, it, expect, vi } from 'vitest';
import { formatForName, parseWithFormat, serializeFor } from '../../src/persistence/fileIo';
import { parseFileContents } from '../../src/persistence/fileIo';
import { sampleDocument } from '../../src/utils/sample';
import type { GanttDocument } from '../../src/types/document';

/**
 * SRS-PERS-040 — a file is saved in the format it already holds.
 *
 * `finishSave` built HTML and wrote it, whatever the handle was. So a plan
 * opened from `sprint.json` — 604 bytes of JSON — came back after one edit and
 * one Ctrl+S as a 420KB HTML document still called `sprint.json`, and the
 * loader could never read it again: `parseFileContents` dispatches on the
 * extension, so it tried `JSON.parse` on a document that begins `<!doctype
 * html>`. The original was gone. Autosave did the same thing on a timer.
 *
 * The pair that matters is save-then-open, so these tests check the two
 * against each other rather than checking the bytes alone.
 */

const doc = (): GanttDocument => sampleDocument();

/** Produced by the app's own writer, so these fixtures are not hand-rolled. */
const toYamlText = async (d: GanttDocument): Promise<string> =>
  (await serializeFor('fixture.yaml', d)).text;

describe('the format follows the file name (SRS-PERS-040)', () => {
  it('reads the format from the extension, the way the loader does', () => {
    expect(formatForName('sprint.json')).toBe('json');
    expect(formatForName('SPRINT.JSON')).toBe('json');
    expect(formatForName('plan.yaml')).toBe('yaml');
    expect(formatForName('plan.yml')).toBe('yaml');
    expect(formatForName('plan.html')).toBe('html');
    expect(formatForName('plan.htm')).toBe('html');
  });

  it('lets the caller decide the class the extension cannot settle', () => {
    // `parseFileContents` reads a name with no extension, or one this app does
    // not know, by trying JSON and then YAML - never HTML. So answering
    // `html` for that class left exactly the old loss in place for it: a JSON
    // plan opened as `sprint`, saved, and then unreadable. The extension
    // settles the three names the loader dispatches on; for the rest the
    // caller passes what the file was last known to hold.
    expect(formatForName('plan')).toBe('html');
    expect(formatForName('plan.txt')).toBe('html');
    expect(formatForName('sprint', 'json')).toBe('json');
    expect(formatForName('sprint.txt', 'yaml')).toBe('yaml');
    // An extension that DOES settle it is not overridden.
    expect(formatForName('plan.html', 'json')).toBe('html');
    expect(formatForName('plan.json', 'html')).toBe('json');
    expect(formatForName('plan.yml', 'html')).toBe('yaml');
  });
});

describe('the loader says which branch read the file (SRS-PERS-040)', () => {
  it('reports the format for each name class', async () => {
    const d = doc();
    expect(parseWithFormat('p.json', JSON.stringify(d)).format).toBe('json');
    expect(parseWithFormat('p.yaml', await toYamlText(d)).format).toBe('yaml');
    // No extension: read as JSON by the fallback branch, and reported as JSON
    // so the next save writes JSON rather than a 430KB application.
    expect(parseWithFormat('sprint', JSON.stringify(d)).format).toBe('json');
    expect(parseWithFormat('sprint.txt', await toYamlText(d)).format).toBe('yaml');
  });

  it('an extensionless JSON plan survives a save and a reopen', async () => {
    // The whole name class, end to end. Before the fix this wrote the
    // application into `sprint` and the reopen threw.
    const original = doc();
    const read = parseWithFormat('sprint', JSON.stringify(original));
    expect(read.format).toBe('json');

    const written = await serializeFor('sprint', read.doc, read.format);
    expect(written.format, 'an extensionless data file was saved as the app').toBe('json');
    expect(written.text.startsWith('<!doctype')).toBe(false);

    const reopened = parseFileContents('sprint', written.text);
    expect(reopened.rows.length).toBe(original.rows.length);
    expect(reopened.tasks.length).toBe(original.tasks.length);
  });

  it('with nothing known about the name, it is still the app — the control', async () => {
    // Without this, "always data" would pass the cases above and stop the
    // product saving the format it ships as.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<!doctype html><body></body>' })));
    const written = await serializeFor('sprint', doc());
    expect(written.format).toBe('html');
    vi.unstubAllGlobals();
  });
});

describe('what gets written round-trips back (SRS-PERS-040)', () => {
  for (const [name, format] of [['sprint.json', 'json'], ['plan.yaml', 'yaml'], ['plan.yml', 'yaml']] as const) {
    it(`${name} is written as ${format} and reopens`, async () => {
      const original = doc();
      const written = await serializeFor(name, original);
      expect(written.format).toBe(format);

      // The real test: hand it back to the loader under the same name.
      const reopened = parseFileContents(name, written.text);
      expect(reopened.title).toBe(original.title);
      expect(reopened.rows.length).toBe(original.rows.length);
      expect(reopened.tasks.length).toBe(original.tasks.length);
      expect(reopened.milestones.length).toBe(original.milestones.length);
      expect(reopened.dependencies.length).toBe(original.dependencies.length);
    });
  }

  it('does not write a 400KB app into a 600-byte data file', async () => {
    const written = await serializeFor('sprint.json', doc());
    // The old behaviour wrote the whole single-file app here.
    expect(written.text.startsWith('<!doctype') || written.text.startsWith('<!DOCTYPE')).toBe(false);
    expect(written.text.length).toBeLessThan(200_000);
    expect(JSON.parse(written.text).schemaVersion).toBe(1);
  });

  it('still writes the whole app for an .html file — the control', async () => {
    // Without this, "never write HTML" would pass every case above and break
    // the format the product actually ships as.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<!doctype html><body></body>' })));
    const written = await serializeFor('plan.html', doc());
    expect(written.format).toBe('html');
    expect(written.text.toLowerCase()).toContain('<!doctype html');
    vi.unstubAllGlobals();
  });
});
