import { useContext } from 'react';
import { ToastContext } from '../context/ToastContext.js';

/**
 * Transient toast queue.
 *
 * @example
 * const toast = useToast();
 * toast.success('Caption copied to clipboard');
 */
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>.');

  const { push, dismiss, toasts } = context;

  return {
    toasts,
    dismiss,
    push,
    info: (title, options) => push({ title, tone: 'info', ...options }),
    success: (title, options) => push({ title, tone: 'success', ...options }),
    warning: (title, options) => push({ title, tone: 'warning', ...options }),
    error: (title, options) => push({ title, tone: 'danger', duration: 6000, ...options }),
  };
}
