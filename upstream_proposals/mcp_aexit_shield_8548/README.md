# Upstream Core Fix Proposal: Shield `MCPToolset.__aexit__` Cleanup

> [!NOTE]
> **AI-generated content disclaimer:** This proposal was generated with AI assistance. The code and tests should be reviewed by a human before merging.

**Issue:** pydantic/pydantic-ai#8548

## Summary

Shield `MCPToolset.__aexit__` cleanup before lock acquisition so outer AnyIO
cancellation cannot interrupt teardown. This preserves reference counts and
shared ownership semantics.

## Problem

When an outer AnyIO cancel scope cancels a task while `MCPToolset.__aexit__` is
waiting to acquire `_enter_lock`, the cleanup code never runs:

1. The lock acquisition (`async with self._enter_lock`) is a cancellation
   checkpoint
2. If cancelled at that point, the cleanup that follows -- closing the exit
   stack, terminating the subprocess, resetting `_running_count` -- never
   executes
3. Subsequent reuse of the toolset fails because `_running_count` is left in an
   inconsistent state, and stdio processes may leak

This is documented in `agent_docs/concurrency.md`:

> Shield cleanup that must complete under an outer `anyio` cancel. Your
> `finally` and each child's cleanup are unprotected unless they shield
> themselves.

## Proposed Fix

Wrap the entire `__aexit__` body in `anyio.CancelScope(shield=True)` so that:

1. Lock acquisition cannot be interrupted
2. Reference count decrement is atomic with cleanup
3. Exit stack close (and stdio process termination) runs to completion

```python
async def __aexit__(self, *args: Any) -> bool | None:
    with anyio.CancelScope(shield=True):
        async with self._enter_lock:
            if self._running_count == 0:
                raise ValueError(f'`{self.__class__.__name__}.__aexit__` called more times than `__aenter__`')
            self._running_count -= 1
            if self._running_count == 0 and self._exit_stack is not None:
                await self._exit_stack.aclose()
                self._exit_stack = None
                self._server_info = None
                self._server_capabilities = None
                self._instructions = None
                self._cached_tools = None
                self._cached_resources = None
                self._cached_prompts = None
    return None
```

## Regression Test

The included test (`test_mcp_cancel_cleanup.py`) verifies:

1. A real stdio MCP process is properly cleaned up when outer cancellation
   occurs
2. The subprocess does not leak (process group is gone after cleanup)
3. The toolset can be reused after cancellation-interrupted cleanup

The test uses a real outer AnyIO cancel scope -- not a bare `CancelledError`
raise -- as specified in `agent_docs/concurrency.md`:

> Reach the real trigger. Level-cancellation behavior needs a real outer
> `anyio` cancel scope, not a bare `CancelledError` raise

## Files

- `mcp_aexit_fix.py` -- The proposed `MCPToolset.__aexit__` implementation
- `test_mcp_cancel_cleanup.py` -- Regression test for stdio process cleanup
  under outer cancellation

## Preserves

- Reference counting semantics (`_running_count`)
- Shared ownership (multiple `async with` on the same toolset)
- Exit stack cleanup order (LIFO via `AsyncExitStack.aclose`)
- All existing behavior when not under cancellation
