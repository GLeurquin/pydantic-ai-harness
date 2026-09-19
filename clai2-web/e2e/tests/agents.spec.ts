import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let counter = 0;

/** Create an agent through the UI and wait for it to be selected and idle. */
async function createAgent(
  page: Page,
  options: { name?: string; worktree?: boolean; mode?: 'Always ask' | 'Accept edits' | 'Auto-approve everything' } = {},
): Promise<string> {
  counter += 1;
  const name = options.name ?? `agent-${Date.now()}-${counter}`;
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New agent' });
  await dialog.getByLabel('Name').fill(name);
  if (options.worktree === false) {
    await dialog.getByLabel('Create an isolated worktree and branch').uncheck();
  }
  if (options.mode) {
    await dialog.getByLabel('Approval mode').selectOption({ label: options.mode });
  }
  await dialog.getByRole('button', { name: 'Start agent' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible();
  return name;
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel('Prompt').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('connected')).toBeVisible();
});

test('creating an agent provisions a worktree branch in the sidebar', async ({ page }) => {
  const name = await createAgent(page, { worktree: true });
  const row = page.getByRole('button', { name: new RegExp(name) });
  await expect(row).toContainText(/clai2\/agents\//);
  await expect(page.getByRole('tab', { name: 'Conversation' })).toBeVisible();
});

test('chat round-trips through the stub agent', async ({ page }) => {
  await createAgent(page, { worktree: false });
  await send(page, 'hello e2e');
  await expect(page.getByText('echo: hello e2e')).toBeVisible();
  await expect(page.getByText('turn finished')).toBeVisible();
});

test('thought chunks render as reasoning', async ({ page }) => {
  await createAgent(page, { worktree: false });
  await send(page, 'think: pondering deeply');
  await expect(page.locator('.block-thought')).toHaveText('pondering deeply');
});

test('always-ask parks an approval that allow resolves', async ({ page }) => {
  await createAgent(page, { worktree: false, mode: 'Always ask' });
  await send(page, 'approve:execute run tests');
  const banner = page.getByRole('alertdialog');
  await expect(banner).toContainText('stub execute');
  await banner.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('tool ran')).toBeVisible();
  await expect(page.getByText('turn finished')).toBeVisible();
});

test('rejecting an approval fails the tool call', async ({ page }) => {
  await createAgent(page, { worktree: false, mode: 'Always ask' });
  await send(page, 'approve:execute rm -rf');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByText('tool rejected')).toBeVisible();
});

test('the header inbox surfaces approvals from any agent', async ({ page }) => {
  const name = await createAgent(page, { worktree: false, mode: 'Always ask' });
  await send(page, 'approve:execute risky thing');
  await expect(page.getByLabel('Approval inbox')).toContainText('1');
  await page.getByLabel('Approval inbox').click();
  const inbox = page.getByRole('dialog', { name: 'Pending approvals' });
  await expect(inbox).toContainText(name);
  await inbox.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('tool ran')).toBeVisible();
});

test('auto mode runs tools without asking', async ({ page }) => {
  await createAgent(page, { worktree: false, mode: 'Auto-approve everything' });
  await send(page, 'approve:execute anything');
  await expect(page.getByText('tool ran')).toBeVisible();
  await expect(page.getByRole('alertdialog')).not.toBeVisible();
});

test('switching approval mode applies live', async ({ page }) => {
  await createAgent(page, { worktree: false, mode: 'Always ask' });
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Approval mode').selectOption('auto');
  await expect(page.getByText('Every tool call runs without asking.')).toBeVisible();
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await send(page, 'approve:execute now fine');
  await expect(page.getByText('tool ran')).toBeVisible();
});

test('cancel stops a running turn', async ({ page }) => {
  await createAgent(page, { worktree: false });
  await send(page, 'slow');
  await expect(page.getByText('working...')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('cancelled')).toBeVisible();
});

