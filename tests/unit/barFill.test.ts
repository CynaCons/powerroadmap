import { describe, it, expect } from 'vitest';
import { NO_FILL, isNoFill, type Task } from '../../src/types/document';

/**
 * A bar with no fill at all (SRS-ELEM-075).
 *
 * The sentinel lives in `color` on purpose, so the interesting question is not
 * "does the constant equal itself" but whether it survives the paths a colour
 * already travels and whether anything else can be mistaken for it.
 */
describe('no fill as a colour (SRS-ELEM-075)', () => {
  it('recognises the sentinel and nothing else', () => {
    expect(isNoFill(NO_FILL)).toBe(true);
    // The control. Without it this suite would pass against `() => true`.
    expect(isNoFill('#000000')).toBe(false);
    expect(isNoFill('#ffffff')).toBe(false);
    expect(isNoFill('none ')).toBe(false);
    expect(isNoFill('None')).toBe(false);
    expect(isNoFill('transparent')).toBe(false);
  });

  it('treats an unset colour as a fill, not as no fill', () => {
    // Every bar ever drawn before this feature has `color` absent, and they
    // are filled with the default. Reading absence as "no fill" would empty
    // every bar in every existing plan.
    expect(isNoFill(undefined)).toBe(false);
    expect(isNoFill(null)).toBe(false);
    expect(isNoFill('')).toBe(false);
  });

  it('round-trips through JSON as a plain string', () => {
    // This is the whole reason it is a value and not a fourth field: the save
    // format, the clipboard and apply_batch all carry it with no change.
    const task: Task = {
      id: 't1', rowId: 'r1', label: 'Spec freeze',
      start: '2026-01-01', end: '2026-01-10',
      color: NO_FILL, outline: 'dashed', outlineColor: '#000000',
    };
    const back = JSON.parse(JSON.stringify(task)) as Task;
    expect(isNoFill(back.color)).toBe(true);
    expect(back.outline).toBe('dashed');
    expect(back.outlineColor).toBe('#000000');
  });

  it('is a legal SVG fill, so the renderer needs no special case to paint it', () => {
    // `fill="none"` is already SVG's own spelling. If this ever stops being
    // true the renderer's `fill={color}` silently paints black instead.
    expect(NO_FILL).toBe('none');
  });
});
