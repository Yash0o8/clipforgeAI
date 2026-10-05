import { createContext } from 'react';

/**
 * Transient toast queue.
 *
 * Separate module from the provider so `ToastProvider.jsx` exports nothing but
 * a component, keeping `react-refresh` happy during development.
 */
export const ToastContext = createContext(null);

ToastContext.displayName = 'ToastContext';
