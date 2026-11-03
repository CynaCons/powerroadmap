# SRS — Settings

Requirements for the web app's settings surface: one scrolling page of titled
sections with a side index, the place every preference is reachable from, and
the route to the agent bridge. Feature tag: `SET`.

Traces up to: [`../srs/SRS-layout.md`](../srs/SRS-layout.md) (the chrome and its
modals), [`SRS-agent-bridge.md`](SRS-agent-bridge.md) (the bridge section's
subject), [`../srs/SRS-persistence.md`](../srs/SRS-persistence.md) (the bound
file the panel reports on).
Plan: `PLAN.md` → v2.36.0.
Reference impl: `src/app/SettingsPanel.tsx`, `src/styles/global.css`.

**Scope:** web only. The native add-in's settings live on the app bar and are
covered by [`../srs-native/`](../srs-native/README.md).

Owner directive 2026-11-02: "lets reintegrate the settings menu from
powerscroll. It's not matching. Don't have the agent bridge option, don't have
the same interface." PowerScroll's shipped panel is therefore the specification
for this surface, and where the two apps differ the difference is stated in the
row's rationale rather than left to be discovered.

## Shape

| ID | Requirement | Rationale | Verification | Trace |
|----|-------------|-----------|--------------|-------|
| SRS-SET-001 `[web]` | Settings shall be one continuously scrolling page of titled sections beside a side index that names every section, not a dialog holding a single section. | The surface held one section, About & updates, and there was nowhere to put a second: every other preference had to go somewhere else, which is why the look settings live in the command bar's document context and the agent bridge lives in the header. A list of sections is what makes the panel the place a planner looks. PowerScroll's panel is the shape being matched. | Test: `tests/e2e/settings-panel.spec.ts` | `app/SettingsPanel` `SECTIONS`; `styles/global.css` `.settings-panel` |
| SRS-SET-002 `[web]` | The side index shall mark the section currently at the top of the scrolling pane; activating an entry shall scroll that section to the top, or as far as the pane goes, and shall mark it either way. | An index that does not follow the scroll is a table of contents, not a position. Both directions are needed: reading moves the mark, clicking moves the page. The second clause is not a hedge — a section near the end cannot reach the top, because there is nothing below it to scroll up into: measured on the five-section panel, the bridge section stops 77px down with the pane already at its maximum. Writing "shall scroll to the top" flatly would have made the requirement false for two of the five entries, and the gate would then have been relaxed to fit it rather than the other way round. | Test: `tests/e2e/settings-panel.spec.ts` | `app/SettingsPanel` `syncActiveSection`/`jumpTo` |
| SRS-SET-003 `[web]` | The last section shall be able to reach the top of the pane, so that the index can mark it, however short that section is. | A section shorter than the pane can never scroll its own heading to the top, so the index would skip it for ever — the one entry a planner cannot confirm they are looking at. Trailing room, plus treating "scrolled to the bottom" as the last section, closes both halves. | Test: `tests/e2e/settings-panel.spec.ts` | `styles/global.css` `.settings-panel__section:last-child`; `syncActiveSection` bottom case |
| SRS-SET-004 `[web]` | The panel shall take focus when it opens, keep Tab inside it while it is open, close on Escape and on a press that both starts and ends on the backdrop, and return focus where it came from. | SRS-LAY-058 states this for modals generally; it is restated here because the panel replaces the dialog that row names, and because the backdrop rule has a failure mode of its own: a press released outside a control it started on must not count as a click on the backdrop, or dragging a slider closes the panel. | Test: `tests/e2e/settings-panel.spec.ts` | `app/SettingsPanel` `trapFocus`; `app/useDialogFocus`; SRS-LAY-058 |
| SRS-SET-005 `[web]` | At phone width the index shall become a horizontally scrolling strip above the sections, and a setting's label and control shall stack rather than sit side by side. | A 248px index beside a 180px label column does not fit a 375px screen, and the panel is where the bridge is turned on — a surface that is unreachable on a phone is a surface that is not there. | Test: `tests/e2e/settings-panel.spec.ts` (mobile project) | `styles/global.css` `@media (max-width: 768px)` |
| SRS-SET-006 `[web]` | The panel shall take every colour from the theme tokens, and shall be legible in each theme the app offers. | PowerScroll's panel hard-codes its greys because it has one theme. This app has dark, light and print, and a panel built from literals would read as light-on-light the moment the planner switches — the defect SRS-THEME rows exist for. Matching PowerScroll's interface does not mean importing a constraint it has and this app does not. | Test: `tests/e2e/settings-panel.spec.ts`; Review (no colour literals in the panel's rules) | `styles/global.css` `.settings-panel*` |

## Contents

| ID | Requirement | Rationale | Verification | Trace |
|----|-------------|-----------|--------------|-------|
| SRS-SET-010 `[web]` | Every setting a planner can change anywhere in the chrome shall also be changeable from the panel. | The converse of SRS-ABR-025 for people rather than agents, and the reason the panel exists: a preference reachable only from a context menu inside a bar that appears when something is selected is a preference most planners never find. | Test: `tests/unit/settingsParity.test.ts` (every settings-bearing store field against the panel's bindings) | `app/SettingsPanel`; `app/CommandBar` |
| SRS-SET-011 `[web]` | A setting offered in both the panel and the command bar shall read and write one store field, so that changing it in either place moves the other. | Two controls over one preference is the commonest way a settings panel starts lying: the copy in the panel reads a snapshot and the planner sets it twice. Nothing is moved out of the bar — the bar is the fast path during work and the panel is the place to find things. | Test: `tests/e2e/settings-panel.spec.ts` (set in the panel, assert in the bar, and back) | `app/SettingsPanel`; `stores/viewStore`; `stores/documentStore` |
| SRS-SET-012 `[web]` | The panel shall state which file the plan is bound to, in what format it will be written, and whether changes are reaching it. | The planner's one question about saving is whether their work is landing in the file they opened, and until now the only answer was the window title. SRS-PERS-040 makes the format part of the binding, so the format is part of the answer: a plan bound to `sprint.json` is not going to be written as the app. | Test: `tests/e2e/settings-panel.spec.ts` | `app/SettingsPanel` saving section; `persistence/fileIo` `getCurrentHandle`/`getBoundFormat` |
| SRS-SET-013 `[web]` | The panel shall report the bridge's state in the side index as well as inside the bridge section. | The state a planner most needs to see is the one that says something else can edit their plan, and the index is the only part of the panel visible from every section. | Test: `tests/e2e/settings-panel.spec.ts` | `app/SettingsPanel` index meta; `stores/bridgeStore` |
| SRS-SET-014 `[web]` | The panel's footer shall state that changes apply immediately and that Escape closes, and shall name the running version. | The panel has no Save or Cancel, which is only obvious once someone says so; and the version is the first thing anyone is asked for when they report a problem. Both are PowerScroll's footer. | Test: `tests/e2e/settings-panel.spec.ts` | `app/SettingsPanel` footer |

## Open items

- SRS-SET-010 is verified against the store fields that *are* settings. A field
  added to a settings store without a panel binding fails that test; a
  preference held somewhere that is not a settings store would not be seen by
  it, and no gate covers that case.
