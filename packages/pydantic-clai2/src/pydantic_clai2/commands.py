"""One command registry for execution, help, and prompt-toolkit completion."""

import json
import shlex
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from prompt_toolkit.completion import CompleteEvent, Completer, Completion, PathCompleter
from prompt_toolkit.document import Document
from pydantic import JsonValue, TypeAdapter

from .config import SETTING_FIELDS, PluginSettings
from .settings_store import SettingsStore


@dataclass(frozen=True, kw_only=True)
class Command:
    """A command available to both dispatch and autocomplete."""

    name: str
    description: str
    handler: Callable[[list[str]], str]
    complete: Callable[[list[str]], Iterable[str]] = lambda _: ()


class Commands(Completer):
    """Instance-owned registry, based on Code Puppy's registry/completer pattern."""

    def __init__(self) -> None:
        """Create an empty registry and filesystem completer."""
        self._commands: dict[str, Command] = {}
        self._paths = PathCompleter(expanduser=True)

    def register(self, command: Command) -> None:
        """Register one command, rejecting ambiguous duplicate names."""
        if command.name in self._commands or not command.name.isidentifier():
            raise ValueError(f'Invalid or duplicate command: {command.name}')
        self._commands[command.name] = command

    def execute(self, text: str) -> str:
        """Parse shell-style arguments and dispatch without invoking a shell."""
        words = shlex.split(text.removeprefix('/'))
        if not words:
            return self.help([])
        name, *args = words
        command = self._commands.get(name)
        if command is None:
            raise ValueError(f'Unknown command /{name}. Use /help.')
        return command.handler(args)

    def get_completions(self, document: Document, complete_event: CompleteEvent) -> Iterable[Completion]:
        """Complete slash commands, contextual arguments, and @file paths."""
        text = document.text_before_cursor
        if not text.startswith('/'):
            word = document.get_word_before_cursor(WORD=True)
            if word.startswith('@'):
                yield from self._paths.get_completions(Document(word[1:]), complete_event)
            return
        words = text[1:].split()
        if len(words) <= 1 and not text.endswith(' '):
            prefix = text[1:]
            for command in self._commands.values():
                if command.name.startswith(prefix):
                    yield Completion(command.name, start_position=-len(prefix), display_meta=command.description)
            return
        if not words:
            return
        command = self._commands.get(words[0])
        if command is None:
            return
        args = words[1:]
        if text.endswith(' '):
            args.append('')
        prefix = args[-1] if args else ''
        for candidate in command.complete(args):
            if candidate.startswith(prefix):
                yield Completion(candidate, start_position=-len(prefix))

    def help(self, _: list[str]) -> str:
        """Generate help from the same registry used for completion."""
        return '\n'.join(f'/{command.name}: {command.description}' for command in self._commands.values())


def config_command(store: SettingsStore, args: list[str]) -> str:
    """Share settings commands between the terminal and CLI."""
    if args == ['show'] or not args:
        return store.load().model_dump_json(indent=2)
    if len(args) == 2 and args[0] == 'get':
        field = SETTING_FIELDS.get(args[1])
        if field is None:
            raise ValueError(f'Unknown setting: {args[1]}')
        return json.dumps(store.load().model_dump()[field])
    if len(args) == 2 and args[0] == 'reset':
        store.reset(args[1])
    elif len(args) == 3 and args[0] == 'set':
        adapter: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)
        value: JsonValue = args[2] if args[1] == 'model' else adapter.validate_json(args[2])
        store.set(args[1], value)
    else:
        raise ValueError('Usage: config show|get KEY|set KEY VALUE|reset KEY')
    return 'Saved. Applies when you restart CLAI.'


def config_completions(args: list[str]) -> Iterable[str]:
    """Suggest operations, setting names, and boolean values."""
    if len(args) <= 1:
        return ('show', 'get', 'set', 'reset')
    if len(args) == 2 and args[0] in ('get', 'set', 'reset'):
        return SETTING_FIELDS
    if len(args) == 3 and args[0] == 'set' and args[1].startswith('display.'):
        return ('true', 'false')
    return ()


def plugins_command(store: SettingsStore, args: list[str]) -> str:
    """Manage explicit plugin declarations without importing plugins."""
    declarations = store.plugins()
    if not args or args == ['list']:
        return (
            '\n'.join(f'{p.id}: {p.factory} ({"enabled" if p.enabled else "disabled"})' for p in declarations)
            or 'No plugins.'
        )
    if len(args) in (3, 4) and args[0] == 'add':
        settings = TypeAdapter(dict[str, JsonValue]).validate_json(args[3]) if len(args) == 4 else {}
        store.save_plugin(PluginSettings(id=args[1], factory=args[2], settings=settings))
    elif len(args) == 2 and args[0] in ('enable', 'disable'):
        plugin = next((p for p in declarations if p.id == args[1]), None)
        if plugin is None:
            raise ValueError(f'Unknown plugin: {args[1]}')
        store.save_plugin(plugin.model_copy(update={'enabled': args[0] == 'enable'}))
    else:
        raise ValueError('Usage: plugins list|add ID MODULE:CLASS [JSON]|enable ID|disable ID')
    return 'Saved. Plugin code is trusted and will load on next startup.'
