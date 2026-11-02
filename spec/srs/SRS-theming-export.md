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
