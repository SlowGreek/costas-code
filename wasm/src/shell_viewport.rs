//! The SHELL tab's Document, composed by the engine.
//!
//! Every other Document in the system is composed in Rust. This one was
//! authored in TypeScript because RUN does not supply it — the host gathers
//! shell facts it alone can see, but turning those facts into a canonical
//! Document is an engine concern, not a host one.

use ugui_render::json::{self, Json};

pub const MODEL_SCHEMA: &str = "ae-shell-viewport-model/1";
pub const RECEIPT_SCHEMA: &str = "ae-shell-viewport-receipt/1";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Fault(pub String);

fn field<'a>(value: &'a Json, key: &str) -> &'a Json {
    value.get(key).unwrap_or(&Json::Null)
}

fn text<'a>(value: &'a Json, key: &str) -> &'a str {
    field(value, key).as_str().unwrap_or_default()
}

fn ids(value: &Json, key: &str) -> Vec<String> {
    field(value, key)
        .as_array()
        .map(|items| items.iter().filter_map(Json::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

fn button(id: &str, label: &str, handler: &str, primary: bool) -> Json {
    json::obj(vec![
        ("id", json::s(id)),
        ("type", json::s("button")),
        ("label", json::s(label)),
        ("action", json::s(handler)),
        ("primary", Json::Bool(primary)),
    ])
}

fn status_item(label: &str, value: Json) -> Json {
    json::obj(vec![
        ("label", json::s(label)),
        ("value", value),
        ("status", json::s("ok")),
    ])
}

fn selector_actions(model: &Json, key: &str, prefix: &str, selected: &str) -> Vec<Json> {
    let selector = field(model, "selector");
    ids(selector, key)
        .into_iter()
        .map(|id| {
            button(
                &format!("shell-{prefix}-{id}"),
                &id,
                &format!("shell.{prefix}.{id}"),
                id == selected,
            )
        })
        .collect()
}

/// Entries of an object in authored order; a missing object contributes none.
fn entries(value: &Json) -> Vec<(String, Json)> {
    match value {
        Json::Obj(fields) => fields.clone(),
        _ => Vec::new(),
    }
}

pub fn compose_document(model: &Json) -> Result<Json, Fault> {
    if field(model, "schema").as_str() != Some(MODEL_SCHEMA) {
        return Err(Fault("shell-viewport-model-schema".to_owned()));
    }
    let shell = field(model, "shell");
    let surface = field(model, "surface");
    let target = field(model, "target");
    let warning = text(model, "warning");

    let mut actions = selector_actions(model, "shells", "target", text(shell, "id"));
    actions.extend(selector_actions(model, "surfaces", "surface", text(surface, "id")));
    actions.extend(selector_actions(model, "targets", "build", text(target, "id")));
    actions.push(button("viewport-demo-action", "Inspect evidence", "shell.inspect", false));

    let native_model = json::obj(vec![
        ("schema", json::s(MODEL_SCHEMA)),
        ("shell_id", json::s(text(shell, "id"))),
        ("surface_profile_id", json::s(text(surface, "id"))),
        ("form_factor", json::s(text(surface, "form_factor"))),
        ("geometry", field(surface, "geometry").clone()),
        ("safe_area", field(surface, "safe_area").clone()),
        ("corner_radii", field(surface, "corner_radii").clone()),
        ("chrome", field(surface, "chrome").clone()),
        ("window_policy", json::s(text(surface, "window_policy"))),
        ("warning", json::s(warning)),
    ]);

    let mut evidence = vec![
        status_item("Owner", json::s(text(target, "owner_ref"))),
        status_item("Reason", json::s(text(target, "reason"))),
    ];
    evidence.extend(
        entries(field(target, "rungs")).into_iter().map(|(label, value)| status_item(&label, value)),
    );

    let capability = entries(field(model, "capability_summary"))
        .into_iter()
        .map(|(label, value)| status_item(&label, value))
        .collect::<Vec<_>>();

    let document = json::obj(vec![
        ("id", json::s("shell-viewport")),
        ("type", json::s("document")),
        (
            "header",
            Json::Arr(vec![
                json::obj(vec![
                    ("id", json::s("warning")),
                    ("type", json::s("text")),
                    ("body", json::s(warning)),
                    ("style", json::s("heading")),
                ]),
                json::obj(vec![
                    ("id", json::s("viewport-title")),
                    ("type", json::s("text")),
                    (
                        "body",
                        json::s(&format!("{} · {}", text(surface, "name"), text(target, "id"))),
                    ),
                    ("style", json::s("subtitle")),
                ]),
            ]),
        ),
        (
            "sections",
            Json::Arr(vec![
                json::obj(vec![
                    ("id", json::s("viewport-native")),
                    ("type", json::s("native")),
                    ("catalog", json::s("shell-structural-viewport")),
                    ("model", native_model),
                ]),
                json::obj(vec![
                    ("id", json::s("target-evidence")),
                    ("type", json::s("status_grid")),
                    ("items", Json::Arr(evidence)),
                ]),
                json::obj(vec![
                    ("id", json::s("capability-summary")),
                    ("type", json::s("status_grid")),
                    ("items", Json::Arr(capability)),
                ]),
            ]),
        ),
        ("actions", Json::Arr(actions)),
        (
            "receipt",
            json::obj(vec![
                ("schema", json::s(RECEIPT_SCHEMA)),
                ("authority", json::s("none")),
                ("posture", json::s(text(model, "posture"))),
                ("source_hashes", field(model, "source_hashes").clone()),
            ]),
        ),
    ]);

    let faults = ugui_render::validate_document_value(&document);
    if faults != "[]" {
        return Err(Fault(faults));
    }
    Ok(document)
}

#[cfg(test)]
#[path = "../tests/unit/shell_viewport.rs"]
mod tests;
