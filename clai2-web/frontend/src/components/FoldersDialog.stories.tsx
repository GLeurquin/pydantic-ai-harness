import type { Story } from '@ladle/react';

import type { FolderSummary } from '../api/types';
import { FoldersDialog } from './FoldersDialog';

const noop = () => undefined;
const resolveCreateFolder = (): Promise<FolderSummary> => Promise.resolve({ id: 'f-new', name: 'new folder' });
const resolveDeleteFolder = () => Promise.resolve();

const folders: FolderSummary[] = [
  { id: 'f1', name: 'Q3 launch' },
  { id: 'f2', name: 'On hold' },
];

export const Populated: Story = () => (
  <FoldersDialog folders={folders} onCreateFolder={resolveCreateFolder} onDeleteFolder={resolveDeleteFolder} onClose={noop} />
);

export const Empty: Story = () => (
  <FoldersDialog folders={[]} onCreateFolder={resolveCreateFolder} onDeleteFolder={resolveDeleteFolder} onClose={noop} />
);
