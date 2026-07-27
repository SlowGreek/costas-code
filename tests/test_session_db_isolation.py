"""The session DB must follow HERMES_HOME, not freeze it at import.

Reported symptom: sessions titled "do a tool-heavy task" — a pytest fixture
string — appearing in the user's real session picker.

Cause: ``DEFAULT_DB_PATH`` was a module-level constant evaluated when
``hermes_state`` was first imported. pytest's autouse isolation fixture
redirects ``HERMES_HOME`` to a per-test tempdir, but that runs *after* import,
so any ``SessionDB()`` constructed without an explicit path kept writing to the
developer's real ``~/.hermes/state.db``.

The bug class is worth pinning rather than the one symptom: the same freeze
breaks a profile switch mid-process, and it fails silently — nothing errors, the
rows just land in the wrong database.
"""

import importlib
import os
from pathlib import Path


class TestDefaultDbPathTracksHermesHome:
    def test_resolves_against_the_current_hermes_home(self, tmp_path, monkeypatch):
        import hermes_state

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))

        assert hermes_state.default_db_path() == tmp_path / "state.db"

    def test_a_later_change_is_picked_up(self, tmp_path, monkeypatch):
        """The whole point: resolution happens per call, not once."""
        import hermes_state

        first = tmp_path / "one"
        second = tmp_path / "two"
        first.mkdir()
        second.mkdir()

        monkeypatch.setenv("HERMES_HOME", str(first))
        assert hermes_state.default_db_path() == first / "state.db"

        monkeypatch.setenv("HERMES_HOME", str(second))
        assert hermes_state.default_db_path() == second / "state.db"

    def test_survives_a_module_reload(self, tmp_path, monkeypatch):
        """Import order must not decide where data lands."""
        import hermes_state

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        reloaded = importlib.reload(hermes_state)

        assert reloaded.default_db_path() == tmp_path / "state.db"


class TestSessionDbHonoursIsolation:
    def test_no_explicit_path_uses_the_isolated_home(self, tmp_path, monkeypatch):
        """``SessionDB()`` is the exact call that leaked fixture sessions."""
        import hermes_state

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        db = hermes_state.SessionDB()

        assert db.db_path == tmp_path / "state.db"
        # The real home must not be touched at all.
        assert Path.home() / ".hermes" / "state.db" != db.db_path

    def test_an_explicit_path_still_wins(self, tmp_path, monkeypatch):
        import hermes_state

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        explicit = tmp_path / "custom.db"
        db = hermes_state.SessionDB(db_path=explicit)

        assert db.db_path == explicit

    def test_writes_land_in_the_isolated_db(self, tmp_path, monkeypatch):
        """End-to-end: create a session and prove it exists ONLY in the
        tempdir. Asserting on the path alone would miss a second code path
        that resolves its own location."""
        import hermes_state

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        db = hermes_state.SessionDB()
        db.create_session("20260101_000000_isolated", source="test")

        assert (tmp_path / "state.db").exists()
        assert db.get_session("20260101_000000_isolated") is not None

    def test_the_autouse_fixture_actually_isolates(self):
        """Guards the fixture itself.

        Every test in this suite runs under conftest's autouse isolation. If
        that ever stops redirecting HERMES_HOME, a bare SessionDB() silently
        starts writing to the developer's real database again — which is
        precisely how the fixture sessions escaped.
        """
        import hermes_state

        resolved = hermes_state.default_db_path()
        real = Path(os.path.expanduser("~/.hermes/state.db"))

        assert resolved != real, "HERMES_HOME is not isolated under pytest"
