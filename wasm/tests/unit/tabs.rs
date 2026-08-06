use super::*;

#[test]
fn every_authored_tab_resolves_against_the_shared_catalog() {
    let tabs = tabs();

    assert!(!tabs.is_empty());
    for tab in &tabs {
        assert!(!tab.label.is_empty(), "{}", tab.id);
        assert_eq!(tab.mnemonic.len(), 1, "{}", tab.id);
        assert!(tab.label.contains(&format!("[{}]", tab.mnemonic)), "{}", tab.label);

        if tab.source == HOST_SOURCE {
            assert!(tab_document(tab).is_none(), "{}", tab.id);
            continue;
        }
        // Every non-host tab must name an app the catalog actually publishes.
        assert!(
            ugui_render::app_catalog::apps(&tab.source).iter().any(|app| app.id == tab.app),
            "{} names {}/{} which the catalog does not publish",
            tab.id,
            tab.source,
            tab.app
        );
    }
}

#[test]
fn tab_ids_and_mnemonics_are_unique() {
    let tabs = tabs();
    let mut ids = tabs.iter().map(|tab| tab.id.as_str()).collect::<Vec<_>>();
    let mut mnemonics = tabs.iter().map(|tab| tab.mnemonic.as_str()).collect::<Vec<_>>();

    ids.sort_unstable();
    mnemonics.sort_unstable();
    let unique_ids = ids.len();
    let unique_mnemonics = mnemonics.len();

    ids.dedup();
    mnemonics.dedup();
    assert_eq!(ids.len(), unique_ids, "duplicate tab id");
    assert_eq!(mnemonics.len(), unique_mnemonics, "duplicate hotkey");
}

#[test]
fn the_microsoft_keystone_paints_a_rich_document_no_run_tab_provides() {
    let tabs = tabs();
    let keystone = tabs.iter().find(|tab| tab.id == "microsoft").expect("microsoft tab");

    assert_eq!(keystone.source, "projects");
    assert!(!keystone.is_live(), "a catalog app is painted by the engine, not composed by RUN");

    let document = tab_document(keystone).expect("keystone document");
    let value = json::parse(document).expect("keystone parses");

    // The engine admits it, and it exercises vocabulary the RUN tabs never do.
    assert_eq!(ugui_render::validate_document_value(&value), "[]");
    for rich in ["\"image\"", "\"select\"", "\"input\"", "\"nested-card\"", "\"row\"", "\"column\""] {
        assert!(document.contains(rich), "keystone must exercise {rich}");
    }
}

#[test]
fn live_tabs_carry_no_static_document_and_catalog_tabs_do() {
    for tab in tabs() {
        assert_eq!(
            tab_document(&tab).is_some(),
            !tab.is_live() && tab.source != HOST_SOURCE,
            "{}",
            tab.id
        );
    }
}

#[test]
fn the_batch_covers_every_envelope_tab_and_excludes_catalog_tabs() {
    let batch = batch_tabs();

    // The executive envelope carries one row per batch tab, in authored order.
    assert_eq!(batch.len(), 13, "{:?}", batch.iter().map(|tab| &tab.id).collect::<Vec<_>>());
    assert!(batch.iter().all(Tab::in_batch));
    assert!(!batch.iter().any(|tab| tab.id == "microsoft"), "a catalog tab is not in the batch");
    assert!(tabs().len() > batch.len(), "the shell shows more tabs than the envelope carries");
}
