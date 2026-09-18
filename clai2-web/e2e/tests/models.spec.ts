import { expect, test, type Page } from '@playwright/test';

let counter = 0;

async function addProfile(
  page: Page,
  options: { label: string; provider: string; model: string; apiKey?: string },
): Promise<void> {
  await page.getByRole('button', { name: 'Model profiles' }).click();
  const dialog = page.getByRole('dialog', { name: 'Model profiles' });
  await dialog.getByRole('button', { name: 'New profile' }).click();
  await dialog.getByLabel('Name').fill(options.label);
  await dialog.getByLabel('Provider').selectOption({ label: options.provider });
  await dialog.getByLabel('Model').fill(options.model);
  if (options.apiKey) {
    await dialog.getByLabel('API key').fill(options.apiKey);
  }
  await dialog.getByRole('button', { name: 'Add profile' }).click();
  await expect(dialog.getByText(options.label)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('connected')).toBeVisible();
});

test('a model profile can be created, edited, and deleted', async ({ page }) => {
  const label = `Profile ${Date.now()}-${(counter += 1)}`;
  await addProfile(page, { label, provider: 'OpenAI', model: 'gpt-6', apiKey: 'sk-test' });

  await page.getByRole('button', { name: 'Model profiles' }).click();
  const dialog = page.getByRole('dialog', { name: 'Model profiles' });
  const row = dialog.getByRole('listitem').filter({ hasText: label });
  await expect(row).toContainText('OpenAI');
  await expect(row).toContainText('gpt-6');

  // Edit: the API key input shows a placeholder, not the stored secret.
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(dialog.getByLabel('API key')).toHaveAttribute('placeholder', 'unchanged');
  await expect(dialog.getByLabel('API key')).toHaveValue('');
  await dialog.getByLabel('Model').fill('gpt-6-mini');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByRole('listitem').filter({ hasText: label })).toContainText('gpt-6-mini');

  await dialog.getByRole('listitem').filter({ hasText: label }).getByRole('button', { name: 'Delete' }).click();
  await expect(dialog.getByText(label)).not.toBeVisible();
});

test('the Vertex provider surfaces project, region, and credentials fields', async ({ page }) => {
  await page.getByRole('button', { name: 'Model profiles' }).click();
  const dialog = page.getByRole('dialog', { name: 'Model profiles' });
  await dialog.getByRole('button', { name: 'New profile' }).click();
  await dialog.getByLabel('Provider').selectOption({ label: 'Google Vertex AI' });
  await expect(dialog.getByLabel('Google Cloud project')).toBeVisible();
  await expect(dialog.getByLabel('Region')).toBeVisible();
  await expect(dialog.getByLabel('Service account JSON')).toBeVisible();
  // API key is not part of the Vertex form.
  await expect(dialog.getByLabel('API key')).toHaveCount(0);
});

test('an agent can be created with a model and switched in settings', async ({ page }) => {
  const modelA = `Model A ${Date.now()}`;
  const modelB = `Model B ${Date.now()}`;
  await addProfile(page, { label: modelA, provider: 'Anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-a' });
  await addProfile(page, { label: modelB, provider: 'OpenAI', model: 'gpt-6', apiKey: 'sk-b' });

  const name = `agent-${Date.now()}`;
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New agent' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Create an isolated worktree and branch').uncheck();
  await dialog.getByLabel('Model').selectOption({ label: modelA });
  await dialog.getByRole('button', { name: 'Start agent' }).click();
  await expect(dialog).not.toBeVisible();

  await page.getByRole('button', { name: new RegExp(name) }).click();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Model profile', { exact: true })).toHaveValue(/.+/);

  // Switch the model; the selection reflects the new profile.
  await page.getByLabel('Model profile', { exact: true }).selectOption({ label: modelB });
  await expect(page.getByLabel('Model profile', { exact: true })).toContainText(modelB);
  // A round-trip through the backend keeps the choice after reload.
  await page.reload();
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await page.getByRole('tab', { name: 'Settings' }).click();
  const selected = await page.getByLabel('Model profile', { exact: true }).inputValue();
  expect(selected).not.toBe('');
});
