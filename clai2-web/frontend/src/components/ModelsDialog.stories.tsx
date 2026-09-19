import type { Story } from '@ladle/react';

import { sampleProfiles } from '../../.ladle/data';
import type { RedactedProfile } from '../api/types';
import { ModelsDialog } from './ModelsDialog';

const noop = () => undefined;
const resolveProfile = (): Promise<RedactedProfile> => Promise.resolve(sampleProfiles[0]!);
const resolveDelete = () => Promise.resolve();

export const Populated: Story = () => (
  <ModelsDialog profiles={sampleProfiles} onCreate={resolveProfile} onUpdate={resolveProfile} onDelete={resolveDelete} onClose={noop} />
);

export const Empty: Story = () => (
  <ModelsDialog profiles={[]} onCreate={resolveProfile} onUpdate={resolveProfile} onDelete={resolveDelete} onClose={noop} />
);