test('a goal runs on its own and stops once the agent marks it complete', async ({ page }) => {
  await createAgent(page, { worktree: false });
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Set a goal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Set a goal' });
  await dialog.getByLabel('Goal').fill('say complete-goal right away');
  await dialog.getByRole('button', { name: 'Start working toward it' }).click();
  await expect(dialog).not.toBeVisible();

  await page.getByRole('tab', { name: 'Conversation' }).click();
  await expect(page.locator('.block-assistant')).toHaveText('done');

  // No human ever sent this first prompt -- the goal dialog itself fired it.
  await expect(page.getByText('New autonomous goal: say complete-goal right away')).toBeVisible();

  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByRole('button', { name: 'Set a goal' })).toBeVisible();
  await expect(page.getByText(/^Turn \d/)).not.toBeVisible();
});

test('tracking and stopping a PR round-trips through the settings tab', async ({ page }) => {
  await createAgent(page, { worktree: false });
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Track a PR' }).click();
  const dialog = page.getByRole('dialog', { name: 'Track a PR' });
  await dialog.getByLabel('Pull request').fill('pydantic/pydantic-ai#1');
  await dialog.getByRole('button', { name: 'Start tracking' }).click();
  await expect(dialog).not.toBeVisible();

  await expect(page.getByText('pydantic/pydantic-ai#1')).toBeVisible();
  await expect(page.getByText('Not checked yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Track a PR' })).not.toBeVisible();

  await page.getByRole('button', { name: 'Stop tracking' }).click();
  await expect(page.getByRole('button', { name: 'Track a PR' })).toBeVisible();
  await expect(page.getByText('pydantic/pydantic-ai#1')).not.toBeVisible();
});

test('forking carries the conversation into a new worktree agent', async ({ page }) => {
  const name = await createAgent(page, { worktree: true });
  await send(page, 'remember: the sky is teal');
  await expect(page.getByText('echo: remember: the sky is teal')).toBeVisible();

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Fork' }).click();
  const dialog = page.getByRole('dialog', { name: `Fork ${name}` });
  await dialog.getByLabel('Name').fill(`${name}-fork`);
  await dialog.getByRole('button', { name: 'Fork agent' }).click();
  await expect(dialog).not.toBeVisible();

  // The fork is selected, carries the transcript, and records its parentage.
  await expect(page.getByRole('button', { name: new RegExp(`${name}-fork`) })).toBeVisible();
  await expect(page.getByText('echo: remember: the sky is teal')).toBeVisible();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByText('Forked from')).toBeVisible();

  // Its first prompt replays history to the fresh agent process.
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await send(page, 'continue please');
  await expect(page.getByText(/User: remember: the sky is teal/)).toBeVisible();
});

test('side conversations stay isolated from the main thread', async ({ page }) => {
  await createAgent(page, { worktree: false });
  await send(page, 'main topic');
  await expect(page.getByText('echo: main topic')).toBeVisible();

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Side conversation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Side conversation' });
  await dialog.getByLabel('Name').fill('quick question');
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();

  await expect(page.getByRole('tab', { name: 'quick question' })).toHaveAttribute('aria-selected', 'true');
  await send(page, 'side topic');
  await expect(page.getByText('echo: side topic')).toBeVisible();
  await expect(page.getByText('echo: main topic')).not.toBeVisible();

  await page.getByRole('tab', { name: 'Conversation' }).click();
  await expect(page.getByText('echo: main topic')).toBeVisible();
  await expect(page.getByText('echo: side topic')).not.toBeVisible();
});

test('the changes tab shows the worktree diff', async ({ page, request }) => {
  const name = await createAgent(page, { worktree: true });
  const agents = await (await request.get('/api/agents')).json();
  const agent = agents.find((candidate: { name: string }) => candidate.name === name);
  writeFileSync(join(agent.worktree.path, 'README.md'), '# e2e demo\nedited by test\n');
  writeFileSync(join(agent.worktree.path, 'fresh.txt'), 'brand new\n');

  await page.getByRole('tab', { name: 'Changes' }).click();
  await expect(page.getByLabel('Changes')).toContainText('+edited by test');
  await expect(page.getByLabel('Changes')).toContainText('brand new');
});

test('archiving hides the agent from the live groups', async ({ page }) => {
  const name = await createAgent(page, { worktree: false });
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  const row = page.getByRole('button', { name: new RegExp(name) });
  await expect(page.getByText('Archived')).toBeVisible();
  await expect(row).toBeVisible();
});

