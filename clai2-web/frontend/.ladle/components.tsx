import '../src/theme.css';
import '../src/app.css';

import type { GlobalProvider as GlobalProviderType } from '@ladle/react';

/** Wrap every story in the app's dark background so components render on-brand. */
export const GlobalProvider: GlobalProviderType = ({ children }) => (
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
