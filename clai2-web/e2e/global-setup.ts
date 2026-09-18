import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Fresh state for every run: a small git repo for agents to work in. */
export default function globalSetup(): void {
  const tmp = join(import.meta.dirname, '.tmp');
  rmSync(tmp, { recursive: true, force: true });
  const repo = join(tmp, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  writeFileSync(join(repo, 'README.md'), '# e2e demo\n');
  git('add', '.');
  git('commit', '-m', 'init');
}
