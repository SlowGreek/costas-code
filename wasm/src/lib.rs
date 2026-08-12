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
    let document =
        CONTROLLER.with(|cell| cell.borrow().as_ref().and_then(|c| c.painted_document()));
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
    let items = json::parse(include_str!("../../../genui/ugui/json/document-items.json"))
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
                ugui_render::app_catalog::sources()
                    .iter()
                    .map(|id| json::s(id))
                    .collect::<Vec<_>>(),
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
    match ugui_render::native_webview::WebSysHost::mount_application_document(
        root.clone(),
        &document,
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
#[wasm_bindgen]
pub fn catalyst_mount_l2_document(root: web_sys::Element, document_json: &str) -> String {
    let Some(document) = json::parse(document_json) else {
        return refusal("E_CATALYST_UGUI_DOCUMENT", "document is not valid JSON");
    };
    match ugui_render::native_webview::WebSysHost::mount_embedded_l2_document(
        root.clone(),
        &document,
        "Close dialog",
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
        let names = listed.iter().filter_map(Json::as_str).map(str::to_owned).collect::<Vec<_>>();

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

/// Where this host serves `/png` and `/apps`. A `file://` renderer has no site
/// root, so the Document's root-absolute asset URLs need the host's base.
#[wasm_bindgen]
pub fn catalyst_set_asset_base(base: &str) {
    ugui_render::native_webview::set_asset_base(base);
}

/// Resolve a painted Document's action with the engine's web vocabulary — the
/// same meaning projects/ proved, rather than this host's RUN-shaped intent set.
#[wasm_bindgen]
pub fn catalyst_document_action(action: &str, node_id: &str, value_source: &str) -> String {
    let value = json::parse(value_source).unwrap_or(Json::Null);

    json::canonical_string(&ugui_render::web_action::to_json(&ugui_render::web_action::resolve(
        action, node_id, &value,
    )))
}

thread_local! {
    static PROJECTS: std::cell::RefCell<ugui_render::applets::projects::session::ProjectsSession> =
        std::cell::RefCell::new(ugui_render::applets::projects::session::ProjectsSession::repository());
    static OVERLAYS: std::cell::RefCell<ugui_render::document_stack::DocumentStack> =
        const { std::cell::RefCell::new(ugui_render::document_stack::DocumentStack::new()) };
}

/// This host's wire label for the engine's Document stack.
const OVERLAY_SCHEMA: &str = "catalyst-document-stack/1";

/// Open a Document over whatever is already open. Nesting is the engine's, so
/// this host does not have to decide what depth means.
#[wasm_bindgen]
pub fn catalyst_overlay_push(document_source: &str) -> String {
    // A Document is an object; anything else would open an empty frame.
    let Some(document) = json::parse(document_source).filter(|value| value.get("id").is_some())
    else {
        return refusal("E_CATALYST_OVERLAY", "document is not a Document");
    };
    OVERLAYS.with(|overlays| overlays.borrow_mut().push(document));
    catalyst_overlay_snapshot()
}

/// Close the showing Document. The root of a stack closes the stack.
#[wasm_bindgen]
pub fn catalyst_overlay_close() -> String {
    OVERLAYS.with(|overlays| {
        let mut overlays = overlays.borrow_mut();
        if !overlays.pop() {
            overlays.clear();
        }
    });
    catalyst_overlay_snapshot()
}

#[wasm_bindgen]
pub fn catalyst_overlay_clear() -> String {
    OVERLAYS.with(|overlays| overlays.borrow_mut().clear());
    catalyst_overlay_snapshot()
}

#[wasm_bindgen]
pub fn catalyst_overlay_snapshot() -> String {
    OVERLAYS.with(|overlays| json::canonical_string(&overlays.borrow().to_json(OVERLAY_SCHEMA)))
}

/// Drive the seated Projects applet with one authored input and re-project it.
/// The engine owns what the input means; this host only carries it and repaints.
#[wasm_bindgen]
pub fn catalyst_projects_input(handler: &str, node_id: &str, value_source: &str) -> String {    use ugui_render::applets::projects::session::{Applied, ProjectsInput};

    let input = ProjectsInput {
        handler: handler.to_owned(),
        node_id: node_id.to_owned(),
        value: json::parse(value_source).unwrap_or(Json::Null),
    };

    PROJECTS.with(|session| {
        let mut session = session.borrow_mut();
        match session.apply(&input) {
            Ok(Applied::Query) => json::canonical_string(&json::obj(vec![
                ("schema", json::s("catalyst-projects-frame/1")),
                ("status", json::s("accepted")),
                (
                    "document",
                    // `None` paints the surface the session remembers; naming one
                    // here would pin every re-projection to Desktop.
                    json::parse(&session.document(None, false)).unwrap_or(Json::Null),
                ),
                // A vertical Document is authored, so its content cannot answer
                // the surface. The frame it is painted in still has to.
                ("surface", surface_frame(&session)),
            ])),
            Ok(Applied::Host) => refusal("E_CATALYST_PROJECTS_HOST_INPUT", handler),
            Err(code) => refusal("E_CATALYST_PROJECTS_INPUT", code),
        }
    })
}

/// How the seated surface is presented. A host frames its viewport from the
/// engine's plan rather than deciding for itself what `watch` or `phone` means.
fn surface_frame(session: &ugui_render::applets::projects::session::ProjectsSession) -> Json {
    let plan = session.surface_plan();

    json::obj(vec![
        ("id", json::s(plan.id)),
        ("renderMode", json::s(plan.render_mode.name())),
        ("appletSurface", json::s(plan.applet_surface.name())),
        ("overlay", Json::Bool(plan.overlay)),
        ("wearable", Json::Bool(plan.wearable)),
        ("resizable", Json::Bool(plan.resizable)),
    ])
}

/// The CSS custom properties a skin projects. The engine owns the style matrix,
/// the skins that bind it, and the vocabulary sheet that reads them.
/// The attributes a skin implies, so rules keyed on chrome state are reachable.
fn skin_attributes(skin_id: &str) -> Json {
    let closes = ugui_render::theme::CATALOG
        .iter()
        .find(|skin| skin.id == skin_id || skin.canonical_id == skin_id)
        .and_then(|skin| json::parse(skin.binding_json))
        .is_some_and(|binding| ugui_render::style_chrome::closes_windows(&binding));

    json::obj(vec![(
        "data-skin-chrome-controls",
        json::s(if closes { "true" } else { "false" }),
    )])
}

#[wasm_bindgen]
pub fn catalyst_skin_variables(skin_id: &str, mode: &str) -> String {
    match ugui_render::style_css::skin_variables(
        skin_id,
        ugui_render::style_css::Mode::from_id(mode),
    ) {
        Some(variables) => json::canonical_string(&json::obj(vec![
            ("schema", json::s("catalyst-skin-variables/1")),
            ("skin", json::s(skin_id)),
            (
                "variables",
                Json::Obj(
                    variables.into_iter().map(|(name, value)| (name, json::s(&value))).collect(),
                ),
            ),
            // A skin implies attributes as well as variables. Carrying only the
            // variables leaves every rule keyed on chrome state unreachable.
            ("attributes", skin_attributes(skin_id)),
        ])),
        None => refusal("E_CATALYST_SKIN", skin_id),
    }
}

/// The shell's CSS variables for one normalized render profile. The host owns
/// normalization; what the axes mean in CSS is the engine's answer.
#[wasm_bindgen]
pub fn catalyst_profile_css(axes_source: &str, mode: &str) -> String {
    let axes = json::parse(axes_source).unwrap_or(Json::Null);

    json::canonical_string(&Json::Obj(
        ugui_render::style_css::profile_variables(
            &axes,
            ugui_render::style_css::Mode::from_id(mode),
        )
        .into_iter()
        .map(|(name, value)| (name, json::s(&value)))
        .collect(),
    ))
}

/// What a key or pointer gesture means. The engine owns the decision so a
/// second client cannot invent a different one for the same keystroke.
#[wasm_bindgen]
pub fn catalyst_global_key(
    key: &str,
    meta: bool,
    control: bool,
    alt: bool,
    executable: bool,
) -> String {
    let resolved = ugui_render::interaction::resolve_global_key(
        &ugui_render::interaction::Keystroke { key, shift: false, meta, control, alt },
        false,
        false,
        "",
        executable,
    );

    json::canonical_string(&ugui_render::interaction::to_json(&resolved))
}

/// Which control of a preference group is currently committed, so a painted
/// Document can show its own state instead of looking inert.
#[wasm_bindgen]
pub fn catalyst_preference_selection(active_source: &str) -> String {
    let active = json::parse(active_source).unwrap_or(Json::Null);
    let selected = ugui_render::preferences::kinds()
        .filter_map(|kind| {
            let choice = active.get(kind).and_then(Json::as_str)?;
            ugui_render::preferences::node_id(kind, choice)
                .map(|node| (kind.to_owned(), json::s(&node)))
        })
        .collect::<Vec<_>>();

    json::canonical_string(&json::obj(vec![
        ("schema", json::s(ugui_render::preferences::SCHEMA)),
        ("selected", Json::Obj(selected)),
    ]))
}

/// The choices a preference admits, so a host validates against the engine's
/// vocabulary rather than a hand-copied list.
#[wasm_bindgen]
pub fn catalyst_preference_vocabulary() -> String {
    let table = ugui_render::preferences::kinds()
        .map(|kind| {
            let choices = ugui_render::preferences::choices(kind)
                .map(|choices| Json::Arr(choices.iter().map(|choice| json::s(choice)).collect()))
                .unwrap_or(Json::Null);

            (
                kind.to_owned(),
                json::obj(vec![
                    ("action", ugui_render::preferences::action(kind).map_or(Json::Null, json::s)),
                    ("choices", choices),
                    (
                        "appletInput",
                        ugui_render::preferences::applet_input(kind).map_or(Json::Null, json::s),
                    ),
                ]),
            )
        })
        .collect::<Vec<_>>();

    json::canonical_string(&json::obj(vec![
        ("schema", json::s(ugui_render::preferences::SCHEMA)),
        ("preferences", Json::Obj(table)),
    ]))
}

thread_local! {
    static SKIN_EDIT: std::cell::RefCell<Option<ugui_render::skin_session::SkinSession>> =
        const { std::cell::RefCell::new(None) };
}

/// Apply one Skin Studio edit. The engine generates that Document and owns the
/// style matrix, so it owns which `{slot}/{token}` an edit may address.
#[wasm_bindgen]
pub fn catalyst_skin_field(skin_id: &str, node_id: &str, value_source: &str, mode: &str) -> String {
    use ugui_render::skin_session;

    let value = json::parse(value_source).unwrap_or(Json::Null);

    SKIN_EDIT.with(|session| {
        let mut session = session.borrow_mut();
        let seated = match session.as_ref() {
            Some(seated) if seated.skin_id == skin_id => true,
            _ => false,
        };
        if !seated {
            let Some(fresh) = skin_session::select(skin_id) else {
                return refusal("E_CATALYST_SKIN", skin_id);
            };
            *session = Some(fresh);
        }
        let Some(editing) = session.as_mut() else {
            return refusal("E_CATALYST_SKIN", skin_id);
        };
        let applied = match node_id {
            "" => {
                skin_session::reset(editing);
                Ok(())
            }
            path => skin_session::apply_field(editing, path, &value),
        };

        match applied {
            Ok(()) => json::canonical_string(&json::obj(vec![
                ("schema", json::s(skin_session::SCHEMA)),
                ("skin", json::s(&editing.skin_id)),
                (
                    "variables",
                    Json::Obj(
                        ugui_render::style_css::variables(
                            &editing.binding,
                            ugui_render::style_css::Mode::from_id(mode),
                        )
                        .into_iter()
                        .map(|(name, value)| (name, json::s(&value)))
                        .collect(),
                    ),
                ),
            ])),
            Err(detail) => refusal("E_CATALYST_SKIN_FIELD", detail),
        }
    })
}

/// Resolve a Document the projects site serves by path. The engine carries the
/// app documents, so this host neither stages a copy of the folder nor fetches.
#[wasm_bindgen]
pub fn catalyst_document_source(source: &str) -> String {
    // The Skin Studio is projected from the skin that is active, not read from
    // the authored file, which names whichever skin it shipped with.
    if source == "/apps/skins.json" {
        let active = SKIN_EDIT.with(|session| {
            session.borrow().as_ref().map(|seated| seated.skin_id.clone())
        });
        let skin_id = active.unwrap_or_else(|| ACTIVE_SKIN.with(|skin| skin.borrow().clone()));

        return match ugui_render::skin_template::studio(&skin_id) {
            Ok(document) => json::canonical_string(&document),
            Err(findings) => refusal("E_CATALYST_SKIN_STUDIO", &findings.join("; ")),
        };
    }
    match ugui_render::app_catalog::projects_document_for_source(source) {
        Some(document) => document.to_owned(),
        None => refusal("E_CATALYST_UGUI_APP", "document source is not carried"),
    }
}

thread_local! {
    /// The skin this host last committed, so the Studio opens on it.
    static ACTIVE_SKIN: std::cell::RefCell<String> =
        std::cell::RefCell::new("glassmorphism".to_owned());
}

/// Tell the engine which skin this host is showing.
#[wasm_bindgen]
pub fn catalyst_set_active_skin(skin_id: &str) -> String {
    let seated = ugui_render::theme::CATALOG
        .iter()
        .find(|skin| skin.id == skin_id || skin.canonical_id == skin_id);
    let Some(skin) = seated else {
        return refusal("E_CATALYST_SKIN", "skin is not catalogued");
    };
    ACTIVE_SKIN.with(|active| *active.borrow_mut() = skin.canonical_id.to_owned());

    json::canonical_string(&json::obj(vec![
        ("schema", json::s("catalyst-active-skin/1")),
        ("skin", json::s(skin.canonical_id)),
    ]))
}