test('renaming an agent updates the sidebar and composer', async ({ page }) => {
  const name = await createAgent(page, { worktree: false });
  await page.getByRole('tab', { name: 'Settings' }).click();
  const nameField = page.getByLabel('Agent name');
  await nameField.fill(`${name}-renamed`);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(`${name}-renamed`) })).toBeVisible();
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await expect(page.getByLabel('Prompt')).toHaveAttribute('placeholder', `Message ${name}-renamed`);
});

test('registering a project lets an agent run in another repository', async ({ page }, testInfo) => {
  const otherRepo = mkdtempSync(join(tmpdir(), 'clai2-e2e-other-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', otherRepo, ...args]);
  git('init', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  writeFileSync(join(otherRepo, 'README.md'), '# other repo\n');
  git('add', '.');
  git('commit', '-m', 'init');
  testInfo.annotations.push({ type: 'other-repo', description: otherRepo });

  await page.getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '+ New project' }).click();
  await dialog.getByLabel('Project name').fill('other-project');
  await dialog.getByLabel('Repository path (absolute)').fill(otherRepo);
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(dialog.getByLabel('Project', { exact: true })).toHaveValue(/.+/);
  await expect(dialog.getByLabel('Project', { exact: true })).not.toHaveValue('');

  const agentName = `other-repo-agent-${Date.now()}`;
  await dialog.getByLabel('Name', { exact: true }).fill(agentName);
  await dialog.getByRole('button', { name: 'Start agent' }).click();
  await expect(dialog).not.toBeVisible();
  const row = page.getByRole('button', { name: new RegExp(agentName) });
  await expect(row).toBeVisible();
  await expect(row).toContainText(/clai2\/agents\//);

  // Filtering the sidebar to the new project keeps only its agents.
  await page.getByLabel('Filter by project').selectOption({ label: 'other-project' });
  await expect(page.getByRole('button', { name: new RegExp(agentName) })).toBeVisible();
  await page.getByLabel('Filter by project').selectOption({ label: 'All projects' });
});

test('configuring a GitHub token from the new-agent dialog reveals the issue import field', async ({ page, request }) => {
  // A token is server-side, persistent state outside this test's page/context;
  // start from a known-clean slate regardless of what ran before it.
  await request.delete('/api/github');
  await page.goto('/');
  await expect(page.getByText('connected')).toBeVisible();

  try {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    const newAgentDialog = page.getByRole('dialog', { name: 'New agent' });
    await newAgentDialog.getByLabel('Import from a GitHub issue').check();
    await expect(newAgentDialog.getByText('No GitHub token is configured yet.')).toBeVisible();
    await expect(newAgentDialog.getByLabel('Issue', { exact: true })).toHaveCount(0);

    await newAgentDialog.getByRole('button', { name: 'Configure GitHub' }).click();
    const githubDialog = page.getByRole('dialog', { name: 'GitHub settings' });
    await expect(githubDialog).toBeVisible();
    await expect(newAgentDialog).not.toBeVisible();
    await githubDialog.getByLabel('Personal access token').fill('ghp_e2e_test_token');
    await githubDialog.getByRole('button', { name: 'Save token' }).click();
    await expect(githubDialog.getByRole('button', { name: 'Clear token' })).toBeVisible();
    await githubDialog.getByRole('button', { name: 'Close' }).click();
    await expect(githubDialog).not.toBeVisible();

    await page.getByRole('button', { name: 'New', exact: true }).click();
    const reopened = page.getByRole('dialog', { name: 'New agent' });
    await reopened.getByLabel('Import from a GitHub issue').check();
    await expect(reopened.getByLabel('Issue', { exact: true })).toBeVisible();
    await expect(reopened.getByText('No GitHub token is configured yet.')).toHaveCount(0);
    await reopened.getByRole('button', { name: 'Cancel' }).click();
    await expect(reopened).not.toBeVisible();
  } finally {
    // The token is stored server-side and would otherwise leak into every
    // test that runs afterward in this shared-backend suite.
    await request.delete('/api/github');
  }
});
