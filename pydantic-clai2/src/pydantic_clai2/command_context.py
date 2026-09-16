"""Conversation-local settings and actions behind `/set`."""

from collections.abc import Callable
from dataclasses import dataclass

from pydantic import JsonValue, TypeAdapter

from .config import SETTING_FIELDS, Settings
from .settings_store import SettingsStore


@dataclass(kw_only=True)
class CommandContext:
    """Conversation-local settings and actions, without global mutable state."""

    settings: Settings
    store: SettingsStore
    clear_history: Callable[[], None]
    apply_setting: Callable[[str, Settings], None]

    def set_setting(self, args: list[str]) -> str:
        """Validate, persist, and apply a preference to the current conversation."""
        if not args:
            return self.settings.model_dump_json(indent=2)
        if len(args) == 1 and args[0] in SETTING_FIELDS:
            return str(self.settings.model_dump()[SETTING_FIELDS[args[0]]])
        if len(args) != 2 or args[0] not in SETTING_FIELDS:
            raise ValueError('Usage: /set SETTING VALUE. Press Tab for suggestions.')
        key, raw = args
        adapter: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)
        value: JsonValue = raw if key == 'model' else adapter.validate_json(raw)
        updated = self.settings.model_dump()
        updated[SETTING_FIELDS[key]] = value
        settings = Settings.model_validate(updated)
        self.store.set(key, value)
        self.settings = settings
        self.apply_setting(key, settings)
        return f'Saved {key}. ' + ('Applies at next startup.' if key == 'display.splash' else 'Applied.')
