"""Check source-based reload planning in a fresh process, using only its public entry point."""

import importlib
import os
import py_compile
import sys
from graphlib import CycleError
from pathlib import Path

import pytest


def main(root: Path, mode: str) -> None:
    sys.path.insert(0, str(root))
    # Import the fixture package rather than the installed shell.
    from pydantic_clai2.reloading import reload_clai  # noqa: PLC0415

    package = root / 'pydantic_clai2'
    provider_path = package / 'reload_provider.py'
    consumer_path = package / 'reload_consumer.py'
    (package / 'reload_leaf.py').write_text("VALUE = 'old'\n")
    provider_path.write_text('from . import reload_leaf\nVALUE = reload_leaf.VALUE\n')
    consumer_path.write_text("VALUE = 'old'\n")
    consumer = importlib.import_module('pydantic_clai2.reload_consumer')
    provider = importlib.import_module('pydantic_clai2.reload_provider')
    original_consumer = vars(consumer).copy()
    original_provider = vars(provider).copy()
    provider_path.write_text("NEW = 'new'\n")
    new_consumer = 'from .reload_provider import NEW\nVALUE = NEW\n'

    if mode == 'absolute':
        new_consumer = 'from pydantic_clai2.reload_provider import NEW\nVALUE = NEW\n'
    elif mode == 'module':
        new_consumer = 'import pydantic_clai2.reload_provider as dependency\nVALUE = dependency.NEW\n'
    elif mode == 'relative_module':
        new_consumer = 'from . import reload_provider as dependency\nVALUE = dependency.NEW\n'
    elif mode == 'class':
        new_consumer = 'class Values:\n    from .reload_provider import NEW\nVALUE = Values.NEW\n'
    elif mode == 'reverse':
        consumer_path.write_text('from . import reload_provider\nVALUE = reload_provider.VALUE\n')
        importlib.reload(consumer)
        new_consumer = "NEW = 'new'\nVALUE = NEW\n"
        provider_path.write_text('from .reload_consumer import NEW\n')
    elif mode == 'lazy':
        provider_path.write_text(
            'import typing\n'
            'from typing import TYPE_CHECKING\n'
            'if TYPE_CHECKING:\n    from .reload_consumer import VALUE\n'
            'else:\n    CONSTANT = 1\n'
            'if typing.TYPE_CHECKING:\n    from .reload_consumer import VALUE\n'
            'def lazy():\n    from .reload_consumer import VALUE\n    return VALUE\n'
            'async def async_lazy():\n    from .reload_consumer import VALUE\n    return VALUE\n'
            "NEW = 'new'\n"
        )
    elif mode == 'inactive':
        (package / 'unused.py').write_text('raise RuntimeError("must not import inactive modules")\n')
        new_consumer += 'if False:\n    from .unused import VALUE\n'
    elif mode in ('new_package', 'import_error', 'build_error'):
        bridge = package / 'reload_bridge'
        bridge.mkdir()
        (bridge / '__init__.py').write_text('from ..reload_provider import NEW\n')
        bridge_path = bridge / 'bridge.py'
        bridge_path.write_text("from ..reload_provider import NEW\nVALUE = 'old'\n")
        py_compile.compile(str(bridge_path), doraise=True)
        timestamp = bridge_path.stat()
        bridge_path.write_text('from ..reload_provider import NEW\nVALUE = NEW  \n')
        assert bridge_path.stat().st_size == timestamp.st_size
        os.utime(bridge_path, ns=(timestamp.st_atime_ns, timestamp.st_mtime_ns))
        new_consumer = 'from .reload_bridge.bridge import VALUE\n'
    elif mode == 'cycle':
        provider_path.write_text('from .reload_consumer import VALUE\nNEW = VALUE\n')
    elif mode == 'syntax':
        provider_path.write_text('invalid syntax!\n')

    consumer_path.write_text(new_consumer)
    if mode == 'import_error':
        consumer_path.write_text(new_consumer + 'raise RuntimeError("failed import")\n')

    def build() -> object:
        if mode == 'build_error':
            raise RuntimeError('failed build')
        return consumer.VALUE

    if mode in ('import_error', 'build_error', 'cycle', 'syntax'):
        expected = CycleError if mode == 'cycle' else SyntaxError if mode == 'syntax' else RuntimeError
        with pytest.raises(expected):
            reload_clai(build)
        assert vars(consumer) == original_consumer
        assert vars(provider) == original_provider
        assert 'pydantic_clai2.reload_bridge' not in sys.modules
        assert 'pydantic_clai2.reload_bridge.bridge' not in sys.modules
        assert 'reload_bridge' not in vars(sys.modules['pydantic_clai2'])
        provider_path.write_text("NEW = 'new'\n")
        consumer_path.write_text(new_consumer)

    assert reload_clai(lambda: consumer.VALUE) == 'new'
    assert sys.modules['pydantic_clai2.reload_consumer'] is consumer
    assert sys.modules['pydantic_clai2.reload_provider'] is provider
    assert 'pydantic_clai2.unused' not in sys.modules


main(Path(sys.argv[1]), sys.argv[2])
