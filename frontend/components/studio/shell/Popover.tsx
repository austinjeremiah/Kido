'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Lightweight anchored popover used by the title bar and status bar menus. */
export function Popover({
  trigger,
  children,
  align = 'left',
  width = 260,
  label,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (props: { close: () => void }) => ReactNode;
  align?: 'left' | 'right';
  width?: number;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const [scope, setScope] = useState('cl-studio');

  /*
   * Rendered through a portal, positioned from the trigger's own rect.
   *
   * The title bar carries `overflow: hidden` so it clips rather than forcing
   * the shell wider, and an absolutely-positioned menu inside it was clipped at
   * the bar's edge — which looked like the menu rendering behind the panels
   * below it. No z-index fixes that, because clipping is not stacking.
   *
   * A portal to <body> escapes both the clip and the bar's stacking context. It
   * costs three things, each handled below: the menu no longer follows the
   * trigger, it is no longer inside the styling scope, and it is no longer a
   * DOM descendant of the thing the outside-click test measures against.
   */
  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAt({ top: r.bottom + 6, left: align === 'left' ? r.left : r.right - width });

    /* studio.css is scoped under .cl-studio and themed by a class beside it.
       Outside that subtree every token is undefined, so the menu carries the
       scope it was opened from rather than assuming one. */
    const host = el.closest('.cl-studio');
    if (host) setScope(host.className.replace(/\bcl-shell\b/, '').trim());
  }, [align, width]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('resize', place);
    /* Capture: the scroll that moves the trigger is usually a pane's, not the
       window's, and only a capturing listener hears those. */
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      /* The panel is no longer inside `ref`, so testing only that would treat
         every click on the menu as a click outside it and close on selection. */
      if (ref.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && at
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              aria-label={label}
              className={scope}
              style={{
                position: 'fixed',
                top: at.top,
                left: at.left,
                width,
                maxHeight: '70vh',
                overflowY: 'auto',
                zIndex: 320,
                background: 'var(--cl-panel)',
                /* The popover often opens from a chrome bar, which carries
                   inverted ink. Re-assert panel ink so descendants inherit it. */
                color: 'var(--cl-ink)',
                border: '1px solid var(--cl-line-strong)',
                borderRadius: 8,
                boxShadow: '0 16px 40px rgba(0, 0, 0, 0.45)',
                padding: 4,
                animation: 'cl-rise 0.12s cubic-bezier(0.16,1,0.3,1)',
              } as React.CSSProperties}
            >
              {children({ close: () => setOpen(false) })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  hint,
  disabled,
  tone,
}: {
  children: ReactNode;
  onClick?: () => void;
  hint?: ReactNode;
  disabled?: boolean;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="cl-palette-item"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        textAlign: 'left',
        color: tone === 'danger' ? 'var(--cl-deny)' : undefined,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
      {hint ? <span className="cl-palette-item-hint">{hint}</span> : null}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="cl-label" style={{ padding: '8px 12px 4px' }}>
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div style={{ height: 1, background: 'var(--cl-line)', margin: '4px 0' }} />;
}
