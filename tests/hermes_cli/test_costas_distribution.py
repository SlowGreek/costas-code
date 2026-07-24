"""Distribution provenance contract for the Costas Code fork."""

from pathlib import Path


from hermes_cli import banner
from hermes_cli import main
from hermes_cli.config import DEFAULT_CONFIG


REPO_ROOT = Path(__file__).resolve().parents[2]
COSTAS_REPO = "https://github.com/SlowGreek/costas-code.git"


def test_update_surfaces_track_the_costas_code_repository():
    assert banner._UPSTREAM_REPO_URL == COSTAS_REPO
    assert banner.UPDATE_BRANCH == "costas-code"
    assert main.OFFICIAL_REPO_URL == COSTAS_REPO
    assert COSTAS_REPO in main.OFFICIAL_REPO_URLS
    assert main.COSTAS_UPDATE_BRANCH == "costas-code"
    assert main._resolve_update_branch(type("Args", (), {"branch": None})()) == "costas-code"


def test_costas_code_steers_enter_during_an_active_turn_by_default():
    assert DEFAULT_CONFIG["display"]["busy_input_mode"] == "steer"


def test_cross_platform_installers_clone_the_costas_code_repository():
    install_sh = (REPO_ROOT / "scripts" / "install.sh").read_text(encoding="utf-8")
    install_ps1 = (REPO_ROOT / "scripts" / "install.ps1").read_text(encoding="utf-8")

    assert 'REPO_URL_HTTPS="https://github.com/SlowGreek/costas-code.git"' in install_sh
    assert 'REPO_URL_SSH="git@github.com:SlowGreek/costas-code.git"' in install_sh
    assert 'BRANCH="costas-code"' in install_sh
    assert 'git fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"' in install_sh
    assert 'git checkout -B "$BRANCH" "origin/$BRANCH"' in install_sh
    assert '$RepoUrlHttps = "https://github.com/SlowGreek/costas-code.git"' in install_ps1
    assert '$RepoUrlSsh = "git@github.com:SlowGreek/costas-code.git"' in install_ps1
    assert '[string]$Branch = "costas-code"' in install_ps1
    assert '$pinnedBranch = "costas-code"' in install_ps1
    assert 'fetch origin "+refs/heads/${Branch}:refs/remotes/origin/${Branch}"' in install_ps1
    assert 'checkout -B $Branch "origin/$Branch"' in install_ps1
