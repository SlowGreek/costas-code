//! Catalyst's UGUI client.
//!
//! Catalyst owns no painting vocabulary. Every canonical Document item is
//! rendered by the same `ugui::native_webview` engine `projects/` proved out,
//! so the desktop shell reinvents no concept-space and inherits every primitive
//! UGUI adds.

pub mod controller;
pub mod executive;
pub mod intent;
pub mod shell_viewport;
pub mod tabs;

use std::cell::RefCell;
use ugui_render::json::{self, Json};
use wasm_bindgen::prelude::*;

thread_local! {
    static CONTROLLER: RefCell<Option<controller::Controller>> = const { RefCell::new(None) };
}

fn refusal(code: &str, detail: &str) -> String {
    json::canonical_string(&json::obj(vec![
        ("schema", json::s("catalyst-ugui-refusal/1")),
        ("error", json::s(code)),
        ("detail", json::s(detail)),
    ]))
}

fn with_controller<R>(act: impl FnOnce(&mut controller::Controller) -> R) -> Option<R> {
    CONTROLLER.with(|cell| cell.borrow_mut().as_mut().map(act))
}

fn not_ready() -> String {
    refusal("E_CATALYST_CONTROLLER_NOT_READY", "call catalyst_controller_init first")
}

/// Seat the controller with the tab set this shell projects.
#[wasm_bindgen]
pub fn catalyst_controller_init(tabs_json: &str) -> String {
    let tabs = json::parse(tabs_json)
        .and_then(|value| value.as_array().map(<[Json]>::to_vec))
        .map(|tabs| {
            tabs.iter().filter_map(Json::as_str).map(str::to_owned).collect::<Vec<String>>()
        })
        .unwrap_or_default();
    if tabs.is_empty() {
        return refusal("E_CATALYST_EXECUTIVE_TAB", "tab set is empty");
    }
    let selected = tabs[0].clone();
    CONTROLLER.with(|cell| *cell.borrow_mut() = Some(controller::Controller::new(tabs)));
    json::canonical_string(&json::obj(vec![
        ("schema", json::s("catalyst-controller-init/1")),
        ("tab", json::s(&selected)),
    ]))
}

/// Admit and reconcile one executive envelope; returns typed effects.
#[wasm_bindgen]
pub fn catalyst_controller_observe(envelope_json: &str) -> String {
    with_controller(|controller| json::canonical_string(&controller.observe(envelope_json)))
        .unwrap_or_else(not_ready)
}

#[wasm_bindgen]
pub fn catalyst_controller_select_tab(tab: &str) -> String {
    with_controller(|controller| json::canonical_string(&controller.select(tab)))
        .unwrap_or_else(not_ready)
}

/// Turn one gesture into typed effects. The host enacts; it does not decide.
#[wasm_bindgen]
pub fn catalyst_controller_dispatch_action(action: &str, operation_id: &str) -> String {
    with_controller(|controller| {
        json::canonical_string(&controller.dispatch_action(action, operation_id))
    })
    .unwrap_or_else(not_ready)
}

/// Route one painted-document event into typed effects.
#[wasm_bindgen]
pub fn catalyst_controller_dispatch_event(event_json: &str, operation_id: &str) -> String {
    with_controller(|controller| {
        json::canonical_string(&controller.dispatch_event(event_json, operation_id))
    })
    .unwrap_or_else(not_ready)
}

/// Compose the SHELL tab's Document from host-observed shell facts.
#[wasm_bindgen]
pub fn catalyst_shell_viewport_document(model_json: &str) -> String {
    let Some(model) = json::parse(model_json) else {
        return refusal("E_CATALYST_SHELL_VIEWPORT", "model is not valid JSON");
    };
    match shell_viewport::compose_document(&model) {
        Ok(document) => json::canonical_string(&document),
        Err(fault) => refusal("E_CATALYST_SHELL_VIEWPORT", &fault.0),
    }
}

/// The authored tab set, so the host never hardcodes one.
#[wasm_bindgen]
pub fn catalyst_tabs() -> String {
    json::canonical_string(&json::obj(vec![
        ("schema", json::s(tabs::TABS_SCHEMA)),
        ("tabs", Json::Arr(tabs::tabs().iter().map(tabs::Tab::to_json).collect())),
    ]))
}

