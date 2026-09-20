"""Git worktrees for isolated CLI workspaces."""

import re
import subprocess
from pathlib import Path
from uuid import uuid4


def create_worktree(*, name: str) -> Path:
    """Create a sibling checkout on a new `clai/<name>` branch, keeping the launch checkout untouched."""
    name = name or f'worktree-{uuid4().hex[:8]}'
    if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', name) is None:
        raise ValueError('Worktree names must start with a letter or digit and contain only letters, digits, - or _.')
    try:
        root = Path(
            subprocess.run(
                ['git', 'rev-parse', '--show-toplevel'], check=True, capture_output=True, text=True
            ).stdout.removesuffix('\n')
        )
        path = root.parent / f'{root.name}.worktrees' / name
        subprocess.run(
            ['git', 'worktree', 'add', '-b', f'clai/{name}', '--', str(path), 'HEAD'],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        raise ValueError(f'Cannot create worktree: {exc.stderr.strip()}') from exc
    except OSError as exc:
        raise ValueError(f'Cannot run Git to create worktree: {exc}') from exc
    return path
