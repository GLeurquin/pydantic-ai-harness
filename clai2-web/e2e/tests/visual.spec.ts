import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Ladle's build emits one entry per story; { story: '<id>', mode: 'preview' }
// is Ladle's own documented isolation contract (see
// node_modules/@ladle/react lib/app/src/{story-name,history}.ts and
// lib/app/src/addons/mode.tsx) -- no chrome, just the rendered story, which
// is exactly what a pixel-diff needs.
interface LadleMeta {
  stories: Record<string, { name: string; levels: string[] }>;
}

const meta: LadleMeta = JSON.parse(readFileSync(join(import.meta.dirname, '../../frontend/build/meta.json'), 'utf-8'));
const storyIds = Object.keys(meta.stories).sort();

test.describe('Ladle story visual regression', () => {
  for (const id of storyIds) {
    const story = meta.stories[id];
    if (!story) {
      continue;
    }
    test(`${story.levels.join(' > ')} > ${story.name}`, async ({ page }) => {
      await page.goto(`/?story=${id}&mode=preview`);
      // Ladle's preview mode renders only the story; wait for its own root
      // rather than a component-specific selector so this stays generic
      // across every story.
      await page.waitForSelector('#ladle-root *', { state: 'attached' });
      await expect(page).toHaveScreenshot(`${id}.png`);
    });
  }
});
