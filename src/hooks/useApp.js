import { useContext } from 'react';
import { AppContext } from '../context/AppContext.js';

/**
 * Access the global application store.
 *
 * Kept in its own module (rather than beside the provider) so that
 * `AppContext.jsx` only ever exports React components, which keeps
 * `react-refresh/only-export-components` quiet during development.
 */
export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used inside <AppProvider>.');
  }
  return context;
}
