import { describe, it, expect } from 'vitest';
import { PALETTE_PRESETS } from '../../src/app/ColorPalette';

/** The colours a planner can pick without opening the custom picker (SRS-ELEM-076). */
describe('the colour palette (SRS-ELEM-076)', () => {
  it('offers at least sixteen presets', () => {
    expect(PALETTE_PRESETS.length).toBeGreaterThanOrEqual(16);
  });

  it('still opens with the eight stream hues, in their original order', () => {
    // Not decoration. These are the colours every existing plan was drawn
    // with: reordering or dropping one makes a planner's saved colour stop
    // reading as a preset, and the swatch they picked stops looking chosen.
    expect(PALETTE_PRESETS.slice(0, 8).map((p) => p.hex)).toEqual([
      '#1F4E79', '#17736B', '#4F7A2A', '#A8452B',
      '#6B3F7A', '#C07A14', '#6E8299', '#3D4551',
    ]);
  });

  it('carries fully black, which the owner named as one of the two that matter', () => {
    const black = PALETTE_PRESETS.find((p) => p.hex.toLowerCase() === '#000000');
    expect(black, 'black is not in the palette').toBeDefined();
    expect(black!.name).toBe('Black');
  });

  it('is made of distinct, well-formed hex colours', () => {
    for (const p of PALETTE_PRESETS) {
      expect(p.hex, `${p.name} is not a 6-digit hex`).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(p.name.trim().length, 'a swatch with no name cannot be announced').toBeGreaterThan(0);
    }
    const hexes = PALETTE_PRESETS.map((p) => p.hex.toLowerCase());
    expect(new Set(hexes).size, 'two swatches paint the same colour').toBe(hexes.length);
    const names = PALETTE_PRESETS.map((p) => p.name.toLowerCase());
    expect(new Set(names).size, 'two swatches share a name').toBe(names.length);
  });

  it('adds colours that are genuinely more saturated than the stream set', () => {
    // The owner asked for "more vibrant", so this measures vibrancy rather
    // than counting swatches: the added set has to actually be more saturated
    // than the quiet one, or the feature is sixteen muted colours.
    const sat = (hex: string): number => {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      return max === 0 ? 0 : (max - min) / max;
    };
    const streams = PALETTE_PRESETS.slice(0, 8).map((p) => sat(p.hex));
    // Black is achromatic by definition and would drag the mean down; it is
    // in the palette for being black, not for being vibrant.
    const added = PALETTE_PRESETS.slice(8)
      .filter((p) => p.hex.toLowerCase() !== '#000000')
      .map((p) => sat(p.hex));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(added.length).toBeGreaterThanOrEqual(8);
    expect(mean(added)).toBeGreaterThan(mean(streams));
  });
});
