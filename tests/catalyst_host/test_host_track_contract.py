"""Static integration gate for the Catalyst Hermes-visible host track.

This suite deliberately does not import or invoke an execution endpoint.  It
checks the provider-neutral runtime waist, content-addressed sibling receipts,
and any later owner-produced R0/C2 source once those claimed paths exist.
Missing future owner paths are reported as pending; a path that exists is a
claim and must satisfy the closed contract.
"""

from __future__ import annotations

import ast
import inspect
import json
from dataclasses import fields
from pathlib import Path
from typing import get_type_hints

import pytest

from agent.runtime_sessions import (
    RuntimeSessionCapabilities,
    RuntimeSessionHost,
    RuntimeTurnResult,
)
from agent.transports.codex_app_server_session import CodexRuntimeSessionHost


COSTAS_ROOT = Path(__file__).resolve().parents[2]
AE_ROOT = COSTAS_ROOT.parent / "AgentExperiments"

# The graph is intentionally data, rather than inferred from prose ordering.
# An edge (a, b) means a must be closed before b can claim readiness.
HOST_TRACK = {
    "owners": {
        "costas-runtime": frozenset(
            {
                "agent/runtime_sessions.py",
                "agent/transports/codex_app_server_session.py",
                "agent/codex_runtime.py",
                "agent/conversation_compression.py",
                "run_agent.py",
                "tests/agent/test_runtime_sessions.py",
            }
        ),
        "costas-r0": frozenset(
            {
                "gateway/execution_host_protocol.py",
                "tests/gateway/test_execution_host_protocol.py",
            }
        ),
        "costas-c2": frozenset(
            {
                "hermes_state.py",
                "tests/hermes_state/test_external_role_session_binding.py",
            }
        ),
        "agentexperiments-f5": frozenset(
            {
                "butler/src/catalyst_enrollment/enrollment.rs",
                "butler/src/catalyst_enrollment/executor.rs",
                "butler/src/catalyst_enrollment/canary.rs",
                "butler/src/catalyst_enrollment/f1_adapter.rs",
                "butler/tests/catalyst_enrollment.rs",
                "docs/CATALYST-F5-FEEDFORWARD.md",
                "docs/CATALYST-F5-PROVISIONAL-RECEIPT.json",
            }
        ),
    },
    "native_edges": (
        ("F0a", "F0b"),
        ("F0b", "F0c"),
        ("F0c", "F1"),
        ("F1", "F2"),
        ("F1", "F3"),
        ("F1", "F4"),
        ("F4", "F6"),
        ("F2", "F7a"),
        ("F3", "F7a"),
        ("F4", "F7a"),
        ("F7a", "F7b"),
        ("F6", "F7b"),
        ("F7a", "F8"),
        ("F7b", "F8"),
    ),
    "host_edges": (
        ("C0", "C1"),
        ("C1", "A0"),
        ("C1", "A1"),
        ("A0", "F5a"),
        ("A1", "F5a"),
        ("F5a", "F5b"),
        ("F5b", "F5c"),
    ),
    "convergence_edges": (("F1", "F5a"), ("F5a", "F7b")),
    "fleet_policy": {
        "launch": False,
        "mutation": False,
        "first_canary": "read-only",
        "acceptance_owner": "QUINE",
    },
}

FORBIDDEN_GENERIC_ID_PARTS = (
    "codex",
    "provider",
    "thread_id",
    "turn_id",
    "process_id",
    "pid",
)

R0_FORBIDDEN_IMPORT_ROOTS = {
    "agent",
    "run_agent",
    "tui_gateway",
    "fastapi",
    "flask",
    "socket",
    "starlette",
    "uvicorn",
}
R0_FORBIDDEN_DECORATORS = {"get", "post", "put", "patch", "delete", "websocket", "route"}


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _assert_acyclic(edges: tuple[tuple[str, str], ...]) -> None:
    successors: dict[str, set[str]] = {}
    indegree: dict[str, int] = {}
    for source, target in edges:
        successors.setdefault(source, set()).add(target)
        successors.setdefault(target, set())
        indegree.setdefault(source, 0)
        indegree[target] = indegree.get(target, 0) + 1
    ready = [node for node, degree in indegree.items() if degree == 0]
    visited: list[str] = []
    while ready:
        node = ready.pop()
        visited.append(node)
        for target in successors[node]:
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
    assert set(visited) == set(indegree), "host-track dependency graph contains a cycle"


