import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { X, Palette, CalendarDays, Save, Bot, Info } from 'lucide-react';
import { APP_VERSION } from '../version';
import { useDocumentStore } from '../stores/documentStore';
import { useFileStore } from '../stores/fileStore';
import { useBridgeStore, BRIDGE_STATUS_LABEL } from '../stores/bridgeStore';
import { checkForUpdate, performUpdate, type UpdateInfo } from '../utils/updateChecker';
import { formatForName, getBoundFormat, getCurrentHandle, saveAs } from '../persistence/fileIo';
import { notify } from '../stores/noticeStore';
import { DEFAULT_BRIDGE_URL } from '../agent/protocol';
import { gridDelimiterOf, weekendDisplayOf,
  rowSeparatorOf,
  rowSeparatorWidthOf,
  rowSeparatorScopeOf,
  ROW_SEPARATOR_WIDTHS
} from '../types/document';
import type { GridDelimiter, ThemeName, WeekendDisplay, RowSeparator, RowSeparatorScope} from '../types/document';
import type { DocOp } from '../stores/docOps';
import { useDialogFocus } from './useDialogFocus';
import { OVERLAP } from './CommandBar';

/**
 * Settings — one scrolling page of sections beside a side index (SRS-SET-001).
 *
 * Owner directive 2026-11-02: PowerScroll's panel is the shape being matched,
 * so the index, the scroll spy, the row grid and the footer are its behaviour
 * rather than a new design. What is not copied is its palette: that app has one
 * theme and hard-codes its greys, and this one has three, so every colour here
 * comes from a token (SRS-SET-006).
 *
 * Nothing is moved out of the command bar. The bar is the fast path while
 * working and the panel is the place to find things, and both read and write
 * the same store field so neither can show a stale answer (SRS-SET-011).
 */

