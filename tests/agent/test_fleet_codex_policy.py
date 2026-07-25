from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import cast

import pytest

from agent.fleet_codex_policy import (
    ApprovalDecision,
    CanonicalReadRoot,
    ConfigSource,
    DeterministicApprovalPolicy,
    EnvironmentVariable,
    ExactMutationUnavailable,
    ExactRuntime,
    FilesystemPolicy,
    FleetCodexPlan,
    FleetCodexPolicyError,
    GeneratedConfigIdentity,
    MutationAvailability,
    NetworkPolicy,
    PrivateCodexHome,
    ProviderCredentialReference,
    SandboxMode,
    StrictEnvironment,
    TeardownObligations,
)

_CONFIG_DIGEST = "a" * 64


def _plan(tmp_path: Path, **overrides: object) -> FleetCodexPlan:
    read_root = tmp_path / "fixture"
    read_root.mkdir(exist_ok=True)
    codex_home = tmp_path / "fleet-codex-home"
    values: dict[str, object] = {
        "codex_home": PrivateCodexHome(path=str(codex_home)),
        "config": GeneratedConfigIdentity(
            generation="run-7", sha256=_CONFIG_DIGEST
        ),
        "runtime": ExactRuntime(
            runtime="codex_app_server",
            model="gpt-5.6-codex",
            provider_credential=ProviderCredentialReference(
                provider="openai-codex", reference="fleet-read-provider"
            ),
        ),
        "environment": StrictEnvironment(
            variables=(
                EnvironmentVariable(name="CODEX_HOME", value=str(codex_home)),
                EnvironmentVariable(name="RUST_LOG", value="warn"),
            )
        ),
        "filesystem": FilesystemPolicy(
            read_roots=(CanonicalReadRoot(path=str(read_root)),)
        ),
        "network": NetworkPolicy(),
        "approvals": DeterministicApprovalPolicy(),
        "teardown": TeardownObligations(),
        "exact_mutation": ExactMutationUnavailable(),
    }
    values.update(overrides)
    return FleetCodexPlan(**values)  # type: ignore[arg-type]


def test_valid_plan_is_closed_read_only_and_receipt_is_content_free(tmp_path: Path):
    plan = _plan(tmp_path)

    assert plan.codex_home.mode == 0o700
    assert plan.codex_home.create_exclusive is True
    assert plan.codex_home.inherit_home is False
    assert plan.config.source is ConfigSource.GENERATED
    assert plan.config.plugins == ()
    assert plan.config.mcp_servers == ()
    assert plan.runtime.runtime == "codex_app_server"
    assert plan.runtime.model == "gpt-5.6-codex"
    assert {entry.name for entry in plan.environment.variables} == {
        "CODEX_HOME",
        "RUST_LOG",
    }
    assert plan.filesystem.sandbox_mode is SandboxMode.READ_ONLY
    assert plan.filesystem.write_roots == ()
    assert plan.network.allow_network is False
    assert plan.exact_mutation.availability is MutationAvailability.UNAVAILABLE

    receipt = plan.receipt()
    wire = asdict(receipt)
    assert wire == {
        "policy_version": "fleet-codex-read-only/v1",
        "policy_sha256": receipt.policy_sha256,
        "generated_config_sha256": _CONFIG_DIGEST,
        "read_root_count": 1,
        "write_root_count": 0,
        "network_allowed": False,
        "exact_mutation": MutationAvailability.UNAVAILABLE,
        "policy_only": True,
        "os_sandbox_proven": False,
    }
    assert len(receipt.policy_sha256) == 64
    serialized = repr(wire)
    assert str(tmp_path) not in serialized
    assert plan.runtime.model not in serialized
    assert plan.runtime.provider_credential.reference not in serialized
    assert "CODEX_HOME" not in serialized


def test_receipt_is_deterministic_for_same_plan(tmp_path: Path):
    plan = _plan(tmp_path)
    assert plan.receipt() == plan.receipt()


