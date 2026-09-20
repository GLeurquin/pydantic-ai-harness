import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('connected')).toBeVisible();
});

test('filing an agent into a folder shows it as a sidebar section, and deleting the folder unfiles it', async ({
  page,
}) => {
  const name = `agent-${Date.now()}`;
  const folderName = `Launch ${Date.now()}`;

  await page.getByRole('button', { name: 'New', exact: true }).click();
  const newAgentDialog = page.getByRole('dialog', { name: 'New agent' });
  await newAgentDialog.getByLabel('Name').fill(name);
  await newAgentDialog.getByLabel('Create an isolated worktree and branch').uncheck();
  await newAgentDialog.getByRole('button', { name: 'Start agent' }).click();
  await expect(newAgentDialog).not.toBeVisible();

  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Manage folders' }).click();
  const foldersDialog = page.getByRole('dialog', { name: 'Folders' });
  await foldersDialog.getByRole('button', { name: 'New folder' }).click();
  await foldersDialog.getByLabel('Folder name').fill(folderName);
  await foldersDialog.getByRole('button', { name: 'Add folder' }).click();
  await expect(foldersDialog.getByText(folderName)).toBeVisible();
  await foldersDialog.getByRole('button', { name: 'Close' }).click();

  await page.getByLabel('Folder').selectOption({ label: folderName });
  const sidebar = page.getByRole('navigation', { name: 'Agents' });
  const folderSection = sidebar.getByRole('region', { name: folderName });
  await expect(folderSection).toBeVisible();
  await expect(folderSection.getByText(name)).toBeVisible();

  // The agent no longer shows under its old status group -- filed agents
  // are grouped by folder instead.
  await expect(sidebar.getByRole('region', { name: 'Idle' }).getByText(name)).not.toBeVisible();

  await page.getByRole('button', { name: 'Manage folders' }).click();
  await foldersDialog.getByRole('listitem').filter({ hasText: folderName }).getByRole('button', { name: 'Remove' }).click();
  await expect(foldersDialog.getByText(folderName)).not.toBeVisible();
  await foldersDialog.getByRole('button', { name: 'Close' }).click();

  await expect(sidebar.getByRole('region', { name: folderName })).not.toBeVisible();
  await expect(sidebar.getByRole('region', { name: 'Idle' }).getByText(name)).toBeVisible();
  await expect(page.getByLabel('Folder')).toHaveValue('');
});
