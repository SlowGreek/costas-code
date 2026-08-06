use super::*;

const HASH: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn model() -> Json {
    json::obj(vec![
        ("schema", json::s(MODEL_SCHEMA)),
        ("authority", json::s("none")),
        (
            "source_hashes",
            json::obj(vec![
                ("builds", json::s(HASH)),
                ("capabilities", json::s(HASH)),
                ("surfaces", json::s(HASH)),
            ]),
        ),
        (
            "shell",
            json::obj(vec![
                ("id", json::s("macos-shell")),
                ("owner", json::s("macos")),
                ("platform", json::s("macos")),
                ("manifest", json::s("macos-shell/BUILD.json")),
            ]),
        ),
        (
            "surface",
            json::obj(vec![
                ("id", json::s("desktop-16")),
                ("name", json::s("Desktop 16")),
                ("form_factor", json::s("desktop")),
                ("geometry", json::obj(vec![("width", Json::Int(1_512))])),
                ("safe_area", json::obj(vec![("top", Json::Int(0))])),
                ("corner_radii", json::obj(vec![("tl", Json::Int(8))])),
                ("chrome", Json::Arr(vec![json::s("titlebar")])),
                ("window_policy", json::s("resizable")),
            ]),
        ),
        (
            "target",
            json::obj(vec![
                ("id", json::s("aarch64-apple-darwin")),
                ("owner_ref", json::s("macos-shell/BUILD.json")),
                ("reason", json::s("structural")),
                (
                    "rungs",
                    json::obj(vec![
                        ("source", json::s("present")),
                        ("artifact", json::s("absent")),
                        ("package_install", json::s("absent")),
                        ("physical_runtime", json::s("absent")),
                    ]),
                ),
            ]),
        ),
        (
            "capability_summary",
            json::obj(vec![
                ("available", Json::Int(3)),
                ("degraded", Json::Int(1)),
                ("unavailable", Json::Int(0)),
                ("unknown", Json::Int(2)),
            ]),
        ),
        ("posture", json::s("structural-projection")),
        ("warning", json::s("STRUCTURAL PROJECTION — NOT A PHYSICAL RUN")),
        (
            "selector",
            json::obj(vec![
                ("shells", Json::Arr(vec![json::s("macos-shell"), json::s("linux-shell")])),
                ("surfaces", Json::Arr(vec![json::s("desktop-16")])),
                ("targets", Json::Arr(vec![json::s("aarch64-apple-darwin")])),
            ]),
        ),
    ])
}

fn actions(document: &Json) -> Vec<(String, bool)> {
    document
        .get("actions")
        .and_then(Json::as_array)
        .expect("actions")
        .iter()
        .map(|action| {
            (
                action.get("action").and_then(Json::as_str).unwrap_or_default().to_owned(),
                action.get("primary") == Some(&Json::Bool(true)),
            )
        })
        .collect()
}

#[test]
fn the_composed_document_is_admitted_by_the_engine() {
    let document = compose_document(&model()).expect("document");

    assert_eq!(document.get("id").and_then(Json::as_str), Some("shell-viewport"));
    assert_eq!(ugui_render::validate_document_value(&document), "[]");
}

#[test]
fn a_foreign_model_schema_refuses_rather_than_composing() {
    let Json::Obj(mut fields) = model() else { unreachable!() };

    for (name, value) in &mut fields {
        if name == "schema" {
            *value = json::s("ae-shell-viewport-model/2");
        }
    }
    assert_eq!(
        compose_document(&Json::Obj(fields)).expect_err("refusal").0,
        "shell-viewport-model-schema"
    );
}

#[test]
fn selectors_become_actions_with_the_current_choice_primary() {
    let document = compose_document(&model()).expect("document");

    assert_eq!(
        actions(&document),
        vec![
            ("shell.target.macos-shell".to_owned(), true),
            ("shell.target.linux-shell".to_owned(), false),
            ("shell.surface.desktop-16".to_owned(), true),
            ("shell.build.aarch64-apple-darwin".to_owned(), true),
            ("shell.inspect".to_owned(), false),
        ]
    );
}

#[test]
fn evidence_and_capability_counts_reach_the_status_grids() {
    let document = compose_document(&model()).expect("document");
    let sections = document.get("sections").and_then(Json::as_array).expect("sections");

    let labels = |section: &Json| {
        section
            .get("items")
            .and_then(Json::as_array)
            .expect("items")
            .iter()
            .map(|item| item.get("label").and_then(Json::as_str).unwrap_or_default().to_owned())
            .collect::<Vec<_>>()
    };

    assert_eq!(
        labels(&sections[1]),
        ["Owner", "Reason", "source", "artifact", "package_install", "physical_runtime"]
    );
    assert_eq!(labels(&sections[2]), ["available", "degraded", "unavailable", "unknown"]);
}

#[test]
fn the_receipt_carries_posture_and_source_hashes_without_claiming_authority() {
    let document = compose_document(&model()).expect("document");
    let receipt = document.get("receipt").expect("receipt");

    assert_eq!(receipt.get("schema").and_then(Json::as_str), Some(RECEIPT_SCHEMA));
    assert_eq!(receipt.get("authority").and_then(Json::as_str), Some("none"));
    assert_eq!(receipt.get("posture").and_then(Json::as_str), Some("structural-projection"));
    assert_eq!(
        receipt.get("source_hashes").and_then(|hashes| hashes.get("builds")),
        Some(&json::s(HASH))
    );
}

#[test]
fn the_native_section_carries_the_surface_geometry_the_host_observed() {
    let document = compose_document(&model()).expect("document");
    let sections = document.get("sections").and_then(Json::as_array).expect("sections");
    let native = sections[0].get("model").expect("native model");

    assert_eq!(
        sections[0].get("catalog").and_then(Json::as_str),
        Some("shell-structural-viewport")
    );
    assert_eq!(native.get("shell_id").and_then(Json::as_str), Some("macos-shell"));
    assert_eq!(native.get("window_policy").and_then(Json::as_str), Some("resizable"));
    assert_eq!(
        native.get("geometry").and_then(|geometry| geometry.get("width")),
        Some(&Json::Int(1_512))
    );
}