/** One entry per section, in page order — the side index is built from this. */
const SECTIONS = [
  { id: 'look', label: 'Chart look', icon: Palette },
  { id: 'calendar', label: 'Calendar & time', icon: CalendarDays },
  { id: 'saving', label: 'Saving & files', icon: Save },
  { id: 'bridge', label: 'Agent bridge', icon: Bot },
  { id: 'about', label: 'About & updates', icon: Info },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

const THEMES: { value: ThemeName; label: string; hint: string }[] = [
  { value: 'dark', label: 'Dark', hint: 'Light marks on a dark sheet' },
  { value: 'light', label: 'Light', hint: 'Dark marks on a light sheet' },
  { value: 'print', label: 'Print', hint: 'Black on white, for paper' },
];

const DELIMITERS: { value: GridDelimiter; label: string; hint: string }[] = [
  { value: 'none', label: 'None', hint: 'No vertical rules in the plot' },
  { value: 'day', label: 'Day', hint: 'A rule on every day boundary' },
  { value: 'week', label: 'Week', hint: 'A rule on every week boundary' },
  { value: 'month', label: 'Month', hint: 'A rule on the first of each month' },
  { value: 'quarter', label: 'Quarter', hint: 'A rule on each fiscal quarter boundary' },
];

const WEEKENDS: { value: WeekendDisplay; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Non-working days look like any other day' },
  { value: 'shaded', label: 'Shaded', hint: 'Non-working days are shaded behind the bars' },
];

const ROW_SEPARATOR_CHOICES: { value: RowSeparator; label: string; hint: string }[] = [
  { value: 'none', label: 'None', hint: 'No rule between rows' },
  { value: 'solid', label: 'Line', hint: 'An unbroken rule' },
  { value: 'dashed', label: 'Dashed', hint: 'A broken rule' },
  { value: 'dotted', label: 'Dotted', hint: 'A rule of dots' },
];

const ROW_SEPARATOR_WIDTH_CHOICES: { value: number; label: string; hint: string }[] =
  ROW_SEPARATOR_WIDTHS.map((w) => ({
    value: w,
    label: `${w}px`,
    hint: w === 1 ? 'A hairline' : `${w} pixels thick`,
  }));

const ROW_SEPARATOR_SCOPE_CHOICES: { value: RowSeparatorScope; label: string; hint: string }[] = [
  { value: 'groups', label: 'Between sections', hint: 'A rule above each section heading only' },
  { value: 'all', label: 'Between every row', hint: 'A rule between every row in the plan' },
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DOW = [
  { day: 1, label: 'M', full: 'Monday' },
  { day: 2, label: 'T', full: 'Tuesday' },
  { day: 3, label: 'W', full: 'Wednesday' },
  { day: 4, label: 'T', full: 'Thursday' },
  { day: 5, label: 'F', full: 'Friday' },
  { day: 6, label: 'S', full: 'Saturday' },
  { day: 0, label: 'S', full: 'Sunday' },
];

type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'updating-live'
  | 'updating-download'
  | 'downloaded'
  | 'failed';

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  // ── Dialog behaviour ─────────────────────────────────────────────────────
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus belongs inside a modal while it is open and goes back where it came
  // from when it closes (SRS-LAY-058, SRS-SET-004).
  useDialogFocus(panelRef);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Tab cycles inside the panel. Re-queried on each press, because which
  // controls exist depends on the bridge toggle and the update state.
  const trapFocus = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const focusable = panelRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // ── One scrolling page, the side index follows it ────────────────────────
  const [activeSection, setActiveSection] = useState<SectionId>('look');

  /**
   * The section being read is the last one whose heading has passed the top of
   * the pane; at the very bottom it is the last section, even when that section
   * is too short to ever reach the top (SRS-SET-003).
   */
  const syncActiveSection = useCallback(() => {
    const pane = scrollRef.current;
    if (!pane) return;
    if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) {
      setActiveSection(SECTIONS[SECTIONS.length - 1].id);
      return;
    }
    let current: SectionId = SECTIONS[0].id;
    for (const { id } of SECTIONS) {
      const el = pane.querySelector<HTMLElement>(`[data-section="${id}"]`);
      if (el && el.offsetTop - pane.scrollTop <= 48) current = id;
    }
    setActiveSection(current);
  }, []);

  const jumpTo = (id: SectionId) => {
    const pane = scrollRef.current;
    const el = pane?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (!pane || !el) return;
    pane.scrollTo({ top: el.offsetTop - 24, behavior: 'smooth' });
    setActiveSection(id);
  };

  const bridgeStatus = useBridgeStore((s) => s.status);
  const bridgeEnabled = useBridgeStore((s) => s.enabled);

  /**
   * Keep the marked entry in sight.
   *
   * At phone width the index is a horizontally scrolling strip, and only three
   * of the five entries fit — so without this, reading down to the bridge
   * section marks an entry that is off to the right, where nothing says it is
   * marked. `nearest` on both axes, so an entry already visible does not move.
   */
  const indexRef = useRef<HTMLElement>(null);
  useEffect(() => {
    indexRef.current
      ?.querySelector<HTMLElement>('[aria-current="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeSection]);

  return createPortal(
    <div
      className="settings-scrim"
      data-testid="settings-scrim"
      role="presentation"
      // Only a press that STARTS on the backdrop closes — a drag that began on
      // a control and ended outside it must not (SRS-SET-004).
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="settings-panel"
        data-testid="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={trapFocus}
      >
        <header className="settings-panel__header">
          <div className="settings-panel__heading">
            <h2 className="settings-panel__title" id="settings-title">Settings</h2>
            <PlanContext />
          </div>
          <button
            ref={closeRef}
            type="button"
            className="settings-panel__close"
            onClick={onClose}
            aria-label="Close settings"
            title="Close (Esc)"
            data-testid="settings-close"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>

        <div className="settings-panel__body">
          <nav
            ref={indexRef}
            className="settings-panel__index"
            aria-label="Settings sections"
            data-testid="settings-index"
          >
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={`settings-panel__index-item${activeSection === id ? ' is-active' : ''}`}
                aria-current={activeSection === id ? 'true' : undefined}
                onClick={() => jumpTo(id)}
                data-testid={`settings-index-${id}`}
              >
                <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
                <span className="settings-panel__index-label">{label}</span>
                {/* The one state a planner most needs to see is that something
                    else may be editing their plan, and the index is the only
                    part visible from every section (SRS-SET-013). */}
                {id === 'bridge' && (
                  <span
                    className="settings-panel__index-meta"
                    style={{ color: BRIDGE_STATUS_LABEL[bridgeStatus].token }}
                    data-testid="settings-index-bridge-meta"
                  >
                    {bridgeEnabled ? BRIDGE_STATUS_LABEL[bridgeStatus].text.split(' ')[0] : 'Off'}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div
            className="settings-panel__scroll"
            ref={scrollRef}
            onScroll={syncActiveSection}
            data-testid="settings-scroll"
          >
            <LookSection />
            <CalendarSection />
            <SavingSection />
            <BridgeSection />
            <AboutSection />
          </div>
        </div>

        <footer className="settings-panel__footer">
          <span>Changes apply at once · Esc closes</span>
          <span className="settings-panel__mono">PowerRoadmap v{APP_VERSION}</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Shared scaffolding                                                  */
/* ------------------------------------------------------------------ */

function PlanContext() {
  const title = useDocumentStore((s) => s.doc.title);
  const name = useFileStore((s) => s.name);
  return (
    <span className="settings-panel__context" data-testid="settings-context">
      {title || 'Untitled'}
      {name ? ` · ${name}` : ''}
    </span>
  );
}

function SectionHead({ id, description }: { id: SectionId; description: string }) {
  return (
    <div className="settings-panel__section-head">
      <h3 className="settings-panel__section-title" id={`settings-h-${id}`}>
        {SECTIONS.find((s) => s.id === id)?.label}
      </h3>
      <p className="settings-panel__section-desc">{description}</p>
    </div>
  );
}

function Section({
  id,
  description,
  children,
}: {
  id: SectionId;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-panel__section" data-section={id} aria-labelledby={`settings-h-${id}`}>
      <SectionHead id={id} description={description} />
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="settings-panel__row">
      <span className="settings-panel__row-label">{label}</span>
      <div className="settings-panel__row-control">{children}</div>
    </div>
  );
}

/**
 * A choice among a handful of named options.
 *
 * Real radio inputs stretched invisibly over each tile, rather than buttons
 * with `aria-checked`: that is what keeps arrow keys working inside the group
 * and lets a test assert `toBeChecked()` on the thing the planner clicked.
 */
function Choice<T extends string | number | boolean>({
  name,
  value,
  options,
  onPick,
  ariaLabel,
  testId,
}: {
  name: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; hint?: string; title?: string }>;
  onPick: (value: T) => void;
  ariaLabel: string;
  testId: string;
}) {
  return (
    <div className="settings-panel__choice" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <label
          key={String(o.value)}
          className={`settings-panel__tile${value === o.value ? ' is-active' : ''}`}
          title={o.hint ?? o.title}
        >
          <input
            type="radio"
            name={name}
            className="settings-panel__tile-input"
            checked={value === o.value}
            onChange={() => onPick(o.value)}
            data-testid={`${testId}-${String(o.value)}`}
          />
          <span className="settings-panel__tile-label">{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chart look                                                          */
/* ------------------------------------------------------------------ */

function LookSection() {
  const theme = useDocumentStore((s) => s.doc.style.theme);
  const setTheme = useDocumentStore((s) => s.setTheme);
  const allowOverlap = useDocumentStore((s) => s.doc.style.allowOverlap ?? false);
  const setAllowOverlap = useDocumentStore((s) => s.setAllowOverlap);
  const calendar = useDocumentStore((s) => s.doc.calendar);
  const applyBatch = useDocumentStore((s) => s.applyBatch);
  const style = useDocumentStore((s) => s.doc.style);
  const setRowSeparator = useDocumentStore((s) => s.setRowSeparator);
  const separator = rowSeparatorOf(style);

  /**
   * Written as operations, which is what an agent sends too (SRS-ABR-025).
   * The command bar does the same, so the two controls cannot drift into two
   * write paths with different cascade and history behaviour.
   */
  const patchCalendar = (patch: { gridDelimiter?: GridDelimiter; weekendDisplay?: WeekendDisplay }) => {
    const ops: DocOp[] = [];
    if (patch.gridDelimiter !== undefined) ops.push({ op: 'set_grid_delimiter', delimiter: patch.gridDelimiter });
    if (patch.weekendDisplay !== undefined) ops.push({ op: 'set_weekend_display', display: patch.weekendDisplay });
    if (ops.length > 0) applyBatch(ops, 'user');
  };

  return (
    <Section id="look" description="How the chart is drawn. Saved with the plan, so it travels with the file.">
      <Row label="Theme">
        <Choice
          name="settings-theme"
          value={theme}
          options={THEMES}
          onPick={setTheme}
          ariaLabel="Theme"
          testId="settings-theme"
        />
      </Row>

      <Row label="Bars on the same dates">
        <Choice
          name="settings-overlap"
          value={allowOverlap}
          options={OVERLAP}
          onPick={setAllowOverlap}
          ariaLabel="Bars on the same dates"
          testId="settings-overlap"
        />
      </Row>

      <Row label="Grid delimiters">
        <Choice
          name="settings-delimiter"
          value={gridDelimiterOf(calendar)}
          options={DELIMITERS}
          onPick={(delimiter) => patchCalendar({ gridDelimiter: delimiter })}
          ariaLabel="Grid delimiters"
          testId="settings-delimiter"
        />
      </Row>

      {/* The rule between rows (SRS-LAY-061). The width and the scope only
          appear once there is a line to apply them to — two dead controls under
          "None" is the kind of menu the owner asked to be rid of elsewhere. */}
      <Row label="Row separator">
        <div className="settings-panel__stack">
          <Choice
            name="settings-rowsep"
            value={separator}
            options={ROW_SEPARATOR_CHOICES}
            onPick={(rowSeparator) => setRowSeparator({ rowSeparator })}
            ariaLabel="Row separator"
            testId="settings-rowsep"
          />
          {separator !== 'none' && (
            <>
              <Choice
                name="settings-rowsep-width"
                value={rowSeparatorWidthOf(style)}
                options={ROW_SEPARATOR_WIDTH_CHOICES}
                onPick={(rowSeparatorWidth) => setRowSeparator({ rowSeparatorWidth })}
                ariaLabel="Row separator width"
                testId="settings-rowsep-width"
              />
              <Choice
                name="settings-rowsep-scope"
                value={rowSeparatorScopeOf(style)}
                options={ROW_SEPARATOR_SCOPE_CHOICES}
                onPick={(rowSeparatorScope) => setRowSeparator({ rowSeparatorScope })}
                ariaLabel="Where the row separator is drawn"
                testId="settings-rowsep-scope"
              />
            </>
          )}
        </div>
      </Row>

      <Row label="Weekends">
        <div className="settings-panel__stack">
          <Choice
            name="settings-weekend"
            value={weekendDisplayOf(calendar)}
            options={WEEKENDS}
            onPick={(display) => patchCalendar({ weekendDisplay: display })}
            ariaLabel="Weekend display"
            testId="settings-weekend"
          />
          <span className="settings-panel__hint">
            Which days count as non-working is set under Calendar &amp; time. This decides
            whether the plot says so.
          </span>
        </div>
      </Row>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Calendar & time                                                     */
/* ------------------------------------------------------------------ */

function CalendarSection() {
  const fiscalYearStart = useDocumentStore((s) => s.doc.calendar.fiscalYearStart);
  const setFiscalYearStart = useDocumentStore((s) => s.setFiscalYearStart);
  const workingDays = useDocumentStore((s) => s.doc.calendar.workingDays);
  const setWorkingDays = useDocumentStore((s) => s.setWorkingDays);

  const toggle = (day: number) => {
    setWorkingDays(
      workingDays.includes(day) ? workingDays.filter((d) => d !== day) : [...workingDays, day],
    );
  };

  return (
    <Section id="calendar" description="What the time axis counts from, and which days work happens on.">
      <Row label="Fiscal year starts">
        <select
          className="settings-panel__select"
          aria-label="Fiscal year starts"
          value={fiscalYearStart}
          onChange={(e) => setFiscalYearStart(Number(e.target.value))}
          data-testid="settings-fiscal-year"
        >
          {MONTHS.map((label, i) => (
            <option key={label} value={i + 1}>{label}</option>
          ))}
        </select>
      </Row>

      <Row label="Working days">
        <div className="settings-panel__stack">
          <div className="settings-panel__days" role="group" aria-label="Working days">
            {DOW.map(({ day, label, full }) => (
              <button
                key={day}
                type="button"
                className={`settings-panel__day${workingDays.includes(day) ? ' is-active' : ''}`}
                aria-pressed={workingDays.includes(day)}
                aria-label={`${full}, ${workingDays.includes(day) ? 'a working day' : 'not a working day'}`}
                onClick={() => toggle(day)}
                data-testid={`settings-workday-${day}`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="settings-panel__hint">
            Non-working days are shaded in the plot only while Weekends is set to Shaded.
          </span>
        </div>
      </Row>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Saving & files                                                      */
/* ------------------------------------------------------------------ */

const FORMAT_WORD: Record<string, string> = {
  html: 'a single-file app holding the plan',
  json: 'JSON',
  yaml: 'YAML',
};

function SavingSection() {
  const doc = useDocumentStore((s) => s.doc);
  const name = useFileStore((s) => s.name);
  const state = useFileStore((s) => s.state);
  const detail = useFileStore((s) => s.detail);
  const revision = useDocumentStore((s) => s.revision);
  const savedRevision = useDocumentStore((s) => s.savedRevision);

  // Read through the binding, so this says what a save would actually do
  // rather than what the extension suggests (SRS-PERS-040, SRS-SET-012).
  const format = name ? (getBoundFormat() ?? formatForName(name)) : null;

  return (
    <Section id="saving" description="Where your changes go while you work.">
      <Row label="This plan">
        <div className="settings-panel__stack">
          <span className="settings-panel__mono" data-testid="settings-file-name">
            {name ?? 'Not linked to a file'}
          </span>
          <span className="settings-panel__hint" data-testid="settings-file-format">
            {name && format
              ? `Written back as ${FORMAT_WORD[format] ?? format}, because that is what this file already holds.`
              : 'Save to a file and every change is written back to it, as well as kept in this browser.'}
          </span>
          <button
            type="button"
            className="settings-panel__btn"
            onClick={() => void saveAs(doc)}
            data-testid="settings-save-as"
          >
            {name ? 'Save a copy…' : 'Save to a file…'}
          </button>
        </div>
      </Row>

      <Row label="State">
        <div className="settings-panel__stack">
          <span data-testid="settings-save-state">
            {state === 'saving'
              ? 'Saving…'
              : state === 'needs-permission'
                ? 'This browser has not been allowed to write the file — press Ctrl+S'
                : state === 'error'
                  ? detail
                    ? `Not saved: ${detail}`
                    : 'Not saved'
                  : name
                    ? revision === savedRevision
                      ? 'Every change is written back to this file.'
                      : 'There are changes not yet in the file.'
                    : 'Kept in this browser only.'}
          </span>
          <span className="settings-panel__hint">
            Changes are also kept in this browser, so closing the tab does not lose work.
          </span>
        </div>
      </Row>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Agent bridge                                                        */
/* ------------------------------------------------------------------ */

function BridgeSection() {
  const enabled = useBridgeStore((s) => s.enabled);
  const status = useBridgeStore((s) => s.status);
  const url = useBridgeStore((s) => s.url);
  const lastError = useBridgeStore((s) => s.lastError);
  const commandCount = useBridgeStore((s) => s.commandCount);
  const lastCommand = useBridgeStore((s) => s.lastCommand);
  const agents = useBridgeStore((s) => s.agents);
  const setEnabled = useBridgeStore((s) => s.setEnabled);
  const setUrl = useBridgeStore((s) => s.setUrl);

  return (
    <Section
      id="bridge"
      description="Let an AI agent on this computer read and write this plan through the PowerRoadmap MCP server."
    >
      <Row label="Connection">
        <div className="settings-panel__stack">
          <label className="settings-panel__switch-row">
            <input
              type="checkbox"
              className="settings-panel__switch"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              data-testid="settings-bridge-toggle"
            />
            <span>Let a local agent edit this plan</span>
          </label>

          <div className="settings-panel__status">
            <span
              className="settings-panel__dot"
              style={{ backgroundColor: BRIDGE_STATUS_LABEL[status].token }}
              aria-hidden="true"
            />
            <span
              style={{ color: BRIDGE_STATUS_LABEL[status].token }}
              data-testid="settings-bridge-status"
              data-status={status}
            >
              {BRIDGE_STATUS_LABEL[status].text}
            </span>
            {/* Served, not attempted: the difference between "connected" and
                "working" is the question a planner actually has when nothing
                appears to be happening (SRS-ABR-065). */}
            {commandCount > 0 && (
              <span className="settings-panel__muted" data-testid="settings-bridge-count">
                · {commandCount} command{commandCount === 1 ? '' : 's'}
                {lastCommand ? ` (last: ${lastCommand})` : ''}
              </span>
            )}
          </div>

          {agents.length > 0 && (
            <span className="settings-panel__hint" data-testid="settings-bridge-agents">
              Attached: {agents.map((a) => a.label).join(', ')}
            </span>
          )}

          {status === 'displaced' && (
            <span className="settings-panel__hint is-warn" data-testid="settings-bridge-displaced">
              Another plan connected to the bridge, so this one stopped. Tick the box again
              to take the connection back.
            </span>
          )}

          {status === 'error' && lastError && (
            <span className="settings-panel__hint is-error" data-testid="settings-bridge-error">
              {lastError}
            </span>
          )}

          <span className="settings-panel__hint">
            Off by default, and off again in any other browser. Only enable it on your own
            machine — anything that can reach this port can edit the plan.
          </span>
        </div>
      </Row>

      {enabled && (
        <Row label="Server address">
          <div className="settings-panel__stack">
            <input
              type="text"
              className="settings-panel__text-input"
              value={url}
              placeholder={DEFAULT_BRIDGE_URL}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Bridge server address"
              data-testid="settings-bridge-url"
            />
            <span className="settings-panel__hint">
              Leave this empty for the default shown above. Type a full address only if the
              server had to start on another port.
            </span>
          </div>
        </Row>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* About & updates                                                     */
/* ------------------------------------------------------------------ */

function AboutSection() {
  const doc = useDocumentStore((s) => s.doc);
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [inPlaceFailed, setInPlaceFailed] = useState(false);

  const check = async () => {
    setStatus('checking');
    const result = await checkForUpdate(APP_VERSION, { force: true });
    if (result?.available && result.latestVersion) {
      setInfo(result);
      setStatus('available');
    } else if (result) {
      setInfo(result);
      setStatus('up-to-date');
    } else {
      setStatus('failed');
    }
  };

  const update = async () => {
    if (!info?.latestVersion) return;
    // Whether the file can be rewritten in place decides the wording, so it is
    // settled before the work starts rather than guessed afterwards — and it
    // asks the same question `performUpdate` does. A plan bound to a `.json`
    // file is never rewritten in place (SRS-PERS-040), so saying "updating
    // this file" there told the planner the opposite of what happened.
    const bound = getCurrentHandle();
    setStatus(bound && formatForName(bound.name) === 'html' ? 'updating-live' : 'updating-download');

    const result = await performUpdate(doc, APP_VERSION, info.latestVersion, info.tag, info.downloadUrl);

    if (!result.ok) {
      setStatus('failed');
      notify('The update could not be fetched.', 'fail');
      return;
    }
    // live-swap reloads the page, so there is nothing left to show.
    if (result.mode === 'download') {
      setInPlaceFailed(result.inPlaceFailed === true);
      setStatus('downloaded');
      // Through the one live region too, so the report survives closing this
      // panel — which used to lose it.
      notify(
        result.inPlaceFailed
          ? 'Could not rewrite this file. The new version and a backup are both in your downloads.'
          : `Downloaded version ${info.latestVersion}. Open the new file to continue.`,
        result.inPlaceFailed ? 'fail' : 'done',
      );
    }
  };

  return (
    <Section id="about" description="Updates are fetched from GitHub only when you ask.">
      <Row label="Version">
        <div className="settings-panel__status">
          <span className="settings-panel__mono" data-testid="settings-app-version">
            PowerRoadmap v{APP_VERSION}
          </span>
          {status !== 'checking' && status !== 'available' && (
            <button type="button" className="settings-panel__btn" onClick={check} data-testid="settings-check-update">
              Check for updates
            </button>
          )}
          {status === 'checking' && (
            <span className="settings-panel__muted" data-testid="settings-update-checking">Checking…</span>
          )}
          {status === 'available' && info && (
            <>
              <span style={{ color: 'var(--color-bridge-on)' }}>v{info.latestVersion} available</span>
              <button
                type="button"
                className="settings-panel__btn settings-panel__btn--primary"
                onClick={() => void update()}
                data-testid="settings-update"
              >
                Update
              </button>
            </>
          )}
        </div>
      </Row>

      <Row label="What happens">
        {/* Not a live region: the status bar holds the one announced copy, and
            two polite regions mutating together stall a screen reader. */}
        <p className="settings-panel__note" data-testid="settings-update-note">
          {status === 'up-to-date' && `You are on the newest release (${info?.latestVersion ?? APP_VERSION}).`}
          {status === 'available' && `Version ${info?.latestVersion} is available.`}
          {status === 'updating-live' &&
            'Updating this file in place. A backup is saved first, then the page reloads.'}
          {status === 'updating-download' && 'Downloading the new version with this plan inside it.'}
          {status === 'downloaded' && !inPlaceFailed &&
            'Downloaded. Open the new file to continue — the one you have now is untouched.'}
          {status === 'downloaded' && inPlaceFailed &&
            'This file could not be rewritten, so the new version was downloaded instead. A backup of the current one was downloaded first, and the file you have open may not have survived the attempt — open the downloaded copy.'}
          {status === 'failed' && (
            <>
              Could not reach the update service.{' '}
              {info?.releaseUrl && (
                <a href={info.releaseUrl} target="_blank" rel="noreferrer">Open releases</a>
              )}
            </>
          )}
          {(status === 'idle' || status === 'checking') &&
            'Updating keeps this plan and swaps the app around it. If this file was opened from disk, it is rewritten in place.'}
        </p>
      </Row>
    </Section>
  );
}
