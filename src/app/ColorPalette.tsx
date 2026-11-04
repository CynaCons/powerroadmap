import { useRef } from 'react';
import { Plus } from 'lucide-react';
import { NO_FILL, isNoFill } from '../types/document';

interface ColorPaletteProps {
  value: string;
  onChange: (color: string) => void;
  /**
   * What this palette colours, when the panel shows more than one.
   *
   * A task now carries three: its fill, its outline and its label. Eight
   * swatches named "Prussian" three times over is ambiguous to a screen
   * reader and to anything else addressing them by name, so the two that are
   * not the fill say which they are.
   */
  what?: string;
  /**
   * Whether the "no fill" swatch is offered (SRS-ELEM-075).
   *
   * Only a fill can be absent. An outline colour of none is what the outline
   * chooser's own None already means, and a label with no colour is a label
   * nobody can read — so the swatch appears on the fill alone.
   */
  allowNoFill?: boolean;
}

/**
 * The stream palette, one hue per discipline (DECISIONS.md D6), and then the
 * vibrant set the owner asked for on 2026-11-04.
 *
 * The first eight are unchanged and stay first: they are the colours every
 * existing plan was drawn with, and a palette that reorders itself under a
 * planner is a palette that loses their colour. The eight after them are
 * saturated on purpose — the stream set is deliberately quiet, which is right
 * for a programme read at a distance and wrong for someone marking one bar as
 * the one that matters.
 *
 * Black is last and deliberate: the owner named it one of the two that matter,
 * so it is a swatch rather than something to reach the custom picker for.
 */
const PRESETS: { name: string; hex: string }[] = [
  { name: 'Prussian', hex: '#1F4E79' },
  { name: 'Teal', hex: '#17736B' },
  { name: 'Moss', hex: '#4F7A2A' },
  { name: 'Rust', hex: '#A8452B' },
  { name: 'Plum', hex: '#6B3F7A' },
  { name: 'Amber', hex: '#C07A14' },
  { name: 'Steel', hex: '#6E8299' },
  { name: 'Graphite', hex: '#3D4551' },
  { name: 'Crimson', hex: '#E5342A' },
  { name: 'Tangerine', hex: '#F26B1D' },
  { name: 'Gold', hex: '#FFC107' },
  { name: 'Lime', hex: '#7CB518' },
  { name: 'Emerald', hex: '#00A878' },
  { name: 'Cyan', hex: '#00B4D8' },
  { name: 'Indigo', hex: '#4C5FD7' },
  { name: 'Magenta', hex: '#C2185B' },
  { name: 'Black', hex: '#000000' },
];

/** Exported so a test can assert the set rather than restate it. */
export const PALETTE_PRESETS = PRESETS;

function eqHex(a: string, b: string): boolean {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
}

const SWATCH: React.CSSProperties = {
  width: 22,
  height: 22,
  padding: 0,
  borderRadius: '50%',
  cursor: 'pointer',
  transition: 'transform 100ms ease',
};

function ring(active: boolean): string {
  return active
    ? '0 0 0 2px var(--color-bg-panel), 0 0 0 4px var(--color-accent)'
    : 'inset 0 1px 0 rgba(255, 255, 255, 0.12)';
}

export function ColorPalette({ value, onChange, what, allowNoFill }: ColorPaletteProps) {
  const customRef = useRef<HTMLInputElement | null>(null);
  const none = isNoFill(value);
  const isPreset = none || PRESETS.some((p) => eqHex(p.hex, value));

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', position: 'relative' }}>
      {allowNoFill && (
        /*
         * No fill, drawn as what it produces: white paper inside a dashed dark
         * frame. A plain white circle would be indistinguishable from a white
         * CUSTOM colour, and those are different things — one is a colour, the
         * other is the absence of one.
         */
        <button
          type="button"
          title={`No fill — white, framed by a dashed outline${what ? ` — ${what}` : ''}`}
          aria-label={what ? `No fill ${what}` : 'No fill'}
          aria-pressed={none}
          data-pp-swatch="none"
          onClick={() => onChange(NO_FILL)}
          style={{
            ...SWATCH,
            background: '#ffffff',
            border: '1.5px dashed #000000',
            boxShadow: ring(none),
          }}
          onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.08)')}
          onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
        />
      )}
      {PRESETS.map((p) => {
        const active = !none && eqHex(p.hex, value);
        return (
          <button
            key={p.hex}
            type="button"
            title={what ? `${p.name} — ${what}` : p.name}
            aria-label={what ? `${p.name} ${what}` : p.name}
            data-pp-swatch={p.name.toLowerCase()}
            onClick={() => onChange(p.hex)}
            style={{
              ...SWATCH,
              background: p.hex,
              border: '1px solid var(--color-border-hairline)',
              boxShadow: ring(active),
            }}
            onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          />
        );
      })}
      <button
        type="button"
        title="Custom color"
        aria-label={what ? `Custom ${what} color` : 'Custom color'}
        onClick={() => customRef.current?.click()}
        style={{
          ...SWATCH,
          background: isPreset ? 'var(--color-bg-subtle)' : value,
          border: '1px dashed var(--color-border)',
          color: 'var(--color-text-soft)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: !isPreset
            ? `0 0 0 2px var(--color-bg-panel), 0 0 0 4px var(--color-accent)`
            : 'none',
        }}
      >
        {isPreset && <Plus size={12} strokeWidth={2} />}
      </button>
      <input
        ref={customRef}
        type="color"
        /* `none` is not a colour an <input type=color> can hold; handing it one
           makes the control fall back to #000000 and report that as the user's
           choice the moment it is opened. */
        value={isNoFill(value) ? '#ffffff' : value || '#6366f1'}
        onChange={(e) => onChange(e.target.value)}
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
      />
    </div>
  );
}
