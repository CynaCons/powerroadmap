import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface ContextMenuItem {
  id: string;
  label?: string;
  icon?: LucideIcon;
  shortcut?: string;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
  /** Marks the current value in a set of mutually exclusive choices. */
  active?: boolean;
  /** Renders in place of the usual row. For choices a word cannot show. */
  custom?: React.ReactNode;
  /**
   * A second level, opened from this item (SRS-EDIT-090).
   *
   * One level only, deliberately. The menu existed to collapse a list that
   * grows with the plan — a row menu carried one `Move into "X"` per section,
   * so an eight-section plan opened an eight-entry wall — and a second level
   * of nesting would reintroduce the same problem one step further in.
   */
  submenu?: ContextMenuItem[];
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const MENU_W = 220;
const MENU_PAD = 6;

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [openSub, setOpenSub] = useState<string | null>(null);

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const estH = items.reduce((h, it) => h + (it.separator ? 9 : 28), MENU_PAD * 2);
  const left = Math.min(x, vw - MENU_W - 8);
  const top = Math.min(y, vh - estH - 8);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed', left, top, width: MENU_W, padding: MENU_PAD,
        background: 'var(--color-bg-elev)', border: '1px solid var(--color-border-hairline)',
        borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-3)', zIndex: 9999,
        fontSize: 12, color: 'var(--color-text)', userSelect: 'none',
      }}
    >
      {items.map((it) => {
        if (it.custom) {
          return <div key={it.id}>{it.custom}</div>;
        }
        if (it.separator) {
          return <div key={it.id} style={{ height: 1, margin: '4px 6px', background: 'var(--color-border-hairline)' }} />;
        }
        const Icon = it.icon;
        if (it.submenu) {
          const open = openSub === it.id;
          // Out to the right unless the right is where the screen ends.
          const flip = left + MENU_W + MENU_W + 8 > vw;
          return (
            <div
              key={it.id}
              style={{ position: 'relative' }}
              onMouseEnter={() => setOpenSub(it.id)}
              onMouseLeave={() => setOpenSub((cur) => (cur === it.id ? null : cur))}
            >
              <button
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open}
                disabled={it.disabled}
                onClick={() => setOpenSub(open ? null : it.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '5px 8px',
                  border: 'none', borderRadius: 'var(--radius)',
                  background: open ? 'var(--color-bg-subtle)' : 'transparent',
                  color: 'inherit', textAlign: 'left',
                  cursor: it.disabled ? 'not-allowed' : 'pointer', opacity: it.disabled ? 0.4 : 1,
                  minHeight: 26, lineHeight: 1.35,
                }}
              >
                {Icon ? <Icon size={14} strokeWidth={1.75} /> : <span style={{ width: 14 }} />}
                <span style={{ flex: 1 }}>{it.label}</span>
                <span aria-hidden="true" style={{ color: 'var(--color-text-soft)' }}>&#8250;</span>
              </button>
              {open && (
                <div
                  role="menu"
                  data-pp-submenu={it.id}
                  style={{
                    position: 'absolute', top: -MENU_PAD, width: MENU_W, padding: MENU_PAD,
                    ...(flip ? { right: '100%' } : { left: '100%' }),
                    background: 'var(--color-bg-elev)',
                    border: '1px solid var(--color-border-hairline)',
                    borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-3)',
                    // A submenu long enough to run off a short window scrolls
                    // rather than being cut: the section list has no bound.
                    maxHeight: Math.max(120, vh - 24), overflowY: 'auto',
                  }}
                >
                  {it.submenu.map((sub) =>
                    sub.separator ? (
                      <div key={sub.id} style={{ height: 1, margin: '4px 6px', background: 'var(--color-border-hairline)' }} />
                    ) : (
                      <button
                        key={sub.id}
                        role="menuitem"
                        disabled={sub.disabled}
                        onClick={() => { sub.onClick?.(); onClose(); }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '5px 8px',
                          border: 'none', borderRadius: 'var(--radius)', background: 'transparent',
                          color: sub.danger ? '#ef4444' : 'inherit', textAlign: 'left',
                          cursor: sub.disabled ? 'not-allowed' : 'pointer', opacity: sub.disabled ? 0.4 : 1,
                          minHeight: 26, lineHeight: 1.35,
                        }}
                        onMouseEnter={(e) => { if (!sub.disabled) e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        {sub.icon ? <sub.icon size={14} strokeWidth={1.75} /> : <span style={{ width: 14 }} />}
                        <span style={{ flex: 1 }}>{sub.label}</span>
                        {sub.active && <span aria-hidden="true" style={{ color: 'var(--color-accent)' }}>&#10003;</span>}
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          );
        }
        return (
          <button
            key={it.id}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => { it.onClick?.(); onClose(); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '5px 8px',
              border: 'none', borderRadius: 'var(--radius)', background: 'transparent',
              color: it.danger ? '#ef4444' : 'inherit', textAlign: 'left',
              cursor: it.disabled ? 'not-allowed' : 'pointer', opacity: it.disabled ? 0.4 : 1,
              // minHeight, not height: a label long enough to wrap used to
              // overflow a fixed 26px row and collide with the item below it.
              minHeight: 26, lineHeight: 1.35,
            }}
            onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            {Icon ? <Icon size={14} strokeWidth={1.75} /> : <span style={{ width: 14 }} />}
            <span style={{ flex: 1 }}>{it.label}</span>
            {it.active && <span aria-hidden="true" style={{ color: 'var(--color-accent)' }}>&#10003;</span>}
            {it.shortcut && <kbd>{it.shortcut}</kbd>}
          </button>
        );
      })}
    </div>
  );
}