def _pending_unless_claimed(path: Path, checkpoint: str) -> str:
    if not path.exists():
        pytest.skip(f"PENDING {checkpoint}: owner path has not claimed the checkpoint: {path}")
    return path.read_text(encoding="utf-8")


def _import_roots(tree: ast.AST) -> set[str]:
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".", 1)[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            roots.add(node.module.split(".", 1)[0])
    return roots


def _decorator_leaf(decorator: ast.expr) -> str | None:
    if isinstance(decorator, ast.Call):
        decorator = decorator.func
    if isinstance(decorator, ast.Name):
        return decorator.id
    if isinstance(decorator, ast.Attribute):
        return decorator.attr
    return None


def test_owner_paths_are_pairwise_disjoint_and_repository_scoped():
    owners = HOST_TRACK["owners"]
    claimed: dict[str, str] = {}
    for owner, paths in owners.items():
        expected_repository = "agentexperiments" if owner.startswith("agentexperiments") else "costas"
        for path in paths:
            assert not Path(path).is_absolute()
            assert ".." not in Path(path).parts
            key = f"{expected_repository}:{path.casefold()}"
            assert key not in claimed, f"{path} is claimed by both {claimed[key]} and {owner}"
            claimed[key] = owner

    costas_paths = set().union(
        *(paths for owner, paths in owners.items() if owner.startswith("costas"))
    )
    ae_paths = set().union(
        *(paths for owner, paths in owners.items() if owner.startswith("agentexperiments"))
    )
    assert costas_paths.isdisjoint(ae_paths)


def test_runtime_host_symbols_and_results_are_provider_neutral():
    public_types = (RuntimeSessionCapabilities, RuntimeTurnResult, RuntimeSessionHost)
    public_names = {value.__name__.casefold() for value in public_types}
    public_members = {
        name.casefold()
        for value in public_types
        for name in getattr(value, "__annotations__", {})
    }
    public_members.update(
        name.casefold()
        for name, _ in inspect.getmembers(RuntimeSessionHost, inspect.isfunction)
        if not name.startswith("_")
    )
    annotation_values = [
        annotation
        for value in public_types
        for annotation in get_type_hints(value).values()
    ]
    annotation_values.extend(
        annotation
        for name, member in inspect.getmembers(RuntimeSessionHost, inspect.isfunction)
        if not name.startswith("_")
        for annotation in get_type_hints(member).values()
    )
    annotations = " ".join(str(annotation).casefold() for annotation in annotation_values)
    generic_surface = public_names | public_members

    for forbidden in FORBIDDEN_GENERIC_ID_PARTS:
        assert all(forbidden not in symbol for symbol in generic_surface)
        assert forbidden not in annotations

    assert {field.name for field in fields(RuntimeTurnResult)} == {
        "final_text",
        "projected_messages",
        "tool_iterations",
        "interrupted",
        "error",
        "token_usage_last",
        "token_usage_total",
        "model_context_window",
        "compacted",
        "should_retire",
    }


def test_runtime_host_false_capability_cells_are_explicit_and_not_emulated():
    capabilities = CodexRuntimeSessionHost._CAPABILITIES
    assert capabilities == RuntimeSessionCapabilities(
        send=True,
        steer_active_turn=True,
        interrupt=True,
        compact=True,
        close=True,
        resume_after_restart=False,
        durable_replay=False,
        external_control=False,
        durable_close_proof=False,
    )
    assert not hasattr(RuntimeSessionHost, "resume")
    assert not hasattr(RuntimeSessionHost, "replay")


def test_f1_receipt_preserves_exact_disposition_and_no_authority():
    receipt_path = AE_ROOT / "butler/conversation-core/F1-RECEIPT.json"
    if not receipt_path.exists():
        pytest.skip(f"PENDING F1 sibling receipt: {receipt_path}")
    receipt = _read_json(receipt_path)
    assert receipt["authority"] == "none"
    assert receipt["disposition"]["counts"] == {
        "reduced": 11,
        "externally_observed": 5,
        "explicitly_unavailable": 3,
    }


def test_f5_live_receipt_preserves_semantic_hold_after_deterministic_integration():
    receipt_path = AE_ROOT / "docs/CATALYST-F5-PROVISIONAL-RECEIPT.json"
    if not receipt_path.exists():
        pytest.skip(f"PENDING F5 sibling receipt: {receipt_path}")
    receipt = _read_json(receipt_path)
    residuals = set(receipt["residuals"])
    assert receipt["phase"] == "F5"
    assert "provisional" in receipt["status"].casefold()
    assert receipt["authority"] == "none"
    assert receipt["disposition"].casefold().startswith("hold")
    assert "live-cryptographic-costas-attestation-unavailable" in residuals
    assert "below-shell-lease-mediation-unavailable" in residuals


def test_r0_claim_has_no_endpoint_or_runtime_imports():
    path = COSTAS_ROOT / "gateway/execution_host_protocol.py"
    source = _pending_unless_claimed(path, "R0 parser/verifier")
    tree = ast.parse(source, filename=str(path))

    assert not (_import_roots(tree) & R0_FORBIDDEN_IMPORT_ROOTS)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            leaves = {_decorator_leaf(item) for item in node.decorator_list}
            assert not (leaves & R0_FORBIDDEN_DECORATORS)


def test_visible_child_claim_uses_literal_observe_authority():
    path = COSTAS_ROOT / "hermes_state.py"
    source = _pending_unless_claimed(path, "C2 visible-child binding")
    tree = ast.parse(source, filename=str(path))

    authority_literals = {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }
    assert "observe" in authority_literals
    assert "external_role_session_bindings" in source
    assert "create_external_role_session_binding" in source
    assert "list_delegate_children" in source
    binding_block = source[
        source.index("CREATE TABLE IF NOT EXISTS external_role_session_bindings") :
        source.index("CREATE INDEX IF NOT EXISTS idx_sessions_source")
    ]
    assert "model_config" not in binding_block
    assert not any(
        part in binding_block.casefold()
        for part in ("provider", "runtime", "codex_thread", "codex_turn", "capability", "lease", "prompt")
    )


def test_fleet_policy_forbids_launch_and_mutation():
    assert HOST_TRACK["fleet_policy"] == {
        "launch": False,
        "mutation": False,
        "first_canary": "read-only",
        "acceptance_owner": "QUINE",
    }

    receipt_path = AE_ROOT / "docs/CATALYST-F5-PROVISIONAL-RECEIPT.json"
    if receipt_path.exists():
        receipt = _read_json(receipt_path)
        residuals = set(receipt["residuals"])
        assert receipt["phase"] == "F5"
        assert receipt["authority"] == "none"
        assert "provisional" in receipt["status"].casefold()
        assert receipt["disposition"].casefold().startswith("hold")
        assert "live-cryptographic-costas-attestation-unavailable" in residuals
        assert "below-shell-lease-mediation-unavailable" in residuals


def test_dependency_and_order_graph_is_exact_and_parallel():
    assert HOST_TRACK["native_edges"] == (
        ("F0a", "F0b"),
        ("F0b", "F0c"),
        ("F0c", "F1"),
        ("F1", "F2"),
        ("F1", "F3"),
        ("F1", "F4"),
        ("F4", "F6"),
        ("F2", "F7a"),
        ("F3", "F7a"),
        ("F4", "F7a"),
        ("F7a", "F7b"),
        ("F6", "F7b"),
        ("F7a", "F8"),
        ("F7b", "F8"),
    )
    assert HOST_TRACK["host_edges"] == (
        ("C0", "C1"),
        ("C1", "A0"),
        ("C1", "A1"),
        ("A0", "F5a"),
        ("A1", "F5a"),
        ("F5a", "F5b"),
        ("F5b", "F5c"),
    )
    assert HOST_TRACK["convergence_edges"] == (("F1", "F5a"), ("F5a", "F7b"))

    all_edges = (
        HOST_TRACK["native_edges"]
        + HOST_TRACK["host_edges"]
        + HOST_TRACK["convergence_edges"]
    )
    _assert_acyclic(all_edges)
    assert ("F3", "F5a") not in all_edges
    assert ("F4", "F5a") not in all_edges
    assert ("F5a", "F1") not in all_edges
