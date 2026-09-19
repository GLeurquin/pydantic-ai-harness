import type { Story } from '@ladle/react';

import { makeProject, sampleProfiles } from '../../.ladle/data';
import type { FetchedIssue, ProjectSummary } from '../api/types';
import { NewAgentDialog } from './NewAgentDialog';

const noop = () => undefined;
const resolveCreate = () => Promise.resolve();
const resolveCreateProject = (): Promise<ProjectSummary> => Promise.resolve(makeProject());
const resolveVoid = () => Promise.resolve();
const resolveIssue = (): Promise<FetchedIssue> =>
  Promise.resolve({
    title: 'Auth tokens expire mid-session',
    body: 'Users get logged out unexpectedly while their session should still be valid.',
    url: 'https://github.com/pydantic/pydantic-ai/issues/42',
    prompt: 'Work on this GitHub issue:\n\n# Auth tokens expire mid-session\n\n...',
  });
const projects = [makeProject(), makeProject({ id: 'project-2', name: 'other-repo', repoRoot: '/home/dev/other-repo' })];

export const Open: Story = () => (
  <NewAgentDialog
    models={sampleProfiles}
    projects={projects}
    githubSettings={{ hasToken: false }}
    onCreate={resolveCreate}
    onCreateProject={resolveCreateProject}
    onFetchGithubIssue={resolveIssue}
    onSetGithubToken={resolveVoid}
    onClose={noop}
    onManageModels={noop}
  />
);