@pytest.mark.parametrize("mode", [0o755, 0o750, 0o7000])
def test_private_home_requires_exact_0700(tmp_path: Path, mode: int):
    with pytest.raises(FleetCodexPolicyError, match="exactly 0700"):
        PrivateCodexHome(path=str(tmp_path / "codex"), mode=mode)


def test_private_home_rejects_home_inheritance_and_preexisting_path(tmp_path: Path):
    with pytest.raises(FleetCodexPolicyError, match="HOME inheritance"):
        PrivateCodexHome(path=str(tmp_path / "codex"), inherit_home=True)

    existing = tmp_path / "existing"
    existing.mkdir()
    with pytest.raises(FleetCodexPolicyError, match="must not pre-exist"):
        PrivateCodexHome(path=str(existing))


def test_generated_config_rejects_inheritance_plugins_and_mcp():
    with pytest.raises(FleetCodexPolicyError, match="inheritance"):
        GeneratedConfigIdentity(
            generation="run-7",
            sha256=_CONFIG_DIGEST,
            inherit_user_config=True,
        )
    with pytest.raises(FleetCodexPolicyError, match="plugins"):
        GeneratedConfigIdentity(
            generation="run-7", sha256=_CONFIG_DIGEST, plugins=("github",)
        )
    with pytest.raises(FleetCodexPolicyError, match="MCP"):
        GeneratedConfigIdentity(
            generation="run-7", sha256=_CONFIG_DIGEST, mcp_servers=("tools",)
        )


@pytest.mark.parametrize("model", ["", "auto", "default", "latest", "gpt-*"])
def test_runtime_rejects_non_exact_model(model: str):
    with pytest.raises(FleetCodexPolicyError, match="model"):
        ExactRuntime(
            runtime="codex_app_server",
            model=model,
            provider_credential=ProviderCredentialReference(
                provider="openai-codex", reference="fleet-provider"
            ),
        )


def test_runtime_rejects_wrong_runtime_and_fallback():
    credential = ProviderCredentialReference(
        provider="openai-codex", reference="fleet-provider"
    )
    with pytest.raises(FleetCodexPolicyError, match="runtime must be exactly"):
        ExactRuntime(
            runtime="codex_responses",
            model="gpt-5.6-codex",
            provider_credential=credential,
        )
    with pytest.raises(FleetCodexPolicyError, match="fallback"):
        ExactRuntime(
            runtime="codex_app_server",
            model="gpt-5.6-codex",
            provider_credential=credential,
            allow_fallback=True,
        )


@pytest.mark.parametrize(
    "reference",
    ["token=abc", "key=abc", "secret=abc", "bearer abc", "sk-secret"],
)
def test_credentials_accept_only_named_provider_reference(reference: str):
    with pytest.raises(FleetCodexPolicyError, match="not credential material"):
        ProviderCredentialReference(provider="openai", reference=reference)


def test_environment_is_strict_allowlist_without_home_or_unknowns(tmp_path: Path):
    home = str(tmp_path / "codex")
    with pytest.raises(FleetCodexPolicyError, match="HOME.*not allowlisted"):
        EnvironmentVariable(name="HOME", value=str(tmp_path))
    with pytest.raises(FleetCodexPolicyError, match="not allowlisted"):
        EnvironmentVariable(name="OPENAI_API_KEY", value="secret")
    with pytest.raises(FleetCodexPolicyError, match="inheritance"):
        StrictEnvironment(
            variables=(EnvironmentVariable(name="CODEX_HOME", value=home),),
            inherit_parent=True,
        )
    with pytest.raises(FleetCodexPolicyError, match="unique"):
        StrictEnvironment(
            variables=(
                EnvironmentVariable(name="CODEX_HOME", value=home),
                EnvironmentVariable(name="CODEX_HOME", value=home),
            )
        )
    with pytest.raises(FleetCodexPolicyError, match="tuple"):
        StrictEnvironment(
            variables=cast(
                tuple[EnvironmentVariable, ...],
                [EnvironmentVariable(name="CODEX_HOME", value=home)],
            )
        )


