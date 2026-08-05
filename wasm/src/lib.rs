//! Catalyst's UGUI client.
//!
//! Catalyst owns no painting vocabulary. Every canonical Document item is
//! rendered by the same `ugui::native_webview` engine `projects/` proved out,
//! so the desktop shell reinvents no concept-space and inherits every primitive
//! UGUI adds.

use ugui_render::json::{self, Json};
use wasm_bindgen::prelude::*;

fn refusal(code: &str, detail: &str) -> String {
    json::canonical_string(&json::obj(vec![
        ("schema", json::s("catalyst-ugui-refusal/1")),
        ("error", json::s(code)),
        ("detail", json::s(detail)),
    ]))
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
