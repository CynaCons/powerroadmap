import type { GanttDocument } from '../types/document';
import { validateDocument } from './schema';
import { toYaml, fromYaml } from './yaml';
import { buildEmbeddedHtml, injectDocumentInto } from './embedded';
import { bindFile, setSaveState } from '../stores/fileStore';
import {
  forgetHandle,
  isHandleForThisDocument,
  mayAutosave,
  recallHandle,
  rememberHandle,
  type StoredFileHandle,
} from './fileHandleStore';

const FILE_PICKER_TYPES = [
  { description: 'PowerRoadmap', accept: { 'text/html': ['.html'] as string[] } },
];

interface FilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}

interface FileSystemWritableFileStreamLike {
  write: (data: BufferSource | string | Blob) => Promise<void>;
  close: () => Promise<void>;
}

export interface FileSystemFileHandleLike {
  /** The file's own name. Reporting `suggestedName` instead said "Saved to
   *  plan.html" when the planner had chosen `roadmap-q3.html`. */
  name: string;
  createWritable: () => Promise<FileSystemWritableFileStreamLike>;
  getFile: () => Promise<File>;
}

interface ShowSavePicker {
  (options: FilePickerOptions): Promise<FileSystemFileHandleLike>;
}

interface ShowOpenPicker {
  (options: { types?: Array<{ description: string; accept: Record<string, string[]> }>; multiple?: boolean }): Promise<FileSystemFileHandleLike[]>;
}

declare global {
  interface Window {
    showSaveFilePicker?: ShowSavePicker;
    showOpenFilePicker?: ShowOpenPicker;
  }
}

let currentHandle: FileSystemFileHandleLike | null = null;

/**
 * Forget the file this app is bound to (SRS-PERS-022).
 *
 * The binding outlives the document, so without this a File > New roadmap
 * left the previous plan's handle in place and the very next Ctrl+S wrote the
 * new, empty roadmap over it — no picker, no prompt, and no undo, because
 * replacing the document clears the history. It is forgotten on disk too, or
 * the next reload would hand the binding straight back.
 */
export function detachFile(): void {
  currentHandle = null;
  boundFormat = null;
  bindFile(null);
  void forgetHandle();
}

/** Bind to a file, and remember it for the next session (SRS-PERS-035). */
function bindTo(handle: FileSystemFileHandleLike, format: SaveFormat | null = null): void {
  currentHandle = handle;
  boundFormat = format;
  bindFile(handle.name);
  void rememberHandle(handle as unknown as StoredFileHandle);
}

/**
 * Take back the binding a previous session left (SRS-PERS-035).
 *
 * Returns the file's name, or null when there is nothing to take back. The
 * write permission does NOT come back with it — that is the browser's rule —
 * so the state says `needs-permission` until the planner's next save, which
 * carries the gesture a prompt needs.
 */
export async function restoreBinding(): Promise<string | null> {
  const handle = await recallHandle();
  if (!handle) return null;
  // A copy of a saved plan carries the same remembered binding, pointing at
  // the original (SRS-PERS-036).
  if (!isHandleForThisDocument(handle)) {
    await forgetHandle();
    return null;
  }
  currentHandle = handle as unknown as FileSystemFileHandleLike;
  bindFile(handle.name);
  const granted = (await handle.queryPermission?.({ mode: 'readwrite' })) === 'granted';
  setSaveState(granted ? 'saved' : 'needs-permission');
  return handle.name;
}

/**
 * The bytes to write, which are NOT always this page.
 *
 * Built as one file, the page is the whole program and a clone of it is a
 * working app. Under the dev server it is a stub whose only script is
 * `/src/main.tsx`; saving that produces a file that opens to nothing, which
 * is what a planner running the dev build would have got every time. There
 * the built template is fetched instead — and if it is missing, the save
 * FAILS rather than writing a file that cannot open.
 */
type BuiltHtml = { ok: true; html: string } | { ok: false; error: string };

/**
 * Not `/dist-template/index.html`: Vite owns every .html under its root and
 * answers that path with its own transform of the file, dev client and all.
 * The dev server serves the bytes verbatim here instead (vite.config.ts).
 */
const DEV_TEMPLATE_URL = '/__built-template';

