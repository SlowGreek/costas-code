"""Pure policy contract for a read-only Fleet Codex profile.

This module describes and validates a launch *plan*.  It does not create files,
start Codex, mediate syscalls, or prove that teardown happened.  A future
runtime owner must enforce every obligation below and provide independent OS
sandbox/process-tree evidence before using the plan for Fleet execution.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass, fields
from enum import Enum
from pathlib import Path
from typing import Final

POLICY_VERSION: Final[str] = "fleet-codex-read-only/v1"
_PRIVATE_DIRECTORY_MODE: Final[int] = 0o700
_ALLOWED_ENVIRONMENT: Final[frozenset[str]] = frozenset(
    {"CODEX_HOME", "RUST_LOG"}
)
_EXACT_RUNTIME: Final[str] = "codex_app_server"
_DIGEST_RE: Final[re.Pattern[str]] = re.compile(r"[0-9a-f]{64}")
_NAME_RE: Final[re.Pattern[str]] = re.compile(r"[a-z0-9][a-z0-9._-]{0,127}")


class FleetCodexPolicyError(ValueError):
    """A Fleet Codex plan is not closed or violates the read-only policy."""


class ConfigSource(str, Enum):
    GENERATED = "generated"


class SandboxMode(str, Enum):
    READ_ONLY = "read-only"


class ApprovalDecision(str, Enum):
    DECLINE = "decline"


class MutationAvailability(str, Enum):
    UNAVAILABLE = "unavailable"


class MutationUnavailableReason(str, Enum):
    BELOW_SHELL_MEDIATION_NOT_PROVEN = "below_shell_mediation_not_proven"


@dataclass(frozen=True, slots=True, kw_only=True)
class PrivateCodexHome:
    """Exclusive private CODEX_HOME provisioning and cleanup obligations."""

    path: str
    mode: int = _PRIVATE_DIRECTORY_MODE
    create_exclusive: bool = True
    inherit_home: bool = False
    remove_on_teardown: bool = True

    def __post_init__(self) -> None:
        _validate_planned_private_path(self.path, label="CODEX_HOME")
        if type(self.mode) is not int or self.mode != _PRIVATE_DIRECTORY_MODE:
            raise FleetCodexPolicyError("CODEX_HOME mode must be exactly 0700")
        if self.create_exclusive is not True:
            raise FleetCodexPolicyError("CODEX_HOME must be created exclusively")
        if self.inherit_home is not False:
            raise FleetCodexPolicyError("HOME inheritance is forbidden")
        if self.remove_on_teardown is not True:
            raise FleetCodexPolicyError("CODEX_HOME removal is a teardown obligation")


@dataclass(frozen=True, slots=True, kw_only=True)
class GeneratedConfigIdentity:
    """Identity of config bytes generated specifically for this plan."""

    generation: str
    sha256: str
    source: ConfigSource = ConfigSource.GENERATED
    inherit_user_config: bool = False
    plugins: tuple[str, ...] = ()
    mcp_servers: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _validate_name(self.generation, label="config generation")
        if not _DIGEST_RE.fullmatch(self.sha256):
            raise FleetCodexPolicyError(
                "generated config sha256 must be 64 lowercase hexadecimal characters"
            )
        if self.source is not ConfigSource.GENERATED:
            raise FleetCodexPolicyError("Codex config must be generated, not inherited")
        if self.inherit_user_config is not False:
            raise FleetCodexPolicyError("Codex config inheritance is forbidden")
        if type(self.plugins) is not tuple or self.plugins:
            raise FleetCodexPolicyError("Codex plugins are forbidden")
        if type(self.mcp_servers) is not tuple or self.mcp_servers:
            raise FleetCodexPolicyError("Codex MCP servers are forbidden")


@dataclass(frozen=True, slots=True, kw_only=True)
class ProviderCredentialReference:
    """A provider-owned credential *name*, never credential material."""

    provider: str
    reference: str

    def __post_init__(self) -> None:
        _validate_name(self.provider, label="provider")
        if not isinstance(self.reference, str):
            raise FleetCodexPolicyError(
                "provider credential reference must be a closed lowercase name"
            )
        lowered = self.reference.lower()
        if any(
            marker in lowered
            for marker in ("token=", "key=", "secret=", "bearer ")
        ) or lowered.startswith(("sk-", "ghp_", "github_pat_")):
            raise FleetCodexPolicyError(
                "provider credential reference must be a name, not credential material"
            )
        _validate_name(self.reference, label="provider credential reference")


@dataclass(frozen=True, slots=True, kw_only=True)
class ExactRuntime:
    """Exact provider runtime and model selection; no automatic fallback."""

    runtime: str
    model: str
    provider_credential: ProviderCredentialReference
    allow_fallback: bool = False

    def __post_init__(self) -> None:
        if self.runtime != _EXACT_RUNTIME:
            raise FleetCodexPolicyError(
                f"runtime must be exactly {_EXACT_RUNTIME!r}"
            )
        model = self.model.strip()
        if not model or model != self.model:
            raise FleetCodexPolicyError("model must be a non-empty exact identifier")
        if any(character.isspace() or ord(character) < 32 for character in model):
            raise FleetCodexPolicyError("model must be a non-empty exact identifier")
        lowered = model.lower()
        if lowered in {"auto", "default", "latest"} or "*" in model:
            raise FleetCodexPolicyError("model aliases and wildcards are forbidden")
        if type(self.provider_credential) is not ProviderCredentialReference:
            raise FleetCodexPolicyError("provider credential must be a named reference")
        if self.allow_fallback is not False:
            raise FleetCodexPolicyError("runtime/model fallback is forbidden")


@dataclass(frozen=True, slots=True, kw_only=True)
class EnvironmentVariable:
    name: str
    value: str

    def __post_init__(self) -> None:
        if self.name not in _ALLOWED_ENVIRONMENT:
            raise FleetCodexPolicyError(
                f"environment variable {self.name!r} is not allowlisted"
            )
        if not isinstance(self.value, str) or not self.value or "\x00" in self.value:
            raise FleetCodexPolicyError(
                f"environment variable {self.name!r} has an invalid value"
            )
        if self.name == "RUST_LOG" and self.value != "warn":
            raise FleetCodexPolicyError("RUST_LOG must be exactly 'warn'")


@dataclass(frozen=True, slots=True, kw_only=True)
class StrictEnvironment:
    """Complete child environment, built from nothing rather than inheritance."""

    variables: tuple[EnvironmentVariable, ...]
    inherit_parent: bool = False

    def __post_init__(self) -> None:
        if self.inherit_parent is not False:
            raise FleetCodexPolicyError("parent environment inheritance is forbidden")
        if type(self.variables) is not tuple or not all(
            type(variable) is EnvironmentVariable for variable in self.variables
        ):
            raise FleetCodexPolicyError(
                "environment must be a tuple of validated variables"
            )
        names = tuple(variable.name for variable in self.variables)
        if len(names) != len(set(names)):
            raise FleetCodexPolicyError("environment variables must be unique")
        if set(names) - _ALLOWED_ENVIRONMENT:
            raise FleetCodexPolicyError("environment contains unknown variables")
        if "CODEX_HOME" not in names:
            raise FleetCodexPolicyError("environment must contain CODEX_HOME")

    def value_for(self, name: str) -> str | None:
        for variable in self.variables:
            if variable.name == name:
                return variable.value
        return None


@dataclass(frozen=True, slots=True, kw_only=True)
class CanonicalReadRoot:
    """An existing, absolute, symlink-free directory admitted for reads only."""

    path: str
    mode: SandboxMode = SandboxMode.READ_ONLY

    def __post_init__(self) -> None:
        _validate_existing_canonical_directory(self.path, label="read root")
        if self.mode is not SandboxMode.READ_ONLY:
            raise FleetCodexPolicyError("read roots cannot be writable")


@dataclass(frozen=True, slots=True, kw_only=True)
class FilesystemPolicy:
    read_roots: tuple[CanonicalReadRoot, ...]
    write_roots: tuple[str, ...] = ()
    sandbox_mode: SandboxMode = SandboxMode.READ_ONLY

    def __post_init__(self) -> None:
        if type(self.read_roots) is not tuple or not self.read_roots:
            raise FleetCodexPolicyError("at least one canonical read root is required")
        if not all(type(root) is CanonicalReadRoot for root in self.read_roots):
            raise FleetCodexPolicyError("read roots must be validated canonical roots")
        paths = tuple(root.path for root in self.read_roots)
        if len(paths) != len(set(paths)):
            raise FleetCodexPolicyError("read roots must be unique")
        if type(self.write_roots) is not tuple or self.write_roots:
            raise FleetCodexPolicyError("Fleet read-only policy has zero write roots")
        if self.sandbox_mode is not SandboxMode.READ_ONLY:
            raise FleetCodexPolicyError("sandbox mode must be read-only")


@dataclass(frozen=True, slots=True, kw_only=True)
class NetworkPolicy:
    allow_network: bool = False

    def __post_init__(self) -> None:
        if self.allow_network is not False:
            raise FleetCodexPolicyError("network access is forbidden")


@dataclass(frozen=True, slots=True, kw_only=True)
class DeterministicApprovalPolicy:
    """Noninteractive table: every authority-escalating request is declined."""

    command_execution: ApprovalDecision = ApprovalDecision.DECLINE
    file_change: ApprovalDecision = ApprovalDecision.DECLINE
    permission_escalation: ApprovalDecision = ApprovalDecision.DECLINE
    mcp_elicitation: ApprovalDecision = ApprovalDecision.DECLINE
    unknown_request: ApprovalDecision = ApprovalDecision.DECLINE
    interactive: bool = False
    allow_bypass: bool = False

    def __post_init__(self) -> None:
        for field in fields(self):
            if field.name in {"interactive", "allow_bypass"}:
                continue
            if getattr(self, field.name) is not ApprovalDecision.DECLINE:
                raise FleetCodexPolicyError(
                    "all Fleet read-only approval decisions must decline"
                )
        if self.interactive is not False:
            raise FleetCodexPolicyError("interactive approvals are nondeterministic")
        if self.allow_bypass is not False:
            raise FleetCodexPolicyError("approval bypass is forbidden")


@dataclass(frozen=True, slots=True, kw_only=True)
class TeardownObligations:
    """Requirements for the future executor; none are proven by this module."""

    interrupt_active_turn: bool = True
    terminate_process_tree: bool = True
    reap_all_descendants: bool = True
    require_terminal_proof: bool = True
    remove_private_home: bool = True
    outcome_unknown_on_unproven_terminal: bool = True

    def __post_init__(self) -> None:
        if not all(getattr(self, field.name) is True for field in fields(self)):
            raise FleetCodexPolicyError("all teardown obligations are mandatory")


@dataclass(frozen=True, slots=True, kw_only=True)
class ExactMutationUnavailable:
    """Typed statement that this profile grants no mutation capability."""

    availability: MutationAvailability = MutationAvailability.UNAVAILABLE
    reason: MutationUnavailableReason = (
        MutationUnavailableReason.BELOW_SHELL_MEDIATION_NOT_PROVEN
    )
    operations: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.availability is not MutationAvailability.UNAVAILABLE:
            raise FleetCodexPolicyError("exact mutation must remain unavailable")
        if self.reason is not MutationUnavailableReason.BELOW_SHELL_MEDIATION_NOT_PROVEN:
            raise FleetCodexPolicyError("exact mutation has an unknown refusal reason")
        if type(self.operations) is not tuple or self.operations:
            raise FleetCodexPolicyError("unavailable exact mutation has no operations")


@dataclass(frozen=True, slots=True, kw_only=True)
class FleetCodexPlan:
    codex_home: PrivateCodexHome
    config: GeneratedConfigIdentity
    runtime: ExactRuntime
    environment: StrictEnvironment
    filesystem: FilesystemPolicy
    network: NetworkPolicy
    approvals: DeterministicApprovalPolicy
    teardown: TeardownObligations
    exact_mutation: ExactMutationUnavailable
    policy_version: str = POLICY_VERSION

    def __post_init__(self) -> None:
        if self.policy_version != POLICY_VERSION:
            raise FleetCodexPolicyError("unknown Fleet Codex policy version")
        expected_types = {
            "codex_home": PrivateCodexHome,
            "config": GeneratedConfigIdentity,
            "runtime": ExactRuntime,
            "environment": StrictEnvironment,
            "filesystem": FilesystemPolicy,
            "network": NetworkPolicy,
            "approvals": DeterministicApprovalPolicy,
            "teardown": TeardownObligations,
            "exact_mutation": ExactMutationUnavailable,
        }
        for name, expected_type in expected_types.items():
            if type(getattr(self, name)) is not expected_type:
                raise FleetCodexPolicyError(
                    f"{name} must be a validated {expected_type.__name__}"
                )
        if self.environment.value_for("CODEX_HOME") != self.codex_home.path:
            raise FleetCodexPolicyError(
                "environment CODEX_HOME must equal the private home path"
            )

    def receipt(self) -> FleetCodexPolicyReceipt:
        """Return content-free control evidence for this validated plan."""
        canonical = {
            "policy_version": self.policy_version,
            "home_mode": self.codex_home.mode,
            "config_generation": self.config.generation,
            "config_sha256": self.config.sha256,
            "runtime": self.runtime.runtime,
            "model": self.runtime.model,
            "provider": self.runtime.provider_credential.provider,
            "credential_reference": self.runtime.provider_credential.reference,
            "environment_names": sorted(
                variable.name for variable in self.environment.variables
            ),
            "read_roots": sorted(root.path for root in self.filesystem.read_roots),
            "network": self.network.allow_network,
            "approval_decisions": [
                self.approvals.command_execution.value,
                self.approvals.file_change.value,
                self.approvals.permission_escalation.value,
                self.approvals.mcp_elicitation.value,
                self.approvals.unknown_request.value,
            ],
            "mutation": self.exact_mutation.availability.value,
        }
        policy_digest = hashlib.sha256(
            json.dumps(
                canonical, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
        ).hexdigest()
        return FleetCodexPolicyReceipt(
            policy_version=self.policy_version,
            policy_sha256=policy_digest,
            generated_config_sha256=self.config.sha256,
            read_root_count=len(self.filesystem.read_roots),
            write_root_count=0,
            network_allowed=False,
            exact_mutation=self.exact_mutation.availability,
            policy_only=True,
            os_sandbox_proven=False,
        )


@dataclass(frozen=True, slots=True, kw_only=True)
class FleetCodexPolicyReceipt:
    """Content-free receipt; contains no paths, env values, model, or credential name."""

    policy_version: str
    policy_sha256: str
    generated_config_sha256: str
    read_root_count: int
    write_root_count: int
    network_allowed: bool
    exact_mutation: MutationAvailability
    policy_only: bool
    os_sandbox_proven: bool



def _validate_name(value: str, *, label: str) -> None:
    if not isinstance(value, str) or not _NAME_RE.fullmatch(value):
        raise FleetCodexPolicyError(f"{label} must be a closed lowercase name")



def _validate_lexical_path(path: str, *, label: str) -> Path:
    if not isinstance(path, str) or not path or "\x00" in path:
        raise FleetCodexPolicyError(f"{label} must be a non-empty path")
    candidate = Path(path)
    if not candidate.is_absolute():
        raise FleetCodexPolicyError(f"{label} must be absolute")
    # Check the supplied spelling, not Path.parts (which normalizes '.' away).
    components = path.replace("\\", "/").split("/")
    if any(component in {".", ".."} for component in components):
        raise FleetCodexPolicyError(f"{label} cannot contain traversal")
    if os.path.normpath(path) != path:
        raise FleetCodexPolicyError(f"{label} must use canonical spelling")
    return candidate



def _reject_symlink_components(path: Path, *, label: str) -> None:
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            metadata = os.lstat(current)
        except FileNotFoundError:
            return
        if stat.S_ISLNK(metadata.st_mode):
            raise FleetCodexPolicyError(f"{label} cannot contain symlinks")



def _validate_planned_private_path(path: str, *, label: str) -> None:
    candidate = _validate_lexical_path(path, label=label)
    _reject_symlink_components(candidate, label=label)
    if candidate.exists():
        raise FleetCodexPolicyError(
            f"{label} must not pre-exist; exclusive 0700 creation is required"
        )
    parent = candidate.parent
    if not parent.is_dir():
        raise FleetCodexPolicyError(f"{label} parent must already exist")
    if str(parent.resolve(strict=True)) != str(parent):
        raise FleetCodexPolicyError(f"{label} parent must be canonical")



def _validate_existing_canonical_directory(path: str, *, label: str) -> None:
    candidate = _validate_lexical_path(path, label=label)
    _reject_symlink_components(candidate, label=label)
    if not candidate.is_dir():
        raise FleetCodexPolicyError(f"{label} must be an existing directory")
    if str(candidate.resolve(strict=True)) != path:
        raise FleetCodexPolicyError(f"{label} must be canonical")


__all__ = [
    "ApprovalDecision",
    "CanonicalReadRoot",
    "ConfigSource",
    "DeterministicApprovalPolicy",
    "EnvironmentVariable",
    "ExactMutationUnavailable",
    "ExactRuntime",
    "FilesystemPolicy",
    "FleetCodexPlan",
    "FleetCodexPolicyError",
    "FleetCodexPolicyReceipt",
    "GeneratedConfigIdentity",
    "MutationAvailability",
    "MutationUnavailableReason",
    "NetworkPolicy",
    "POLICY_VERSION",
    "PrivateCodexHome",
    "ProviderCredentialReference",
    "SandboxMode",
    "StrictEnvironment",
    "TeardownObligations",
]