def test_plan_rejects_mismatched_codex_home_environment(tmp_path: Path):
    with pytest.raises(FleetCodexPolicyError, match="must equal"):
        _plan(
            tmp_path,
            environment=StrictEnvironment(
                variables=(
                    EnvironmentVariable(
                        name="CODEX_HOME", value=str(tmp_path / "other-home")
                    ),
                )
            ),
        )


def test_paths_reject_relative_traversal_noncanonical_and_symlink(tmp_path: Path):
    read_root = tmp_path / "read"
    read_root.mkdir()

    with pytest.raises(FleetCodexPolicyError, match="must be absolute"):
        CanonicalReadRoot(path="relative")
    with pytest.raises(FleetCodexPolicyError, match="traversal"):
        CanonicalReadRoot(path=f"{read_root}/../read")
    with pytest.raises(FleetCodexPolicyError, match="canonical spelling"):
        CanonicalReadRoot(path=f"{tmp_path}//read")

    symlink = tmp_path / "linked"
    try:
        symlink.symlink_to(read_root, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are unavailable on this platform")
    with pytest.raises(FleetCodexPolicyError, match="symlinks"):
        CanonicalReadRoot(path=str(symlink))
    with pytest.raises(FleetCodexPolicyError, match="symlinks"):
        PrivateCodexHome(path=str(symlink / "new-home"))


def test_filesystem_rejects_writable_or_missing_roots(tmp_path: Path):
    root = tmp_path / "read"
    root.mkdir()
    with pytest.raises(FleetCodexPolicyError, match="zero write roots"):
        FilesystemPolicy(
            read_roots=(CanonicalReadRoot(path=str(root)),),
            write_roots=(str(tmp_path / "write"),),
        )
    with pytest.raises(FleetCodexPolicyError, match="existing directory"):
        CanonicalReadRoot(path=str(tmp_path / "missing"))
    with pytest.raises(FleetCodexPolicyError, match="zero write roots"):
        FilesystemPolicy(
            read_roots=(CanonicalReadRoot(path=str(root)),),
            write_roots=cast(tuple[str, ...], []),
        )


def test_network_plugins_mcp_and_approval_bypass_fail_closed():
    with pytest.raises(FleetCodexPolicyError, match="network"):
        NetworkPolicy(allow_network=True)
    with pytest.raises(FleetCodexPolicyError, match="bypass"):
        DeterministicApprovalPolicy(allow_bypass=True)
    with pytest.raises(FleetCodexPolicyError, match="interactive"):
        DeterministicApprovalPolicy(interactive=True)
    with pytest.raises(FleetCodexPolicyError, match="must decline"):
        DeterministicApprovalPolicy(
            command_execution=ApprovalDecision.DECLINE,
            file_change=ApprovalDecision.DECLINE,
            permission_escalation=ApprovalDecision.DECLINE,
            mcp_elicitation=ApprovalDecision.DECLINE,
            unknown_request="accept",  # type: ignore[arg-type]
        )


def test_teardown_obligations_cannot_be_weakened():
    for field_name in (
        "interrupt_active_turn",
        "terminate_process_tree",
        "reap_all_descendants",
        "require_terminal_proof",
        "remove_private_home",
        "outcome_unknown_on_unproven_terminal",
    ):
        with pytest.raises(FleetCodexPolicyError, match="mandatory"):
            TeardownObligations(**{field_name: False})  # type: ignore[arg-type]
    with pytest.raises(FleetCodexPolicyError, match="mandatory"):
        TeardownObligations(terminate_process_tree=1)  # type: ignore[arg-type]


def test_exact_mutation_is_typed_unavailable_with_no_operations():
    unavailable = ExactMutationUnavailable()
    assert unavailable.availability is MutationAvailability.UNAVAILABLE
    assert unavailable.operations == ()

    with pytest.raises(FleetCodexPolicyError, match="no operations"):
        ExactMutationUnavailable(operations=("create",))
