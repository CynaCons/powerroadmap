import { describe, it, expect, vi } from 'vitest';
import { performUpdate } from '../../src/utils/updateChecker';
import { sampleDocument } from '../../src/utils/sample';
import type { FileSystemFileHandleLike } from '../../src/persistence/fileIo';

/**
 * SRS-PERS-040, from the other end — the updater writes the APPLICATION, so it
 * may only overwrite a file that holds the application.
 *
 * `finishSave` and `autosaveToFile` were routed through `serializeFor`, and
 * `writeThrough` is format-aware as a result. But it is not the only path that
 * overwrites the bound file: `performUpdate` writes through
 * `writeHtmlToHandle`, and it chose its target on write permission alone. So
 * the same loss Ctrl+S had survived behind Settings → Update — a plan bound to
 * `sprint.json` replaced by 430KB of `<!doctype html>` under its own name.
 *
 * Two things made it worse than the Ctrl+S case. The page being served is not
 * the data file, so the reload afterwards re-serves the OLD version: the
 * update appears to have done nothing while the original is already gone. And
 * the dialog read the wording off the handle alone, so it said "updating this
 * file in place" while doing exactly that.
 *
 * Found by review before release, not by a report.
 */

const handleNamed = (name: string) => {
  const written: string[] = [];
  const handle = {
    name,
    createWritable: async () => ({
      write: async (c: string) => { written.push(c); },
      close: async () => {},
    }),
    getFile: async () => new File([''], name),
  } as unknown as FileSystemFileHandleLike;
  return { handle, written };
};

const deps = (handle: FileSystemFileHandleLike, written: string[], downloads: string[]) => ({
  fetchTemplate: async () => '<!doctype html><html><body><div id="root"></div></body></html>',
  getHandle: () => handle,
  verifyWrite: async () => true,
  writeHandle: async (h: FileSystemFileHandleLike, html: string) => {
    void h;
    written.push(html);
    return true;
  },
  reload: () => { downloads.push('RELOAD'); },
  download: (name: string) => { downloads.push(name); },
  buildBackupHtml: () => '<!doctype html><!-- backup -->',
});

describe('the updater will not replace a data file with the app (SRS-PERS-040)', () => {
  for (const name of ['sprint.json', 'plan.yaml', 'plan.yml']) {
    it(`${name} is updated by download, not in place`, async () => {
      const { handle, written } = handleNamed(name);
      const downloads: string[] = [];
      const result = await performUpdate(
        sampleDocument(),
        '2.35.0',
        '2.36.0',
        'v2.36.0',
        undefined,
        deps(handle, written, downloads),
      );
      expect(result.ok).toBe(true);
      expect(result.ok && result.mode, 'the data file was overwritten in place').toBe('download');
      expect(written, `${name} was written to`).toHaveLength(0);
      expect(downloads, 'the page reloaded, so the planner sees the old version').not.toContain('RELOAD');
      expect(downloads.join(' '), 'no new version was handed over').toContain('v2.36.0');
    });
  }

  it('an .html file IS still updated in place — the control', async () => {
    // Without this, "never write in place" would pass every case above and
    // break the thing the updater is for.
    const { handle, written } = handleNamed('roadmap.html');
    const downloads: string[] = [];
    const result = await performUpdate(
      sampleDocument(),
      '2.35.0',
      '2.36.0',
      'v2.36.0',
      undefined,
      deps(handle, written, downloads),
    );
    expect(result.ok && result.mode).toBe('live-swap');
    expect(written, 'the open file was not rewritten').toHaveLength(1);
    expect(written[0].toLowerCase()).toContain('<!doctype html');
    expect(downloads, 'the page did not reload onto the new version').toContain('RELOAD');
  });

  it('a file with no handle at all downloads, as before', async () => {
    const downloads: string[] = [];
    const written: string[] = [];
    const result = await performUpdate(
      sampleDocument(),
      '2.35.0',
      '2.36.0',
      'v2.36.0',
      undefined,
      {
        ...deps({ name: 'x' } as unknown as FileSystemFileHandleLike, written, downloads),
        getHandle: () => null,
      },
    );
    expect(result.ok && result.mode).toBe('download');
    expect(written).toHaveLength(0);
  });
});

describe('what the dialog promises matches what happens', () => {
  it('does not claim an in-place update for a data file', async () => {
    // The wording is chosen in SettingsDialog from the same question
    // performUpdate asks. Asserted here through the module rather than the
    // DOM, because the status string is what the planner reads.
    const { formatForName } = await vi.importActual<typeof import('../../src/persistence/fileIo')>(
      '../../src/persistence/fileIo',
    );
    expect(formatForName('sprint.json')).not.toBe('html');
    expect(formatForName('roadmap.html')).toBe('html');
  });
});