async function prepareHtml(doc: GanttDocument): Promise<BuiltHtml> {
  const dev = typeof import.meta !== 'undefined' && import.meta.env?.DEV === true;
  if (!dev || typeof fetch !== 'function') return { ok: true, html: buildEmbeddedHtml(doc) };
  try {
    const resp = await fetch(DEV_TEMPLATE_URL);
    if (!resp.ok) throw new Error(`the template responded ${resp.status}`);
    return { ok: true, html: injectDocumentInto(await resp.text(), doc) };
  } catch (e) {
    return {
      ok: false,
      error: `the dev server has no built app to save (${(e as Error).message}) — run npm run build:template`,
    };
  }
}

/**
 * What actually happened to the bytes.
 *
 * `written` means they reached the file the user chose. The two `downloaded`
 * outcomes mean they went to the downloads folder instead — there is no picker
 * in this browser, or the user cancelled it — which is NOT the file they asked
 * for, so the document stays dirty and the guards keep saying so. These used
 * to be one boolean that the caller read only to gate `markSaved`, so all four
 * outcomes, failure included, looked identical on screen.
 */
export type SaveOutcome =
  | 'written'
  | 'downloaded-no-picker'
  | 'downloaded-cancelled'
  /** The file is known and the browser refused to let us write it. */
  | 'permission-denied'
  | 'failed';
export interface SaveResult {
  outcome: SaveOutcome;
  name: string;
  error?: string;
}

async function writeThrough(
  handle: FileSystemFileHandleLike,
  text: string,
): Promise<SaveResult> {
  const name = handle.name;
  try {
    setSaveState('saving');
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    // The file now holds whatever was just written, so the binding records
    // that — otherwise a Save As to an extensionless name would leave the
    // session thinking the file still held what it held before.
    bindTo(handle, formatForName(handle.name, boundFormat ?? 'html'));
    setSaveState('saved');
    return { outcome: 'written', name };
  } catch (e) {
    // Thrown, this became an unhandled rejection at a caller that neither
    // awaited nor caught — a console event and nothing on screen.
    setSaveState('error', (e as Error).message);
    return { outcome: 'failed', name, error: (e as Error).message };
  }
}

/**
 * Save, asking for everything that needs the planner's gesture FIRST.
 *
 * A picker or a permission prompt raised after an await of real work is
 * refused with no dialog, because the transient activation has expired. The
 * bytes are built after both, which also means Ctrl+S opens its picker on the
 * keystroke rather than after a template fetch.
 */
export async function saveToFile(doc: GanttDocument, suggestedName = 'plan.html'): Promise<SaveResult> {
  let handle = currentHandle;
  let why: SaveOutcome | null = null;
  if (handle) {
    if (!(await verifyWritePermission(handle))) {
      setSaveState('needs-permission');
      return { outcome: 'permission-denied', name: handle.name };
    }
  } else {
    const picked = await pickSaveHandle(suggestedName);
    handle = picked.handle;
    why = picked.why;
  }
  return finishSave(doc, handle, why, suggestedName);
}

export async function saveAs(doc: GanttDocument, suggestedName = 'plan.html'): Promise<SaveResult> {
  const picked = await pickSaveHandle(suggestedName);
  return finishSave(doc, picked.handle, picked.why, suggestedName);
}

/**
 * Keep the bound file level with the screen (SRS-PERS-037).
 *
 * Only where permission is ALREADY granted. `requestPermission` needs a
 * gesture a timer cannot produce, so asking here would be refused silently
 * and the planner would be told nothing; instead the state turns to
 * `needs-permission` and their next Ctrl+S carries the gesture that asks.
 */
