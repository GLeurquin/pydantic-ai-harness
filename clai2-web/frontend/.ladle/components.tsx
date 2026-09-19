import '../src/theme.css';
import '../src/app.css';

import type { GlobalProvider } from '@ladle/react';

/** Wrap every story in the app's dark background so components render on-brand.
 * Ladle's convention loader requires this export to be named `Provider`
 * specifically (see `@ladle/react`'s `get-components-import.js`); naming it
 * anything else, e.g. `GlobalProvider` like its type, is silently ignored in
 * favor of a no-op default. */
export const Provider: GlobalProvider = ({ children }) => (
  <div
    style={{
      padding: 24,
      minHeight: '100vh',
      background: 'var(--bg)',
      color: 'var(--text)',
      fontFamily: 'var(--font-body)',
    }}
  >
    {children}
  </div>
);
