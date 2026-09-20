"""Git worktrees for isolated CLI workspaces."""

import re
import subprocess
from pathlib import Path
from uuid import uuid4


def create_worktree(*, name: str) -> Path:
    """Create a checkout in `.worktrees` on a new `clai/<name>` branch."""
    name = name or f'worktree-{uuid4().hex[:8]}'
    if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', name) is None:
        raise ValueError('Worktree names must start with a letter or digit and contain only letters, digits, - or _.')
    try:
        root = Path(_git('rev-parse', '--show-toplevel'))
        exclude = Path(_git('rev-parse', '--git-path', 'info/exclude'))
        contents = exclude.read_bytes() if exclude.exists() else b''
        if b'/.worktrees/' not in contents.splitlines():
            exclude.parent.mkdir(parents=True, exist_ok=True)
            with exclude.open('ab') as file:
                file.write(b'\n/.worktrees/\n')
        path = root / '.worktrees' / name
        _git('worktree', 'add', '-b', f'clai/{name}', '--', str(path), 'HEAD')
    except subprocess.CalledProcessError as exc:
        raise ValueError(f'Cannot create worktree: {exc.stderr.strip()}') from exc
    except OSError as exc:
        raise ValueError(f'Cannot create worktree: {exc}') from exc
    return path


def _git(*args: str) -> str:
    return subprocess.run(['git', *args], check=True, capture_output=True, text=True).stdout.removesuffix('\n')