export async function autosaveToFile(doc: GanttDocument): Promise<boolean> {
  const handle = currentHandle;
  if (!handle) return false;
  const perm = handle as unknown as { queryPermission?: (d: { mode: string }) => Promise<PermissionState> };
  let permission: PermissionState | 'unknown' = 'unknown';
  try {
    permission = (await perm.queryPermission?.({ mode: 'readwrite' })) ?? 'unknown';
  } catch {
    permission = 'unknown';
  }
  if (!mayAutosave(handle, permission)) {
    // A handle for another file is not a permission problem, and saying so
    // would send the planner to a prompt that would not help.
    if (isHandleForThisDocument(handle)) setSaveState('needs-permission');
    return false;
  }
  // Autosave wrote HTML into whatever the handle was too, so a .json plan was
  // overwritten on a timer without anyone pressing anything (SRS-PERS-040).
  const built = await serializeFor(handle.name, doc, boundFormat ?? 'html');
  if (built.error) {
    setSaveState('error', built.error);
    return false;
  }
  return (await writeThrough(handle, built.text)).outcome === 'written';
}

/**
 * What a file of this name holds (SRS-PERS-040).
 *
 * `finishSave` built HTML and wrote it whatever the handle was, so a plan
 * opened from `sprint.json` — 604 bytes of JSON — came back after one edit and
 * one Ctrl+S as a 430KB HTML document still called `sprint.json`, which the
 * loader then tried to `JSON.parse`. The original was gone and the app could
 * never read the file again.
 *
 * The extension decides it for the three names the loader dispatches on. For
 * anything else — no extension, or one this app does not know — the extension
 * decides NOTHING, because `parseFileContents` reads that class by trying JSON
 * and then YAML, never HTML. Claiming `html` there would leave exactly the old
 * loss in place for that class: a JSON plan opened as `sprint` with no
 * extension, saved, and then unreadable. So the caller passes what the file
 * was last known to hold, and only a file nothing is known about gets the
 * application — which is what this product is, and all the picker offers.
 */
export type SaveFormat = 'html' | 'json' | 'yaml';

export function formatForName(name: string, unknown: SaveFormat = 'html'): SaveFormat {
  if (/\.html?$/i.test(name)) return 'html';
  if (/\.json$/i.test(name)) return 'json';
  if (/\.ya?ml$/i.test(name)) return 'yaml';
  return unknown;
}

/**
 * What the bound file was read as, for the name class the extension cannot
 * settle. Cleared with the binding, because it describes that file alone.
 */
let boundFormat: SaveFormat | null = null;

/** What the bound file holds, as far as this session knows. */
export function getBoundFormat(): SaveFormat | null {
  return boundFormat;
}

/** The bytes that belong in a file of this name, and what kind they are. */
export async function serializeFor(
  name: string,
  doc: GanttDocument,
  unknown: SaveFormat = 'html',
): Promise<{ format: SaveFormat; text: string; mime: string; error?: string }> {
  const format = formatForName(name, unknown);
  if (format === 'json') {
    return { format, text: JSON.stringify(doc, null, 2), mime: 'application/json' };
  }
  if (format === 'yaml') {
    return { format, text: toYaml(doc), mime: 'text/yaml' };
  }
  const built = await prepareHtml(doc);
  if (!built.ok) return { format, text: '', mime: 'text/html', error: built.error };
  return { format, text: built.html, mime: 'text/html' };
}

async function finishSave(
  doc: GanttDocument,
  handle: FileSystemFileHandleLike | null,
  why: SaveOutcome | null,
  suggestedName: string,
): Promise<SaveResult> {
  // The name decides the format, so a plan opened from .json or .yaml is
  // written back as what it was; where the name cannot decide, what the file
  // was read as does (SRS-PERS-040).
  const built = await serializeFor(handle?.name ?? suggestedName, doc, boundFormat ?? 'html');
  if (built.error) {
    setSaveState('error', built.error);
    return { outcome: 'failed', name: suggestedName, error: built.error };
  }
  if (!handle) {
    downloadFile(suggestedName, built.text, built.mime);
    return { outcome: why ?? 'downloaded-no-picker', name: suggestedName };
  }
  return writeThrough(handle, built.text);
}

/** The handle, and — when there is none — WHY there is none. */
async function pickSaveHandle(
  suggestedName: string,
): Promise<{ handle: FileSystemFileHandleLike | null; why: SaveOutcome | null }> {
  if (!window.showSaveFilePicker) return { handle: null, why: 'downloaded-no-picker' };
  try {
    return { handle: await window.showSaveFilePicker({ suggestedName, types: FILE_PICKER_TYPES }), why: null };
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return { handle: null, why: 'downloaded-cancelled' };
    return { handle: null, why: 'downloaded-no-picker' };
  }
}

