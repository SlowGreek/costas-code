//! Catalyst's tab set, read from the authored `catalyst/TABS.json`.
//!
//! Which apps appear as desktop tabs was hardcoded in three places — a React
//! contract, an Electron constant, and RUN's catalog. A tab is really just a
//! catalog app plus its shell affordances, so it is authored once here and
//! resolved against the shared app catalog.

use ugui_render::json::{self, Json};

pub const TABS_SCHEMA: &str = "catalyst-tabs/1";
/// The shell composes this tab itself; it is not a catalog app.
pub const HOST_SOURCE: &str = "host";

const TABS: &str = include_str!("../../TABS.json");

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Tab {
    pub id: String,
    pub source: String,
    pub app: String,
    pub label: String,
    pub mnemonic: String,
}

impl Tab {
    /// A tab RUN composes live, rather than one the engine paints from catalog.
    pub fn is_live(&self) -> bool {
        self.source == ugui_render::app_catalog::RUN
    }

    /// Whether the executive envelope carries a row for this tab. Catalog tabs
    /// are painted from static documents and never appear in the batch.
    pub fn in_batch(&self) -> bool {
        self.is_live() || self.source == HOST_SOURCE
    }

    pub fn to_json(&self) -> Json {
        json::obj(vec![
            ("id", json::s(&self.id)),
            ("source", json::s(&self.source)),
            ("app", json::s(&self.app)),
            ("label", json::s(&self.label)),
            ("mnemonic", json::s(&self.mnemonic)),
            ("live", Json::Bool(self.is_live())),
            ("batch", Json::Bool(self.in_batch())),
        ])
    }
}

/// The tabs the executive envelope must carry a row for, in authored order.
pub fn batch_tabs() -> Vec<Tab> {
    tabs().into_iter().filter(Tab::in_batch).collect()
}

pub fn tabs() -> Vec<Tab> {
    let catalog = json::parse(TABS).expect("catalyst tabs must parse");
    assert_eq!(catalog.get("schema").and_then(Json::as_str), Some(TABS_SCHEMA));
    catalog
        .get("tabs")
        .and_then(Json::as_array)
        .expect("catalyst tab rows")
        .iter()
        .map(|row| {
            let text = |key: &str| {
                row.get(key)
                    .and_then(Json::as_str)
                    .unwrap_or_else(|| panic!("tab {key}"))
                    .to_owned()
            };
            Tab {
                id: text("id"),
                source: text("source"),
                app: text("app"),
                label: text("label"),
                mnemonic: text("mnemonic"),
            }
        })
        .collect()
}

/// The static Document a non-live tab paints, straight from the shared catalog.
pub fn tab_document(tab: &Tab) -> Option<&'static str> {
    (!tab.is_live() && tab.source != HOST_SOURCE)
        .then(|| ugui_render::app_catalog::document_json(&tab.source, &tab.app))
        .flatten()
}

#[cfg(test)]
#[path = "../tests/unit/tabs.rs"]
mod tests;
