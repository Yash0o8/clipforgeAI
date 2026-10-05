import { createContext } from 'react';

/**
 * Global application store.
 *
 * The context object lives in its own module so that `AppProvider.jsx` can
 * export nothing but a component, which is what `react-refresh` needs for hot
 * reloading to work correctly.
 */
export const AppContext = createContext(null);

AppContext.displayName = 'AppContext';