export function downloadFile(name: string, content: string | Blob, mime = 'text/plain'): void {
  const blob = typeof content === 'string' ? new Blob([content], { type: mime }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // The revoke MUST NOT be synchronous. Revoking before the browser has read
  // the blob cancels the download outright — a whole single-file plan is
  // ~355 KB today and grows with the document. Long enough for the bytes to
  // be taken, short enough not to leak if the page stays open.
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 60_000);
}

/** The file this plan is bound to, if the user opened or saved one. */
export function getCurrentHandle(): FileSystemFileHandleLike | null {
  return currentHandle;
}

/**
 * Does this handle still allow writing?
 *
 * `requestPermission` needs transient user activation, so callers must ask
 * BEFORE any slow work — a download in between expires the activation and the
 * request is denied with no prompt.
 */
export async function verifyWritePermission(handle: FileSystemFileHandleLike): Promise<boolean> {
  const h = handle as unknown as {
    queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
    requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
  };
  try {
    if (await h.queryPermission?.({ mode: 'readwrite' }) === 'granted') return true;
    return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/** Overwrite a handle's file. Returns false rather than throwing. */
export async function writeHtmlToHandle(
  handle: FileSystemFileHandleLike,
  html: string,
): Promise<boolean> {
  try {
    const writable = await handle.createWritable();
    await writable.write(html);
    await writable.close();
    return true;
  } catch (e) {
    console.warn('[PowerRoadmap Update] Write to handle failed', e);
    return false;
  }
}

/**
 * Why an open produced no document.
 *
 * Both branches report through the same return, which ends an asymmetry worth
 * naming: the legacy `<input type=file>` path raised an `alert`, while the
 * File System Access path rethrew into an unhandled rejection — so Firefox and
 * Safari told the user the file was not a roadmap and Chrome and Edge, the only
 * browsers where saving works at all, said nothing.
 */
export type OpenResult =
  | { doc: GanttDocument; name: string; format: SaveFormat }
  | { error: 'cancelled' | 'not-a-roadmap'; name?: string; message?: string };

function readInto(name: string, text: string): OpenResult {
  try {
    const { doc, format } = parseWithFormat(name, text);
    return { doc, name, format };
  } catch (e) {
    return { error: 'not-a-roadmap', name, message: (e as Error).message };
  }
}

export async function openFile(): Promise<OpenResult> {
  if (window.showOpenFilePicker) {
    let handle: FileSystemFileHandleLike;
    try {
      [handle] = await window.showOpenFilePicker({
        types: [
          { description: 'PowerRoadmap', accept: { 'text/html': ['.html'], 'application/json': ['.json'], 'text/yaml': ['.yaml', '.yml'] } as Record<string, string[]> },
        ],
      });
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return { error: 'cancelled' };
      return { error: 'not-a-roadmap', message: (e as Error).message };
    }
    const file = await handle.getFile();
    const result = readInto(file.name, await file.text());
    // Bind ONLY a file that turned out to hold a roadmap: binding one that did
    // not would make the next save overwrite it.
    if ('doc' in result) bindTo(handle, result.format);
    return result;
  }
  return new Promise<OpenResult>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.html,.json,.yaml,.yml';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve({ error: 'cancelled' });
      // A file input yields no handle, so there is nothing to write back to.
      // Leaving the previous binding in place would send the next save to a
      // file the planner is no longer looking at.
      detachFile();
      resolve(readInto(file.name, await file.text()));
    };
    input.click();
  });
}

/**
 * Read the bound file again, discarding what is in memory (SRS-PERS-039).
 *
 * The counterpart to an autosave that writes continuously: once the app can
 * change the file under you, there has to be a way back to what is on disk.
 */
export async function reloadFromFile(): Promise<OpenResult> {
  if (!currentHandle) return { error: 'cancelled' };
  try {
    const file = await currentHandle.getFile();
    return readInto(file.name, await file.text());
  } catch (e) {
    return { error: 'not-a-roadmap', name: currentHandle.name, message: (e as Error).message };
  }
}

export function parseFileContents(name: string, text: string): GanttDocument {
  return parseWithFormat(name, text).doc;
}

