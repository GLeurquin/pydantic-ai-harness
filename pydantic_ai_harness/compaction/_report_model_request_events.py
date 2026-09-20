"""Events emitted by `ReportModelRequest`."""

from __future__ import annotations

from dataclasses import dataclass

from pydantic_ai import CapabilityEvent
from pydantic_ai.messages import ModelMessage

REPORT_MODEL_REQUEST_EVENTS = 'report_model_request'


@dataclass(kw_only=True)
class ModelRequestReportedEvent(CapabilityEvent, namespace=REPORT_MODEL_REQUEST_EVENTS, name='reported'):
    """The exact messages about to be sent to the model, and the model they are headed to."""

    messages: list[ModelMessage]
    """Every message in the pending request, in the order the model receives them.

    Reflects whatever earlier `before_model_request` hooks already did: a compaction capability
    registered before `ReportModelRequest` has already trimmed, cleared, or summarized by the time
    this event fires. Register `ReportModelRequest` before compaction instead to see what
    triggered it.
    """

    model_id: str | None
    """The model-name string this request's model was selected from, mirroring
    `ModelRequestContext.model_id`. `None` when the model was supplied as an instance rather than
    resolved from a string.
    """