/// Resolve one catalog tab's Document; live RUN tabs return a refusal.
#[wasm_bindgen]
pub fn catalyst_tab_document(tab_id: &str) -> String {
    let Some(tab) = tabs::tabs().into_iter().find(|tab| tab.id == tab_id) else {
        return refusal("E_CATALYST_EXECUTIVE_TAB", "tab is not authored");
    };
    match tabs::tab_document(&tab) {
        Some(document) => document.to_string(),
        None => refusal("E_CATALYST_TAB_DOCUMENT", "tab has no static catalog document"),
    }
}

/// Paint the selected tab with the shared engine.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn catalyst_controller_paint(root: web_sys::Element) -> String {
    let document = CONTROLLER.with(|cell| cell.borrow().as_ref().and_then(|c| c.painted_document()));
    match document {
        Some(document) => catalyst_mount_document(root, &json::canonical_string(&document)),
        None => refusal("E_CATALYST_EXECUTIVE_DOCUMENT", "selected tab has no admitted document"),
    }
}

/// Admit one canonical Document against the engine's own contract.
#[wasm_bindgen]
pub fn catalyst_validate_document(document_json: &str) -> String {
    let Some(document) = json::parse(document_json) else {
        return refusal("E_CATALYST_UGUI_DOCUMENT", "document is not valid JSON");
    };
    match ugui_render::native_webview::validate_webview_document(
        &document,
        ugui_render::native_webview::WebviewRegions::content(true, true),
    ) {
        Ok(()) => json::canonical_string(&json::obj(vec![
            ("schema", json::s("catalyst-ugui-admission/1")),
            ("id", document.get("id").cloned().unwrap_or(Json::Null)),
            ("admitted", Json::Bool(true)),
        ])),
        Err(fault) => refusal("E_CATALYST_UGUI_DOCUMENT", &fault.to_string()),
    }
}

/// The item vocabulary this client paints, read from the engine rather than
/// redeclared, so Catalyst can never drift from UGUI's canonical set.
#[wasm_bindgen]
pub fn catalyst_document_item_types() -> String {
    let items = json::parse(include_str!("../../../ugui/json/document-items.json"))
        .and_then(|value| value.get("items").cloned())
        .unwrap_or(Json::Null);
    let types = match &items {
        Json::Obj(fields) => {
            Json::Arr(fields.iter().map(|(name, _)| json::s(name)).collect::<Vec<_>>())
        }
        _ => Json::Arr(Vec::new()),
    };
    json::canonical_string(&json::obj(vec![
        ("schema", json::s("catalyst-ugui-item-types/1")),
        ("types", types),
    ]))
}

/// Every app UGUI publishes, across every source. Catalyst learns that
/// `run/apps` is one source among several rather than a host it depends on.
#[wasm_bindgen]
pub fn catalyst_app_catalog() -> String {
    let apps = ugui_render::app_catalog::all()
        .into_iter()
        .map(|app| {
            json::obj(vec![
                ("source", json::s(app.source)),
                ("id", json::s(&app.id)),
                ("title", json::s(&app.title)),
                ("executive", Json::Bool(app.executive)),
            ])
        })
        .collect::<Vec<_>>();
    json::canonical_string(&json::obj(vec![
        ("schema", json::s("catalyst-ugui-app-catalog/1")),
        (
            "sources",
            Json::Arr(
                ugui_render::app_catalog::sources().iter().map(|id| json::s(id)).collect::<Vec<_>>(),
            ),
        ),
        ("apps", Json::Arr(apps)),
    ]))
}

/// Resolve one catalogued app document, whichever source publishes it.
#[wasm_bindgen]
pub fn catalyst_app_document(source: &str, id: &str) -> String {
    match ugui_render::app_catalog::document_json(source, id) {
        Some(document) => document.to_string(),
        None => refusal("E_CATALYST_UGUI_APP", "app is not catalogued"),
    }
}