/**
 * The same read, plus which of the four branches did it (SRS-PERS-040).
 *
 * A name with no extension, or one this app does not know, is read by trying
 * JSON and then YAML. The save side has to be told which of those two it was,
 * or it would write the application into a data file under a name that gives
 * it no way to find out.
 */
export function parseWithFormat(name: string, text: string): { doc: GanttDocument; format: SaveFormat } {
  if (/\.html?$/i.test(name)) {
    const match = text.match(/<script[^>]*id=["']powerplanner-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match) throw new Error('No embedded PowerRoadmap data found in this HTML file.');
    return { doc: validateDocument(JSON.parse(match[1])), format: 'html' };
  }
  if (/\.json$/i.test(name)) {
    return { doc: validateDocument(JSON.parse(text)), format: 'json' };
  }
  if (/\.ya?ml$/i.test(name)) {
    return { doc: validateDocument(fromYaml(text)), format: 'yaml' };
  }
  // Try JSON first, then YAML
  try {
    return { doc: validateDocument(JSON.parse(text)), format: 'json' };
  } catch {
    return { doc: validateDocument(fromYaml(text)), format: 'yaml' };
  }
}

/** Every export says whether the file was produced, and why not if it was not. */
export type ExportResult = { ok: true; name: string } | { ok: false; error: string };

export function exportJson(doc: GanttDocument): ExportResult {
  downloadFile('plan.json', JSON.stringify(doc, null, 2), 'application/json');
  return { ok: true, name: 'plan.json' };
}

export function exportYaml(doc: GanttDocument): ExportResult {
  downloadFile('plan.yaml', toYaml(doc), 'text/yaml');
  return { ok: true, name: 'plan.yaml' };
}

export function exportSvg(): ExportResult {
  const svg = document.querySelector('.chart-area svg');
  // `if (!svg) return;` was a hard silent no-op: the user clicked Export and
  // nothing happened, with nothing said.
  if (!svg) return { ok: false, error: 'there is no chart on screen to export' };
  const cloned = svg.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(svg as SVGSVGElement, cloned);
  const serialized = new XMLSerializer().serializeToString(cloned);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
  downloadFile('plan.svg', xml, 'image/svg+xml');
  return { ok: true, name: 'plan.svg' };
}

export async function exportPng(scale = 2): Promise<ExportResult> {
  const svg = document.querySelector('.chart-area svg');
  if (!svg) return { ok: false, error: 'there is no chart on screen to export' };
  const cloned = svg.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(svg as SVGSVGElement, cloned);
  const w = Number(cloned.getAttribute('width') ?? 800);
  const h = Number(cloned.getAttribute('height') ?? 600);
  const serialized = new XMLSerializer().serializeToString(cloned);
  const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('the chart could not be rasterised'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, error: 'this browser has no 2D canvas' };
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--color-bg') || '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    // A null blob did nothing at all, and said nothing at all.
    if (!blob) return { ok: false, error: 'the image could not be encoded' };
    downloadFile('plan.png', blob, 'image/png');
    return { ok: true, name: 'plan.png' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Inline computed styles so SVG renders correctly when extracted from the page
function inlineComputedStyles(src: SVGSVGElement, dst: SVGSVGElement): void {
  const srcEls = src.querySelectorAll('*');
  const dstEls = dst.querySelectorAll('*');
  for (let i = 0; i < srcEls.length; i++) {
    const s = srcEls[i];
    const d = dstEls[i] as SVGElement | HTMLElement;
    const cs = getComputedStyle(s);
    const props = ['fill', 'stroke', 'stroke-width', 'opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor'];
    for (const p of props) {
      const v = cs.getPropertyValue(p);
      if (v && v !== 'normal' && v !== 'none' && v !== '') {
        d.style.setProperty(p, v);
      }
    }
  }
  // Apply background fill explicitly on first rect (already exists in our renderer)
  const rootBg = getComputedStyle(document.body).getPropertyValue('--color-bg') || '#fff';
  const bgRect = dst.querySelector('rect');
  if (bgRect && bgRect.getAttribute('fill') === 'var(--color-bg)') {
    bgRect.setAttribute('fill', rootBg);
  }
}
