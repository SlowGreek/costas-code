"""`skin.list` — the catalog RPC GUI surfaces build a theme picker from.

`gateway.ready` / `skin.changed` only ever announce the ACTIVE skin, so this is
the only way the desktop learns the rest of the skins exist.
"""

import pytest

from tui_gateway.server import _methods


@pytest.fixture
def skin_list():
    return lambda: _methods["skin.list"]("rid", {})["skins"]


class TestSkinListRpc:
    def test_returns_every_skin_the_engine_lists(self, skin_list):
        from hermes_cli.skin_engine import list_skins

        expected = {entry["name"] for entry in list_skins()}
        assert {s["name"] for s in skin_list()} == expected

    def test_entries_carry_the_resolve_skin_payload_shape(self, skin_list):
        """A GUI converts these with the same code path as the active skin, so
        every entry must match `resolve_skin()`'s keys or conversion breaks."""
        from tui_gateway.server import resolve_skin

        active_keys = set(resolve_skin())
        assert active_keys, "resolve_skin() returned nothing to compare against"

        for entry in skin_list():
            # `source` is the one field only the catalog carries.
            assert active_keys <= set(entry)
            assert entry["source"] in {"builtin", "bundled", "user"}

    def test_every_entry_resolves_a_palette(self, skin_list):
        for entry in skin_list():
            assert entry["colors"], f"{entry['name']} resolved with no colors"

    def test_includes_the_bundled_pack(self, skin_list):
        from hermes_cli.skin_engine import _bundled_skins_dir

        bundled = {p.stem for p in _bundled_skins_dir().glob("*.yaml")}
        assert bundled, "expected a bundled skin pack to ship"
        assert bundled <= {s["name"] for s in skin_list()}
