"""Proposed fix for MCPToolset.__aexit__ cancellation safety.

This file shows the proposed change to `pydantic_ai.mcp.MCPToolset.__aexit__`
that shields cleanup so outer AnyIO cancellation cannot interrupt teardown.

Apply this change to pydantic_ai_slim/pydantic_ai/mcp.py in the upstream
pydantic-ai repository.
"""

from __future__ import annotations

# The only change needed is to wrap the __aexit__ body in anyio.CancelScope(shield=True)
#
# BEFORE (current implementation in mcp.py):
#
#     async def __aexit__(self, *args: Any) -> bool | None:
#         async with self._enter_lock:
#             if self._running_count == 0:
#                 raise ValueError(f'`{self.__class__.__name__}.__aexit__` called more times than `__aenter__`')
#             self._running_count -= 1
#             if self._running_count == 0 and self._exit_stack is not None:
#                 await self._exit_stack.aclose()
#                 self._exit_stack = None
#                 self._server_info = None
#                 self._server_capabilities = None
#                 self._instructions = None
#                 self._cached_tools = None
#                 self._cached_resources = None
#                 self._cached_prompts = None
#         return None
#
#
# AFTER (proposed fix):
#
#     async def __aexit__(self, *args: Any) -> bool | None:
#         with anyio.CancelScope(shield=True):
#             async with self._enter_lock:
#                 if self._running_count == 0:
#                     raise ValueError(f'`{self.__class__.__name__}.__aexit__` called more times than `__aenter__`')
#                 self._running_count -= 1
#                 if self._running_count == 0 and self._exit_stack is not None:
#                     await self._exit_stack.aclose()
#                     self._exit_stack = None
#                     self._server_info = None
#                     self._server_capabilities = None
#                     self._instructions = None
#                     self._cached_tools = None
#                     self._cached_resources = None
#                     self._cached_prompts = None
#         return None
#
#
# The shield ensures:
#
# 1. Lock acquisition (`async with self._enter_lock`) cannot be interrupted by
#    an outer cancel scope -- this is a cancellation checkpoint that would
#    otherwise abort cleanup entirely
#
# 2. Reference count decrement is atomic with cleanup -- if we decremented
#    `_running_count` but didn't finish cleanup, subsequent reuse would see
#    inconsistent state
#
# 3. Exit stack close runs to completion -- this includes stdio subprocess
#    termination and stream cleanup; leaking these resources is the observable
#    bug this fixes
#
# 4. State reset completes -- cached tools/resources/prompts must be cleared
#    when the last session closes, or stale data persists into the next
#    `__aenter__`
