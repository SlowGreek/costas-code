use super::*;

const HASH: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEX: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn context(posture: ActionPosture) -> ActionContext {
    ActionContext { generation: 7, document_hash: HASH.to_string(), posture }
}

#[test]
fn every_declared_action_resolves_to_a_verb_and_payload() {
    for action in [
        "lucid.show.projects",
        "lucid.show.status",
        "lucid.get.evidence",
        "lucid.get.posture",
        "lucid.set.view-policy",
        "lucid.set.view-policy.compact",
        "lucid.morph.fidelity",
        "lucid.morph.fidelity.lossless",
        "lucid.steer.hold.em",
        "lucid.steer.hold.sidekick",
    ] {
        let (verb, payload) = action_for_handler(action).unwrap_or_else(|| panic!("{action}"));
        assert!(!verb.is_empty());
        assert!(payload.get("kind").and_then(Json::as_str).is_some(), "{action}");
    }
    assert!(action_for_handler("lucid.show.everything").is_none());
    assert!(action_for_handler("shell.tab.home").is_none());
}

#[test]
fn parametric_actions_admit_only_well_formed_identities() {
    let (verb, payload) = action_for_handler(&format!("lucid.dispatch.plan:{HEX}")).expect("plan");
    assert_eq!(verb, "dispatch");
    assert_eq!(payload.get("id").and_then(Json::as_str), Some(format!("plan:{HEX}").as_str()));

    for mode in ["graceful", "immediate"] {
        let action = format!("lucid.cancel.execution:{HEX}:{mode}");
        let (verb, payload) = action_for_handler(&action).unwrap_or_else(|| panic!("{action}"));
        assert_eq!(verb, "cancel");
        assert_eq!(payload.get("mode").and_then(Json::as_str), Some(mode));
    }

    for refused in [
        format!("lucid.dispatch.plan:{}", "z".repeat(64)),
        format!("lucid.dispatch.plan:{HEX}0"),
        format!("lucid.cancel.execution:{HEX}:whenever"),
        format!("lucid.cancel.execution:{HEX}"),
    ] {
        assert!(action_for_handler(&refused).is_none(), "{refused}");
    }
}

#[test]
fn posture_bounds_which_verbs_may_leave_the_client() {
    for (posture, verb_admitted) in [
        (ActionPosture::Held, false),
        (ActionPosture::Read, true),
        (ActionPosture::Ready, true),
    ] {
        let built = build_intent("lucid.show.status", &context(posture), "op-1");
        assert_eq!(built.is_some(), verb_admitted, "show under {}", posture.as_str());
    }

    // A read posture must not be able to mutate.
    assert!(build_intent("lucid.set.view-policy", &context(ActionPosture::Read), "op-1").is_none());
    assert!(build_intent("lucid.set.view-policy", &context(ActionPosture::Ready), "op-1").is_some());
}

#[test]
fn an_intent_without_provenance_is_never_built() {
    let mut stale = context(ActionPosture::Ready);
    stale.generation = 0;
    assert!(build_intent("lucid.show.status", &stale, "op-1").is_none());

    let mut unhashed = context(ActionPosture::Ready);
    unhashed.document_hash = "nope".to_string();
    assert!(build_intent("lucid.show.status", &unhashed, "op-1").is_none());
}

#[test]
fn a_built_intent_carries_the_expected_generation_and_hash() {
    let intent = build_intent("lucid.get.evidence", &context(ActionPosture::Read), "op-42")
        .expect("intent");
    assert_eq!(intent.get("schema").and_then(Json::as_str), Some(INTENT_SCHEMA));
    assert_eq!(intent.get("verb").and_then(Json::as_str), Some("get"));
    assert_eq!(intent.get("expected_generation"), Some(&Json::Int(7)));
    assert_eq!(intent.get("expected_document_hash").and_then(Json::as_str), Some(HASH));
    assert_eq!(intent.get("operation_id").and_then(Json::as_str), Some("op-42"));
}

#[test]
fn posture_disables_every_action_the_engine_would_refuse() {
    let document = json::obj(vec![
        ("id", json::s("lucid")),
        ("type", json::s("document")),
        (
            "actions",
            Json::Arr(vec![
                json::obj(vec![("type", json::s("button")), ("action", json::s("lucid.show.status"))]),
                json::obj(vec![
                    ("type", json::s("button")),
                    ("action", json::s("lucid.set.view-policy")),
                ]),
                json::obj(vec![("type", json::s("button")), ("action", json::s("shell.tab.home"))]),
            ]),
        ),
    ]);

    let painted = apply_posture(&document, &context(ActionPosture::Read));
    let actions = painted.get("actions").and_then(Json::as_array).expect("actions");

    // A read posture keeps reads live and disables mutations.
    assert_eq!(actions[0].get("disabled"), None);
    assert_eq!(actions[1].get("disabled"), Some(&Json::Bool(true)));
    assert_eq!(
        actions[1].get("disabled_reason").and_then(Json::as_str),
        Some("owner-capability-required")
    );
    // Non-LUCID affordances are never touched.
    assert_eq!(actions[2].get("disabled"), None);

    let held = apply_posture(&document, &context(ActionPosture::Held));
    let actions = held.get("actions").and_then(Json::as_array).expect("actions");
    assert_eq!(actions[0].get("disabled"), Some(&Json::Bool(true)));
    assert_eq!(actions[0].get("disabled_reason").and_then(Json::as_str), Some("authority-held"));

    // An unknown lucid action is disabled rather than silently offered.
    let unknown = apply_posture(
        &json::obj(vec![("action", json::s("lucid.show.everything"))]),
        &context(ActionPosture::Ready),
    );
    assert_eq!(unknown.get("disabled"), Some(&Json::Bool(true)));
}
