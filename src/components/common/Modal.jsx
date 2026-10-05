import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { IconButton } from './Button.jsx';

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-6xl',
};

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Accessible dialog: focus is trapped while open, Escape closes, the page
 * behind is scroll-locked, and focus returns to whatever opened it.
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {string} props.title            Used for the accessible name.
 * @param {string} [props.description]     Sub-heading, referenced by aria-describedby.
 * @param {'sm'|'md'|'lg'|'xl'|'full'} [props.size]
 * @param {boolean} [props.dismissOnBackdrop]
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  dismissOnBackdrop = true,
  children,
  footer,
  headerActions,
}) {
  const panelRef = useRef(null);
  const previouslyFocused = useRef(null);

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
        return;
      }

      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  // Remember the trigger, lock scrolling, and restore focus on close.
  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement;
    const { overflow, paddingRight } = document.body.style;
    // Compensate for the scrollbar so the page does not shift.
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;

    const focusTimer = setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const target =
        panel.querySelector('[data-autofocus]') ?? panel.querySelector(FOCUSABLE) ?? panel;
      target.focus({ preventScroll: true });
    }, 40);

    return () => {
      clearTimeout(focusTimer);
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
      previouslyFocused.current?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <motion.div
            className="absolute inset-0 bg-ink-950/80 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={dismissOnBackdrop ? onClose : undefined}
            aria-hidden="true"
          />

          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            aria-describedby={description ? 'modal-description' : undefined}
            tabIndex={-1}
            className={`panel-raised relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-b-none sm:rounded-b-panel ${
              SIZES[size] ?? SIZES.md
            }`}
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            onKeyDown={handleKeyDown}
          >
            <header className="hairline-t flex shrink-0 items-start justify-between gap-4 border-t-0 px-5 pt-5 pb-4">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold text-primary">{title}</h2>
                {description && (
                  <p id="modal-description" className="mt-1 text-[13px] text-secondary">
                    {description}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {headerActions}
                <IconButton label="Close dialog" size="sm" onClick={onClose}>
                  <X className="size-4" />
                </IconButton>
              </div>
            </header>

            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>

            {footer && (
              <footer className="hairline-t flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 py-3.5">
                {footer}
              </footer>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}

/**
 * Confirmation dialog built on `Modal`.
 * Defaults to a destructive tone, so callers must opt out via `tone`.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  busy = false,
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-lg border border-line-strong px-3.5 text-[13px] font-medium text-primary transition-colors hover:bg-ink-750"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`h-9 rounded-lg px-3.5 text-[13px] font-semibold text-white transition-colors disabled:opacity-50 ${
              tone === 'danger' ? 'bg-red-600 hover:bg-red-500' : 'bg-brand-500 hover:bg-brand-400'
            }`}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-secondary">{message}</p>
    </Modal>
  );
}
