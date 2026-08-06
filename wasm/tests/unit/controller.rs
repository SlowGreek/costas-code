use super::*;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn envelope(generation: i64, document_hash: &str) -> String {
    let document = |id: &str| {
        json::obj(vec![
            ("id", json::s(id)),
            ("type", json::s("document")),
            ("header", Json::Arr(Vec::new())),
            ("sections", Json::Arr(Vec::new())),
            ("actions", Json::Arr(Vec::new())),
        ])
    };
    let row = |tab: &str| {
        json::obj(vec![
            ("schema", json::s(executive::ROW_SCHEMA)),
            ("tab", json::s(tab)),
            ("source_hash", json::s(HASH_B)),
            ("source_generation", Json::Int(1)),
            ("observed_ms", Json::Int(10)),
            ("freshness", json::s("fresh")),
            ("posture", json::s("observed")),
            ("artifact_posture", json::s("observed")),
            ("document", document(tab)),
            ("code", Json::Null),
        ])
    };
    json::canonical_string(&json::obj(vec![
        ("schema", json::s(executive::ENVELOPE_SCHEMA)),
        ("authority", json::s("RUN_EXECUTIVE_COMPOSER")),
        ("executive_generation", Json::Int(generation)),
        ("document_hash", json::s(document_hash)),
        ("source_set_hash", json::s(HASH_B)),
        ("observed_ms", Json::Int(generation * 10)),
        ("freshness", json::s("fresh")),
        ("artifact_generation", json::s(HASH_A)),
        ("artifact_posture", json::s("observed")),
        ("admission_code", json::s("admitted")),
        ("blocker", Json::Null),
        ("rows", Json::Arr(vec![row("home"), row("dashboard")])),
    ]))
}

fn controller() -> Controller {
    Controller::new(vec!["home".to_string(), "dashboard".to_string()])
}

fn effect_kinds(receipt: &Json) -> Vec<String> {
    receipt
        .get("effects")
        .and_then(Json::as_array)
        .map(|effects| {
            effects
                .iter()
                .filter_map(|effect| effect.get("kind").and_then(Json::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn the_first_tab_is_selected_before_anything_is_observed() {
    let controller = controller();
    assert_eq!(controller.selected_tab(), Some("home"));
    assert!(controller.selected_document().is_none());
}

#[test]
fn observing_an_envelope_admits_it_and_asks_for_one_repaint() {
    let mut controller = controller();
    let receipt = controller.observe(&envelope(2, HASH_B));
    assert_eq!(receipt.get("accepted"), Some(&Json::Bool(true)));
    assert_eq!(effect_kinds(&receipt), vec!["paint"]);
    assert!(controller.selected_document().is_some());

    // An identical batch changes nothing, so it must not schedule a repaint.
    let again = controller.observe(&envelope(2, HASH_B));
    assert_eq!(again.get("reason").and_then(Json::as_str), Some("duplicate"));
    assert!(effect_kinds(&again).is_empty());
}

#[test]
fn a_malformed_envelope_refuses_without_disturbing_admitted_state() {
    let mut controller = controller();
    controller.observe(&envelope(2, HASH_B));

    for bad in ["{", "{\"schema\":\"scene/1\"}"] {
        let receipt = controller.observe(bad);
        assert_eq!(
            receipt.get("error").and_then(Json::as_str),
            Some("E_CATALYST_EXECUTIVE_ENVELOPE"),
            "{bad}"
        );
    }
    assert!(controller.selected_document().is_some());
}

#[test]
fn selecting_a_tab_is_bounded_by_the_admitted_tab_set() {
    let mut controller = controller();
    let receipt = controller.select("dashboard");
    assert_eq!(receipt.get("tab").and_then(Json::as_str), Some("dashboard"));
    assert_eq!(effect_kinds(&receipt), vec!["paint"]);
    assert_eq!(controller.selected_tab(), Some("dashboard"));

    // Re-selecting the same tab is not a repaint.
    assert!(effect_kinds(&controller.select("dashboard")).is_empty());

    let refused = controller.select("nonesuch");
    assert_eq!(refused.get("error").and_then(Json::as_str), Some("E_CATALYST_EXECUTIVE_TAB"));
    assert_eq!(controller.selected_tab(), Some("dashboard"));
}

#[test]
fn a_shell_tab_gesture_becomes_typed_effects_rather_than_host_string_matching() {
    let mut controller = controller();
    controller.observe(&envelope(2, HASH_B));

    let receipt = controller.dispatch_action("shell.tab.dashboard", "op-1");
    assert_eq!(effect_kinds(&receipt), vec!["tab.select", "paint"]);
    assert_eq!(controller.selected_tab(), Some("dashboard"));

    let refused = controller.dispatch_action("shell.tab.nonesuch", "op-1");
    assert_eq!(effect_kinds(&refused), vec!["refused"]);
    assert_eq!(controller.selected_tab(), Some("dashboard"));
}

#[test]
fn a_read_posture_emits_read_intents_and_refuses_mutations() {
    let mut controller = controller();
    controller.observe(&envelope(2, HASH_B));

    let receipt = controller.dispatch_action("lucid.show.status", "op-7");
    assert_eq!(effect_kinds(&receipt), vec!["lucid.intent"]);
    let effects = receipt.get("effects").and_then(Json::as_array).expect("effects");
    let built = effects[0].get("intent").expect("intent");
    assert_eq!(built.get("verb").and_then(Json::as_str), Some("show"));
    assert_eq!(built.get("expected_generation"), Some(&Json::Int(2)));
    assert_eq!(built.get("operation_id").and_then(Json::as_str), Some("op-7"));

    assert_eq!(
        effect_kinds(&controller.dispatch_action("lucid.set.view-policy", "op-8")),
        vec!["refused"]
    );
    assert_eq!(
        effect_kinds(&controller.dispatch_action("lucid.show.everything", "op-9")),
        vec!["refused"]
    );
}

#[test]
fn no_intent_leaves_the_client_before_a_batch_is_admitted() {
    let mut controller = controller();
    let receipt = controller.dispatch_action("lucid.show.status", "op-1");
    assert_eq!(effect_kinds(&receipt), vec!["refused"]);
    let effects = receipt.get("effects").and_then(Json::as_array).expect("effects");
    assert_eq!(
        effects[0].get("code").and_then(Json::as_str),
        Some("E_CATALYST_EXECUTIVE_ENVELOPE")
    );
}

#[test]
fn a_studio_event_carries_the_admitted_rows_revision() {
    let mut controller = Controller::new(vec!["studio".to_string(), "home".to_string()]);
    let receipt = controller.dispatch_event("{\"action\":\"studio.edit\"}", "op-1");
    // Nothing admitted yet, so there is no revision to submit against.
    assert_eq!(effect_kinds(&receipt), vec!["refused"]);

    let malformed = controller.dispatch_event("{", "op-1");
    assert_eq!(malformed.get("error").and_then(Json::as_str), Some("E_CATALYST_UGUI_EVENT"));
}

#[test]
fn the_painted_document_never_offers_a_refused_affordance() {
    let mut controller = controller();
    controller.observe(&envelope(2, HASH_B));
    let painted = controller.painted_document().expect("painted");
    // Posture is applied before paint, so the host cannot paint the raw document.
    assert_eq!(painted.get("id").and_then(Json::as_str), Some("home"));
}
