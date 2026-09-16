"""Validated settings, independent of persistence and terminal code."""

from pydantic import BaseModel, ConfigDict, Field, JsonValue


class Settings(BaseModel):
    """An immutable snapshot; storage contains only explicit overrides."""

    model_config = ConfigDict(extra='forbid', frozen=True, strict=True)
    model: str | None = Field(default=None, min_length=1)
    request_limit: int = Field(default=10000, gt=0)
    thinking: bool = True
    splash: bool = True


SETTING_FIELDS = {
    'model': 'model',
    'run.request_limit': 'request_limit',
    'display.thinking': 'thinking',
    'display.splash': 'splash',
}


def resolve_settings(overrides: dict[str, JsonValue]) -> Settings:
    """Reject unknown setting names and validate stored or supplied values."""
    unknown = overrides.keys() - SETTING_FIELDS.keys()
    if unknown:
        raise ValueError(f'Unknown settings: {", ".join(sorted(unknown))}')
    return Settings.model_validate({SETTING_FIELDS[key]: value for key, value in overrides.items()})


class PluginSettings(BaseModel):
    """Declaration for a trusted Python capability factory."""

    model_config = ConfigDict(extra='forbid', frozen=True, strict=True)
    id: str = Field(min_length=1)
    factory: str = Field(pattern=r'^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*$')
    enabled: bool = True
    settings: dict[str, JsonValue] = Field(default_factory=dict)
