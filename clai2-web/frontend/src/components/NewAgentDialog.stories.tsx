import type { Story } from '@ladle/react';

import { makeProject } from '../../.ladle/data';
import type { ProjectSummary } from '../api/types';
import { NewAgentDialog } from './NewAgentDialog';

const noop = () => undefined;
const resolveCreate = () => Promise.resolve();
const resolveCreateProject = (): Promise<ProjectSummary> => Promise.resolve(makeProject());
const projects = [makeProject(), makeProject({ id: 'project-2', name: 'other-repo', repoRoot: '/home/dev/other-repo' })];

export const Open: Story = () => (
  <NewAgentDialog projects={projects} onCreate={resolveCreate} onCreateProject={resolveCreateProject} onClose={noop} />
);
