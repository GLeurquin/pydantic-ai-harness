import type { Story } from '@ladle/react';

import { makeProfile } from '../../.ladle/data';
import { ModelForm } from './ModelForm';

const noop = () => undefined;
const resolveSave = () => Promise.resolve();

export const NewAnthropic: Story = () => <ModelForm onSave={resolveSave} onCancel={noop} />;

export const NewVertex: Story = () => (
  <ModelForm
    profile={makeProfile({
      id: 'draft',
      label: '',
      provider: 'google_vertex',
      model: '',
      hasApiKey: false,
      projectId: null,
      region: null,
      hasCredentials: false,
    })}
    onSave={resolveSave}
    onCancel={noop}
  />
);

export const EditingExisting: Story = () => (
  <ModelForm
    profile={makeProfile({
      label: 'Prod Sonnet',
      extraEnv: [
        { name: 'HTTP_PROXY', value: 'http://proxy:8080', secret: false },
        { name: 'ANTHROPIC_AUTH_TOKEN', value: null, secret: true },
      ],
    })}
    onSave={resolveSave}
    onCancel={noop}
  />
);
