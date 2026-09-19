"""Reload CLAI's modules before rebuilding the shell, without reloading its dependencies."""

import ast
import importlib
import importlib.util
import sys
import tokenize
from collections.abc import Callable, Iterable
from graphlib import TopologicalSorter
from pathlib import Path
from types import ModuleType
from typing import TypeVar

import pydantic_clai2

T = TypeVar('T')


class _Imports(ast.NodeVisitor):
    """Collect module-scope imports without treating lazy or type-only imports as eager dependencies."""

    def __init__(self, package: str) -> None:
        self.package = package
        self.names: set[str] = set()

    def visit_Import(self, node: ast.Import) -> None:
        self.names.update(alias.name for alias in node.names)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        name = importlib.util.resolve_name('.' * node.level + (node.module or ''), self.package)
        self.names.add(name)
        self.names.update(f'{name}.{alias.name}' for alias in node.names)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        pass

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        pass

    def visit_If(self, node: ast.If) -> None:
        test = node.test
        type_only = (
            isinstance(test, ast.Name)
            and test.id == 'TYPE_CHECKING'
            or isinstance(test, ast.Attribute)
            and test.attr == 'TYPE_CHECKING'
        )
        for statement in node.orelse if type_only else (*node.body, *node.orelse):
            self.visit(statement)


def _reload_plan(names: Iterable[str]) -> tuple[tuple[str, Path], ...]:
    sources: dict[str, Path] = {}
    for directory in pydantic_clai2.__path__:
        root = Path(directory)
        for path in sorted(root.rglob('*.py')):
            parts = path.relative_to(root).with_suffix('').parts
            if parts[-1] == '__init__':
                parts = parts[:-1]
            sources.setdefault('.'.join(('pydantic_clai2', *parts)), path)

    dependencies: dict[str, set[str]] = {}
    pending = list(names)
    while pending:
        name = pending.pop()
        if name in dependencies:
            continue
        path = sources[name]
        package = name if path.name == '__init__.py' else name.rpartition('.')[0]
        imports = _Imports(package)
        with tokenize.open(path) as source:
            imports.visit(ast.parse(source.read(), filename=str(path)))
        targets = {target for target in imports.names if target in sources and target != name}
        # Importing a submodule can also execute a previously unloaded package initializer.
        for target in tuple(targets):
            parent = target.rpartition('.')[0]
            while parent in sources:
                if parent != name:
                    targets.add(parent)
                parent = parent.rpartition('.')[0]
        dependencies[name] = targets
        pending.extend(targets - dependencies.keys())

    return tuple((name, sources[name]) for name in TopologicalSorter(dependencies).static_order())


def reload_clai(build: Callable[[], T]) -> T:
    """Order reloads from current source imports; restore bindings if reload or rebuild fails."""
    modules = {
        name: module
        for name, module in sys.modules.copy().items()
        if name == 'pydantic_clai2' or name.startswith('pydantic_clai2.')
    }
    snapshots: dict[ModuleType, dict[str, object]] = {module: vars(module).copy() for module in modules.values()}
    ordered = _reload_plan(modules)
    importlib.invalidate_caches()
    try:
        # Invalidate newly referenced modules too, before an importer can load their bytecode.
        for _, path in ordered:
            Path(importlib.util.cache_from_source(str(path))).unlink(missing_ok=True)
        for name, _ in ordered:
            if name in modules:
                importlib.reload(modules[name])
        return build()
    except BaseException:
        for module, namespace in snapshots.items():
            vars(module).clear()
            vars(module).update(namespace)
        for name in sys.modules.copy():
            if name.startswith('pydantic_clai2.') and name not in modules:
                del sys.modules[name]
        raise
