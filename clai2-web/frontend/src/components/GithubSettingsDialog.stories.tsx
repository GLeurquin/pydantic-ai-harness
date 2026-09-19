import type { Story } from '@ladle/react';

import type { RedactedGithubSettings } from '../api/types';
import { GithubSettingsDialog } from './GithubSettingsDialog';

const noop = () => undefined;

/** Serve a fixed settings object to the dialog's `GET /api/github` call so
 * the story renders without a backend. */
function stubGithubFetch(settings: RedactedGithubSettings) {
  window.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = url.endsWith('/api/github') ? JSON.stringify(settings) : 'null';
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch;
}

export const NoToken: Story = () => {
  stubGithubFetch({ hasToken: false, pollIntervalSecs: 300 });
  return <GithubSettingsDialog onClose={noop} />;
};

export const TokenConfigured: Story = () => {
  stubGithubFetch({ hasToken: true, pollIntervalSecs: 300 });
  return <GithubSettingsDialog onClose={noop} />;
};
