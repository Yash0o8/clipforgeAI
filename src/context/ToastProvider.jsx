import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { localId } from '../services/api.js';
import { ToastContext } from './ToastContext.js';

const DEFAULT_DURATION = 4200;

/**
 * Transient action feedback ("Caption copied", "Export queued").
 *
 * Kept separate from the notification bell: toasts confirm what the user just
 * did, notifications report things that happened elsewhere.
 */
export function ToastProvider({ children, max = 4 }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (toast) => {
      const id = localId('toast');
      const entry = { id, tone: 'info', duration: DEFAULT_DURATION, ...toast };

      setToasts((current) => {
        const next = [...current, entry];
        // Drop the oldest rather than stacking without limit.
        return next.length > max ? next.slice(next.length - max) : next;
      });

      if (entry.duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), entry.duration)
        );
      }

      return id;
    },
    [dismiss, max]
  );

  // Clear every pending timer if the provider unmounts.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}
