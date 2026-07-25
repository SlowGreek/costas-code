"""Provider-neutral contract for one live model-runtime session.

The host is deliberately process-local and capability-advertised.  It does not
carry provider session identities, process identifiers, durable bindings, or
remote-control authority.  Construction is lazy: the first consumed operation
may start the underlying runtime.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


_CLOSED_MESSAGE = "runtime session host is closed"


class RuntimeSessionClosedError(RuntimeError):
    """Raised when an operation targets a terminally closed host."""

    def __init__(self) -> None:
        super().__init__(_CLOSED_MESSAGE)


@dataclass(frozen=True)
class RuntimeSessionCapabilities:
    """Negotiated powers for a live, in-memory runtime-session host."""

    send: bool
    steer_active_turn: bool
    interrupt: bool
    compact: bool
    close: bool
    resume_after_restart: bool = False
    durable_replay: bool = False
    external_control: bool = False
    durable_close_proof: bool = False


@dataclass
class RuntimeTurnResult:
    """Provider-neutral observable result of a send or compaction operation."""

    final_text: str = ""
    projected_messages: list[dict[str, Any]] = field(default_factory=list)
    tool_iterations: int = 0
    interrupted: bool = False
    error: str | None = None
    token_usage_last: dict[str, Any] | None = None
    token_usage_total: dict[str, Any] | None = None
    model_context_window: int | None = None
    compacted: bool = False
    should_retire: bool = False


@runtime_checkable
class RuntimeSessionHost(Protocol):
    """Small process-local control waist consumed by ``AIAgent``."""

    @property
    def capabilities(self) -> RuntimeSessionCapabilities: ...

    def send(self, message: Any) -> RuntimeTurnResult: ...

    def steer_active_turn(self, text: str) -> bool: ...

    def interrupt(self) -> None: ...

    def compact(self) -> RuntimeTurnResult: ...

    def close(self) -> None: ...
