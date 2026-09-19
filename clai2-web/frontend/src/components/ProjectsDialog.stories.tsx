import type { Story } from '@ladle/react';

import { makeProject } from '../../.ladle/data';
import type { ProjectSummary } from '../api/types';
import { ProjectsDialog } from './ProjectsDialog';

const noop = () => undefined;
const resolveCreateProject = (): Promise<ProjectSummary> => Promise.resolve(makeProject());
const resolveDeleteProject = () => Promise.resolve();

const projects = [makeProject(), makeProject({ id: 'project-2', name: 'other-repo', repoRoot: '/home/dev/other-repo' })];

export const Populated: Story = () => (
  <ProjectsDialog
    projects={projects}
    onCreateProject={resolveCreateProject}
    onDeleteProject={resolveDeleteProject}
    onClose={noop}
  />
);

export const Empty: Story = () => (
  <ProjectsDialog projects={[]} onCreateProject={resolveCreateProject} onDeleteProject={resolveDeleteProject} onClose={noop} />
);
