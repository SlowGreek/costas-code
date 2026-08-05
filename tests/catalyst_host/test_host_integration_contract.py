"""Static contract for Catalyst host integration ownership and safety."""

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


CATALYST_ROOT = Path(__file__).resolve().parents[2]
AE_ROOT = CATALYST_ROOT.parent

HOST_CONTRACT = {
    "owners": {
        "runtime-session-host": frozenset(
            {
                "agent/runtime_sessions.py",
                "agent/transports/codex_app_server_session.py",
                "agent/codex_runtime.py",
                "agent/conversation_compression.py",
                "run_agent.py",
                "tests/agent/test_runtime_sessions.py",
            }
        ),
        "execution-host-verifier": frozenset(
            {
                "gateway/execution_host_protocol.py",
                "tests/gateway/test_execution_host_protocol.py",
            }
        ),
        "visible-host-binding": frozenset(
            {
                "hermes_state.py",
                "tests/hermes_state/test_external_role_session_binding.py",
            }
        ),
        "runtime-enrollment": frozenset(
            {
                "butler/src/catalyst_enrollment/enrollment.rs",
                "butler/src/catalyst_enrollment/executor.rs",
                "butler/src/catalyst_enrollment/canary.rs",
                "butler/src/catalyst_enrollment/conversation_contract_adapter.rs",
                "butler/tests/catalyst_enrollment.rs",
                "run/receipts/CATALYST-ENROLLMENT-PROVISIONAL-RECEIPT.json",
            }
        ),
    },
    "conversation_edges": (
        ("captured conversation corpus", "captured prior inputs"),
        ("captured prior inputs", "conversation contract"),
        ("conversation contract", "conversation presentation"),
        ("conversation contract", "conversation store"),
        ("conversation contract", "runtime adaptation"),
        ("runtime adaptation", "provider admission"),
        ("conversation presentation", "owner integration"),
        ("conversation store", "owner integration"),
        ("runtime adaptation", "owner integration"),
        ("owner integration", "admitted provider"),
        ("provider admission", "admitted provider"),
    ),
    "enrollment_edges": (
        ("package integrity", "runtime enrollment"),
        ("runtime enrollment", "read-only observation"),
        ("read-only observation", "exact control"),
        ("exact control", "launch and mutation mediation"),
    ),
    "convergence_edges": (
        ("conversation contract", "read-only observation"),
        ("read-only observation", "admitted provider"),
    ),
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

EXECUTION_HOST_FORBIDDEN_IMPORT_ROOTS = {
    "agent",
    "run_agent",
    "tui_gateway",
    "fastapi",
    "flask",
    "socket",
    "starlette",
    "uvicorn",
}
EXECUTION_HOST_FORBIDDEN_DECORATORS = {
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "websocket",
    "route",
}


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
    assert set(visited) == set(indegree), "host dependency graph contains a cycle"


def _claimed_source(path: Path, contract: str) -> str:
    if not path.exists():
        pytest.skip(f"PENDING {contract}: owner path has not claimed the contract: {path}")
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
    claimed: dict[str, str] = {}
    for owner, paths in HOST_CONTRACT["owners"].items():
        repository = "agentexperiments" if owner == "runtime-enrollment" else "catalyst"
        for path in paths:
            assert not Path(path).is_absolute()
            assert ".." not in Path(path).parts
            key = f"{repository}:{path.casefold()}"
            assert key not in claimed, f"{path} is claimed by both {claimed[key]} and {owner}"
            claimed[key] = owner


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
        for name, member in inspect.getmembers(RuntimeSessionHost, inspect.isfunction)
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
    for forbidden in FORBIDDEN_GENERIC_ID_PARTS:
        assert all(forbidden not in symbol for symbol in public_names | public_members)
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


def test_runtime_host_false_capabilities_are_explicit_and_not_emulated():
    assert CodexRuntimeSessionHost._CAPABILITIES == RuntimeSessionCapabilities(
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


def test_conversation_contract_preserves_exact_disposition_and_no_authority():
    receipt = _read_json(
        AE_ROOT / "butler/conversation-core/CONVERSATION-CONTRACT-RECEIPT.json"
    )
    assert receipt["authority"] == "none"
    assert receipt["disposition"]["counts"] == {
        "reduced": 11,
        "externally_observed": 5,
        "explicitly_unavailable": 3,
    }


def test_runtime_enrollment_remains_provisional_and_without_authority():
    receipt = _read_json(
        AE_ROOT / "run/receipts/CATALYST-ENROLLMENT-PROVISIONAL-RECEIPT.json"
    )
    residuals = set(receipt["residuals"])
    assert receipt["contract"] == "runtime-enrollment"
    assert "provisional" in receipt["status"].casefold()
    assert receipt["authority"] == "none"
    assert receipt["disposition"].casefold().startswith("hold")
    assert "live-cryptographic-costas-attestation-unavailable" in residuals
    assert "below-shell-lease-mediation-unavailable" in residuals


def test_execution_host_verifier_has_no_endpoint_or_runtime_imports():
    path = CATALYST_ROOT / "gateway/execution_host_protocol.py"
    source = _claimed_source(path, "execution host verifier")
    tree = ast.parse(source, filename=str(path))
    assert not (_import_roots(tree) & EXECUTION_HOST_FORBIDDEN_IMPORT_ROOTS)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            leaves = {_decorator_leaf(item) for item in node.decorator_list}
            assert not (leaves & EXECUTION_HOST_FORBIDDEN_DECORATORS)


def test_visible_host_binding_uses_literal_observe_authority():
    path = CATALYST_ROOT / "hermes_state.py"
    source = _claimed_source(path, "visible host binding")
    tree = ast.parse(source, filename=str(path))
    literals = {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }
    assert "observe" in literals
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
        for part in (
            "provider",
            "runtime",
            "codex_thread",
            "codex_turn",
            "capability",
            "lease",
            "prompt",
        )
    )


def test_fleet_policy_forbids_launch_and_mutation():
    assert HOST_CONTRACT["fleet_policy"] == {
        "launch": False,
        "mutation": False,
        "first_canary": "read-only",
        "acceptance_owner": "QUINE",
    }


def test_dependency_graph_is_exact_parallel_and_acyclic():
    expected_conversation = (
        ("captured conversation corpus", "captured prior inputs"),
        ("captured prior inputs", "conversation contract"),
        ("conversation contract", "conversation presentation"),
        ("conversation contract", "conversation store"),
        ("conversation contract", "runtime adaptation"),
        ("runtime adaptation", "provider admission"),
        ("conversation presentation", "owner integration"),
        ("conversation store", "owner integration"),
        ("runtime adaptation", "owner integration"),
        ("owner integration", "admitted provider"),
        ("provider admission", "admitted provider"),
    )
    expected_enrollment = (
        ("package integrity", "runtime enrollment"),
        ("runtime enrollment", "read-only observation"),
        ("read-only observation", "exact control"),
        ("exact control", "launch and mutation mediation"),
    )
    expected_convergence = (
        ("conversation contract", "read-only observation"),
        ("read-only observation", "admitted provider"),
    )
    assert HOST_CONTRACT["conversation_edges"] == expected_conversation
    assert HOST_CONTRACT["enrollment_edges"] == expected_enrollment
    assert HOST_CONTRACT["convergence_edges"] == expected_convergence
    all_edges = expected_conversation + expected_enrollment + expected_convergence
    _assert_acyclic(all_edges)
    assert ("conversation store", "read-only observation") not in all_edges
    assert ("runtime adaptation", "read-only observation") not in all_edges
    assert ("read-only observation", "conversation contract") not in all_edges
