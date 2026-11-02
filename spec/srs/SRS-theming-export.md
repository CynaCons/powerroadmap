# SRS — Theming & Export

Requirements for visual themes and presentation-grade export. Feature tags:
`THEME` (themes) and `EXP` (export).

Traces up to: `../visual-vocabulary.md`, `../data-model.md` (StyleSettings).

## Theming

| ID | Requirement | Rationale | Verification | Trace |
|----|-------------|-----------|--------------|-------|
| SRS-THEME-001 | The system shall support three themes: light, dark, and print. | Screen (light/dark) and paper (print) need different palettes. | Review | data-model (ThemeName); visual-vocabulary |
| SRS-THEME-002 | Themes shall be expressed as token sets (background, surface, text, grid, accent) so every element recolours coherently. | Centralised tokens keep the chart visually consistent. | Review | visual-vocabulary §themes |
| SRS-THEME-003 `[web]` | The print theme shall be high-contrast and chrome-free (chart only). | Printed output must be legible and free of app UI. | Demo | visual-vocabulary; print stylesheet |
| SRS-THEME-004 | A per-element `color` shall override the theme accent for that element. | Categorical coloring within a theme. | Review | SRS-ELEM-004 |
| SRS-THEME-005 `[web]` | A document that has never chosen a theme shall start in the one the operating system asks for, and that choice shall be written into the document like any other. | The theme belongs to the document so that a plan looks the same to everyone who opens it, and a `prefers-color-scheme` rule would have repainted a document that had explicitly chosen light. But a new document was answering the question with a hardcoded `light`, so a planner whose machine is in dark mode opened a white window every time (post-release testing, v2.34.1). The OS is therefore consulted once, at creation, and nothing re-decides it afterwards. | Test: `tests/unit/theme.test.ts` | `utils/theme` `initialTheme`; `utils/sample`, `utils/templates` |
| SRS-THEME-006 `[web]` | Text in the app's own chrome shall meet WCAG AA contrast against the surface behind it, in every theme. | The side panel's section headings — the four words the panel is navigated by — were set in `--color-text-dim` at 3.00:1 in both themes (post-release testing, v2.34.1). `dim` is for text that is genuinely secondary; a heading is not. | Test: `tests/e2e/phone-and-theme.spec.ts` | `styles/global.css` `.cmdbar__section-head` |
| SRS-THEME-007 `[web]` | Today and a deadline shall be distinguishable by colour, not by stroke style alone. | --color-today and --color-deadline were both #B3382C in every theme, so the one line that says now and the lines that say this is due differed only in that one was dashed. A reader scanning a dense plot has to measure the dash to tell them apart, and a printed or exported chart loses the distinction first. | Test: tests/unit/themeTokens.test.ts | styles/global.css token blocks |
| SRS-THEME-008 `[web]` | When the system asks for reduced motion the app shall stop moving things, while keeping the cross-fades that carry meaning. | The whole prefers-reduced-motion block was one selector, stopping one indicator dot. Section collapse, dialog and palette entry, the chart's own transitions and the camera move on a scale change all still played. Panning a large object is the trigger the guidance names first. The rule is to remove or REPLACE motion, so colour and opacity fades stay. | Test: tests/e2e/reduced-motion.spec.ts | styles/global.css prefers-reduced-motion block |
| SRS-THEME-009 `[web]` | A hover state shall differ from the surface the control sits on, and every element the planner can click shall have one. | The header's own background IS `--color-bg-panel`, and the header button's hover painted `--color-bg-panel`: white on white. Measured by forcing :hover and diffing the pixels, 25 of 48 controls repainted nothing at all. In the chart only task bars answered the pointer - a milestone, a marker and a row each repainted 0 pixels, so nothing said they could be clicked. Buttons inside a cluster sit on a different surface again and go the other way, to the panel colour. | Test: tests/e2e/hover-states.spec.ts | styles/global.css `.app-header__btn:hover`, `.app-header__cluster .app-header__btn:hover`, the chart hover rules |

## Export `[web]`

The PowerPoint surface emits native shapes (see `SRS-powerpoint.md`) rather than
exporting image/vector files, so these requirements apply to the web surface.

| ID | Requirement | Rationale | Verification | Trace |
|----|-------------|-----------|--------------|-------|
| SRS-EXP-001 `[web]` | The system shall export the chart as SVG with computed styles inlined, so the file renders standalone. | Vector output for decks/docs without external CSS. | Demo | fileIo/export; spec/visual generator |
| SRS-EXP-002 `[web]` | The system shall export PNG at selectable scale (1x, 2x) by rasterizing the SVG. | Raster output for tools that need bitmaps; 2x for retina. | Demo | export |
| SRS-EXP-003 `[web]` | The system shall produce print/PDF output via the print theme (chart only). | Presentation-grade hard copy. | Demo | print stylesheet |
| SRS-EXP-004 | Exported output shall be presentation-grade: crisp primitives, stable spacing, readable labels. | The product promise is "charts you can actually present". | Review | visual-vocabulary |

## Open items

- Export requirements verify by Demo; an SVG-serialization snapshot test would
  promote SRS-EXP-001 to Test (the `spec/visual` generator is a step toward this).
