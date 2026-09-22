"""Modal sandbox capability: gives agents an isolated cloud sandbox as their workspace.

`ModalSandbox` is the supported entry point; build an agent with it and add tools that
use `ctx.workspace`, such as `Shell` and `FileSystem`. `ModalSandboxBackend` is the Modal
implementation of Pydantic AI's workspace backend protocol, public for applications that
want to create or attach to a sandbox themselves and pass it to a run as `workspace=`.
"""

from pydantic_ai_harness.modal_sandbox._backend import ModalSandboxBackend
from pydantic_ai_harness.modal_sandbox._capability import ModalSandbox

__all__ = ['ModalSandbox', 'ModalSandboxBackend']