/// Resolve one shared surface plan so Catalyst selects geometry from UGUI.
#[wasm_bindgen]
pub fn catalyst_surface_plan(surface_id: &str) -> String {
    let Some(plan) = ugui_render::native_webview::webview_surface_plan(surface_id) else {
        return refusal("E_CATALYST_UGUI_SURFACE", "surface is not admitted");
    };
    json::canonical_string(&json::obj(vec![
        ("schema", json::s("catalyst-ugui-surface-plan/1")),
        ("id", json::s(surface_id)),
        ("web", Json::Bool(plan.web)),
        ("terminal", Json::Bool(plan.terminal)),
        ("overlay", Json::Bool(plan.overlay)),
        ("desktopWindow", Json::Bool(plan.desktop_window)),
        ("appletSurface", json::s(plan.applet_surface.name())),
    ]))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn catalyst_mount_document(root: web_sys::Element, document_json: &str) -> String {
    let Some(document) = json::parse(document_json) else {
        return refusal("E_CATALYST_UGUI_DOCUMENT", "document is not valid JSON");
    };
    let host = match ugui_render::native_webview::WebSysHost::for_root(root.clone()) {
        Ok(host) => host,
        Err(error) => return refusal("E_CATALYST_UGUI_HOST", &error.to_string()),
    };
    let mut painter = ugui_render::native_webview::WebviewPainter::new(host);
    match painter.mount_regions(
        "",
        &document,
        ugui_render::native_webview::WebviewRegions::content(true, true),
    ) {
        Ok(receipt) => {
            let _ = root.set_attribute("data-ugui-painter", "rust-wasm");
            json::canonical_string(&json::obj(vec![
                ("schema", json::s("catalyst-ugui-render/1")),
                ("kindCounts", receipt_counts(&receipt)),
                (
                    "actionIds",
                    Json::Arr(receipt.action_ids.iter().map(|id| json::s(id)).collect::<Vec<_>>()),
                ),
                (
                    "accessibleNames",
                    Json::Arr(
                        receipt
                            .accessible_names
                            .iter()
                            .map(|name| json::s(name))
                            .collect::<Vec<_>>(),
                    ),
                ),
            ]))
        }
        Err(error) => refusal("E_CATALYST_UGUI_PAINT", &error.to_string()),
    }
}

#[cfg(target_arch = "wasm32")]
fn receipt_counts(receipt: &ugui_render::native_webview::WebviewRenderReceipt) -> Json {
    Json::Obj(
        receipt
            .kind_counts
            .iter()
            .map(|(kind, count)| ((*kind).to_owned(), Json::Int(*count as i64)))
            .collect::<Vec<_>>(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_publishes_run_as_one_source_among_several() {
        let catalog = json::parse(&catalyst_app_catalog()).expect("catalog");
        let sources = catalog
            .get("sources")
            .and_then(Json::as_array)
            .expect("sources")
            .iter()
            .filter_map(Json::as_str)
            .collect::<Vec<_>>();
        assert!(sources.contains(&"run") && sources.contains(&"quine"), "{sources:?}");

        let apps = catalog.get("apps").and_then(Json::as_array).expect("apps");
        assert!(apps.iter().any(|app| app.get("source").and_then(Json::as_str) == Some("quine")));
        for app in apps {
            let source = app.get("source").and_then(Json::as_str).expect("source");
            let id = app.get("id").and_then(Json::as_str).expect("id");
            assert!(!catalyst_app_document(source, id).contains("catalyst-ugui-refusal"));
        }

        let refused = catalyst_app_document("run", "nonesuch");
        assert!(refused.contains("E_CATALYST_UGUI_APP"), "{refused}");
    }

    #[test]
    fn the_client_reads_its_vocabulary_from_the_engine() {
        let types = json::parse(&catalyst_document_item_types()).expect("types");
        let listed = types.get("types").and_then(Json::as_array).expect("type list");
        let names =
            listed.iter().filter_map(Json::as_str).map(str::to_owned).collect::<Vec<_>>();

        for canonical in ["text", "button", "image", "input", "select", "row", "column"] {
            assert!(names.iter().any(|name| name == canonical), "{canonical} is canonical");
        }
    }

    #[test]
    fn invalid_documents_refuse_instead_of_painting() {
        let refused = json::parse(&catalyst_validate_document("{")).expect("refusal");
        assert_eq!(refused.get("error").and_then(Json::as_str), Some("E_CATALYST_UGUI_DOCUMENT"));
    }

    #[test]
    fn surfaces_come_from_the_shared_plan_registry() {
        let plan = json::parse(&catalyst_surface_plan("desktop")).expect("plan");
        assert_eq!(plan.get("id").and_then(Json::as_str), Some("desktop"));
        assert!(plan.get("appletSurface").and_then(Json::as_str).is_some());

        let refused = json::parse(&catalyst_surface_plan("not-a-surface")).expect("refusal");
        assert_eq!(refused.get("error").and_then(Json::as_str), Some("E_CATALYST_UGUI_SURFACE"));
    }
}
