import type { Story } from '@ladle/react';

import { sampleProfiles } from '../../.ladle/data';
import type { RedactedProfile } from '../api/types';
import { ModelsDialog } from './ModelsDialog';

const noop = () => undefined;

/** Serve a fixed profile list to the dialog's `GET /api/models` call so the
 * story renders without a backend. */
function stubModelsFetch(profiles: RedactedProfile[]) {
  window.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = url.endsWith('/api/models') ? JSON.stringify(profiles) : 'null';
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch;
}

export const Populated: Story = () => {
  stubModelsFetch(sampleProfiles);
  return <ModelsDialog onClose={noop} />;
};

export const Empty: Story = () => {
  stubModelsFetch([]);
  return <ModelsDialog onClose={noop} />;
};
