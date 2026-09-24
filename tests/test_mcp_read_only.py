"""Test the shared read-only selection for hosted MCP tools."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic_ai.tools import ToolDefinition

from pydantic_ai_harness._mcp import is_read_only


@pytest.mark.parametrize(
    ('metadata', 'expected'),
    [
        ({'annotations': {'readOnlyHint': True}}, True),
        ({'annotations': {'readOnlyHint': False}}, False),
        ({'annotations': {}}, False),
        (None, False),
    ],
)
def test_only_tools_marked_read_only_are_selected(metadata: dict[str, Any] | None, expected: bool) -> None:
    assert is_read_only(ToolDefinition(name='tool', metadata=metadata)) is expected
