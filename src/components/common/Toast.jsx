import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useToast } from '../../hooks/useToast.js';

const TONES = {
  info: { icon: Info, ring: 'border-info/30', accent: 'text-info' },
  success: { icon: CheckCircle2, ring: 'border-success/30', accent: 'text-success' },
  warning: { icon: AlertTriangle, ring: 'border-warning/30', accent: 'text-warning' },
  danger: { icon: XCircle, ring: 'border-danger/35', accent: 'text-danger' },
};

/**
 * Fixed-position toast stack. Mounted once in `AppLayout`.
 *
 * `aria-live="polite"` means screen readers announce new toasts without
 * interrupting whatever the user is doing.
 */
export function ToastViewport() {
  const { toasts, dismiss } = useToast();

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 p-4 pb-safe sm:inset-x-auto sm:right-0 sm:items-end sm:p-5"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const tone = TONES[toast.tone] ?? TONES.info;
          const Icon = tone.icon;

          return (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className={`panel-raised pointer-events-auto flex w-full max-w-sm items-start gap-3 border p-3.5 pr-2.5 ${tone.ring}`}
            >
              <Icon aria-hidden className={`mt-0.5 size-4.5 shrink-0 ${tone.accent}`} />

              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-primary">{toast.title}</p>
                {toast.body && (
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-secondary">{toast.body}</p>
                )}
                {toast.action && (
                  <button
                    type="button"
                    onClick={() => {
                      toast.action.onClick();
                      dismiss(toast.id);
                    }}
                    className="mt-2 text-[12.5px] font-semibold text-brand-400 transition-colors hover:text-brand-300"
                  >
                    {toast.action.label}
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label={`Dismiss: ${toast.title}`}
                className="shrink-0 rounded-md p-1.5 text-faint transition-colors hover:bg-ink-750 hover:text-primary focus-visible:outline-2 focus-visible:outline-brand-400"
              >
                <X className="size-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
