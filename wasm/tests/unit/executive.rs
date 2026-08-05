use super::*;

const TABS: [&str; 2] = ["home", "dashboard"];
const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn document(id: &str) -> Json {
    json::obj(vec![
        ("id", json::s(id)),
        ("type", json::s("document")),
        ("header", Json::Arr(Vec::new())),
        ("sections", Json::Arr(Vec::new())),
        ("actions", Json::Arr(Vec::new())),
    ])
}

fn row(tab: &str, posture: &str, freshness: &str, document_value: Json) -> Json {
    json::obj(vec![
        ("schema", json::s(ROW_SCHEMA)),
        ("tab", json::s(tab)),
        ("source_hash", json::s(HASH_C)),
        ("source_generation", Json::Int(4)),
        ("observed_ms", Json::Int(1_000)),
        ("freshness", json::s(freshness)),
        ("posture", json::s(posture)),
        ("artifact_posture", json::s(posture)),
        ("document", document_value),
        ("code", Json::Null),
    ])
}

fn envelope(generation: i64, document_hash: &str, rows: Vec<Json>) -> Json {
    json::obj(vec![
        ("schema", json::s(ENVELOPE_SCHEMA)),
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
        ("rows", Json::Arr(rows)),
    ])
}

fn live_envelope(generation: i64, document_hash: &str) -> Json {
    envelope(
        generation,
        document_hash,
        vec![
            row("home", "observed", "fresh", document("home")),
            row("dashboard", "observed", "fresh", document("dashboard")),
        ],
    )
}

fn parsed(generation: i64, document_hash: &str) -> Batch {
    parse_envelope(&live_envelope(generation, document_hash), &TABS).expect("envelope")
}

#[test]
fn a_live_envelope_admits_every_tab_and_derives_live_posture() {
    let batch = parsed(2, HASH_B);
    assert_eq!(batch.generation, Some(2));
    assert_eq!(batch.posture, Posture::Live);
    assert_eq!(batch.rows.len(), 2);
    assert!(batch.rows.iter().all(|row| row.state == RowState::Fresh));
    assert!(batch.document_for_tab("dashboard").is_some());
    assert!(batch.document_for_tab("nonesuch").is_none());
}

#[test]
fn posture_and_row_state_follow_freshness_and_artifact_posture() {
    for (posture, freshness, expected) in [
        ("observed", "fresh", RowState::Fresh),
        ("observed", "stale", RowState::Stale),
        ("fixture", "fresh", RowState::Fixture),
        ("structural", "fresh", RowState::Structural),
        ("held", "fresh", RowState::Unavailable),
        ("missing", "fresh", RowState::Unavailable),
    ] {
        let rows = vec![
            row("home", posture, freshness, document("home")),
            row("dashboard", "observed", "fresh", document("dashboard")),
        ];
        let batch = parse_envelope(&envelope(2, HASH_B, rows), &TABS).expect("envelope");
        assert_eq!(batch.row("home").unwrap().state, expected, "{posture}/{freshness}");
    }

    // A null document is unavailable whatever the posture claims.
    let rows = vec![
        row("home", "observed", "fresh", Json::Null),
        row("dashboard", "observed", "fresh", document("dashboard")),
    ];
    let batch = parse_envelope(&envelope(2, HASH_B, rows), &TABS).expect("envelope");
    assert_eq!(batch.row("home").unwrap().state, RowState::Unavailable);
}

#[test]
fn admission_refuses_every_malformed_envelope_shape() {
    let cases: Vec<(&str, Box<dyn Fn(&mut Vec<(String, Json)>)>)> = vec![
        ("schema", Box::new(|fields| set(fields, "schema", json::s("scene/1")))),
        ("authority", Box::new(|fields| set(fields, "authority", json::s("SELF")))),
        ("generation", Box::new(|fields| set(fields, "executive_generation", Json::Int(-1)))),
        ("fractional", Box::new(|fields| set(fields, "executive_generation", Json::Num(2.5)))),
        ("freshness", Box::new(|fields| set(fields, "freshness", json::s("warm")))),
        ("posture", Box::new(|fields| set(fields, "artifact_posture", json::s("guessed")))),
        ("admission", Box::new(|fields| set(fields, "admission_code", json::s("")))),
        ("artifact", Box::new(|fields| set(fields, "artifact_generation", json::s("sha256:xyz")))),
        ("hash", Box::new(|fields| set(fields, "document_hash", json::s("nope")))),
        ("rows", Box::new(|fields| set(fields, "rows", Json::Arr(Vec::new())))),
    ];

    for (label, mutate) in cases {
        let Json::Obj(mut fields) = live_envelope(2, HASH_B) else { unreachable!() };
        mutate(&mut fields);
        assert!(parse_envelope(&Json::Obj(fields), &TABS).is_err(), "{label} must refuse");
    }
}

#[test]
fn a_document_the_engine_refuses_is_not_admitted_by_the_host() {
    let rows = vec![
        row("home", "observed", "fresh", json::obj(vec![("sceneVersion", Json::Int(1))])),
        row("dashboard", "observed", "fresh", document("dashboard")),
    ];
    let fault = parse_envelope(&envelope(2, HASH_B, rows), &TABS).expect_err("refusal");
    assert_eq!(fault.0, "ae-executive-document:home");
}

#[test]
fn an_unavailable_episode_carries_no_provenance_and_claims_no_authority() {
    let Json::Obj(mut fields) = live_envelope(0, HASH_B) else { unreachable!() };
    set(&mut fields, "document_hash", Json::Null);
    set(&mut fields, "source_set_hash", Json::Null);
    set(&mut fields, "observed_ms", Json::Null);
    // Generation 0 with composer authority is a contradiction.
    assert!(parse_envelope(&Json::Obj(fields.clone()), &TABS).is_err());

    set(&mut fields, "authority", json::s("none"));
    let batch = parse_envelope(&Json::Obj(fields.clone()), &TABS).expect("envelope");
    assert_eq!(batch.generation, None);
    assert_eq!(batch.posture, Posture::Unavailable);

    // A live episode that drops provenance is refused rather than downgraded.
    set(&mut fields, "executive_generation", Json::Int(3));
    assert_eq!(
        parse_envelope(&Json::Obj(fields), &TABS).expect_err("refusal").0,
        "ae-executive-document-provenance"
    );
}

#[test]
fn a_composer_batch_may_not_also_report_a_blocker() {
    let Json::Obj(mut fields) = live_envelope(2, HASH_B) else { unreachable!() };
    set(
        &mut fields,
        "blocker",
        json::obj(vec![
            ("code", json::s("held")),
            ("boundary", json::s("run")),
            ("closed", Json::Bool(true)),
        ]),
    );
    assert_eq!(
        parse_envelope(&Json::Obj(fields.clone()), &TABS).expect_err("refusal").0,
        "ae-executive-document-authority"
    );

    set(&mut fields, "authority", json::s("none"));
    let batch = parse_envelope(&Json::Obj(fields), &TABS).expect("envelope");
    assert_eq!(batch.posture, Posture::Degraded);
}

#[test]
fn reconcile_refuses_regression_and_accepts_forward_motion() {
    let first = parsed(2, HASH_B);
    assert!(reconcile(None, first.clone()).accepted);

    for (label, incoming, reason) in [
        ("older generation", parsed(1, HASH_C), "out-of-order-generation"),
        ("same hash", parsed(3, HASH_B), "generation-hash-conflict"),
    ] {
        let outcome = reconcile(Some(&first), incoming);
        assert!(!outcome.accepted, "{label}");
        assert_eq!(outcome.reason, reason, "{label}");
        assert_eq!(outcome.batch.generation, Some(2));
    }

    let forward = reconcile(Some(&first), parsed(3, HASH_C));
    assert!(forward.accepted);
    assert_eq!(forward.batch.generation, Some(3));

    let duplicate = reconcile(Some(&first), parsed(2, HASH_B));
    assert!(duplicate.accepted);
    assert_eq!(duplicate.reason, "duplicate");
}

#[test]
fn reconcile_refuses_a_conflicting_or_authority_losing_repeat_generation() {
    let first = parsed(2, HASH_B);

    let mut conflicting = parsed(2, HASH_B);
    conflicting.freshness = "degraded".to_string();
    let outcome = reconcile(Some(&first), conflicting);
    assert!(!outcome.accepted);
    assert_eq!(outcome.reason, "same-generation-conflict");

    let mut downgraded = parsed(2, HASH_B);
    downgraded.authority = "none".to_string();
    let outcome = reconcile(Some(&first), downgraded);
    assert!(!outcome.accepted);
    assert_eq!(outcome.reason, "authority-regression");

    let mut upgraded = parsed(2, HASH_B);
    upgraded.authority = "none".to_string();
    let outcome = reconcile(Some(&upgraded), first.clone());
    assert!(outcome.accepted);
    assert_eq!(outcome.batch.authority, "RUN_EXECUTIVE_COMPOSER");

    let mut rebuilt = parsed(3, HASH_C);
    rebuilt.artifact_generation = HASH_C.to_string();
    let outcome = reconcile(Some(&first), rebuilt);
    assert!(!outcome.accepted);
    assert_eq!(outcome.reason, "artifact-generation-conflict");
}

#[test]
fn a_newer_generation_carries_forward_the_last_good_document_per_tab() {
    let first = parsed(2, HASH_B);
    let rows = vec![
        row("home", "missing", "fresh", Json::Null),
        row("dashboard", "observed", "fresh", document("dashboard-next")),
    ];
    let incoming = parse_envelope(&envelope(3, HASH_C, rows), &TABS).expect("envelope");

    let outcome = reconcile(Some(&first), incoming);
    assert!(outcome.accepted);

    let home = outcome.batch.row("home").expect("home row");
    assert!(home.preserved, "a tab that went missing keeps its last good document");
    assert_eq!(home.document.as_ref().and_then(|value| value.get("id")), Some(&json::s("home")));

    let dashboard = outcome.batch.row("dashboard").expect("dashboard row");
    assert!(!dashboard.preserved);
    assert_eq!(
        dashboard.document.as_ref().and_then(|value| value.get("id")),
        Some(&json::s("dashboard-next"))
    );
}

#[test]
fn an_unavailable_incoming_batch_never_replaces_a_live_one() {
    let live = parsed(2, HASH_B);
    let Json::Obj(mut fields) = live_envelope(0, HASH_B) else { unreachable!() };
    set(&mut fields, "authority", json::s("none"));
    set(&mut fields, "document_hash", Json::Null);
    set(&mut fields, "source_set_hash", Json::Null);
    set(&mut fields, "observed_ms", Json::Null);
    let dark = parse_envelope(&Json::Obj(fields), &TABS).expect("envelope");

    let outcome = reconcile(Some(&live), dark);
    assert!(!outcome.accepted);
    assert_eq!(outcome.reason, "unavailable-episode-not-live");
    assert_eq!(outcome.batch.generation, Some(2));
}

#[test]
fn the_batch_projects_a_host_readable_receipt_without_leaking_documents() {
    let encoded = json::canonical_string(&parsed(2, HASH_B).to_json());
    assert!(encoded.contains("\"posture\":\"live\""));
    assert!(encoded.contains("\"hasDocument\":true"));
    // The receipt reports availability; documents cross only through paint.
    assert!(!encoded.contains("\"sections\""));
}

fn set(fields: &mut Vec<(String, Json)>, key: &str, value: Json) {
    match fields.iter_mut().find(|(name, _)| name == key) {
        Some((_, slot)) => *slot = value,
        None => fields.push((key.to_string(), value)),
    }
}

#[test]
fn an_envelope_or_row_with_unknown_or_missing_fields_is_refused() {
    let Json::Obj(mut fields) = live_envelope(2, HASH_B) else { unreachable!() };

    set(&mut fields, "smuggled", json::s("extra"));
    assert!(parse_envelope(&Json::Obj(fields.clone()), &TABS).is_err(), "unknown envelope field");

    fields.retain(|(name, _)| name != "smuggled" && name != "admission_code");
    assert!(parse_envelope(&Json::Obj(fields), &TABS).is_err(), "missing envelope field");

    let Json::Obj(mut row_fields) = row("home", "observed", "fresh", document("home")) else {
        unreachable!()
    };

    set(&mut row_fields, "smuggled", json::s("extra"));
    let rows = vec![Json::Obj(row_fields), row("dashboard", "observed", "fresh", document("dashboard"))];
    assert_eq!(
        parse_envelope(&envelope(2, HASH_B, rows), &TABS).expect_err("refusal").0,
        "ae-executive-document-row:home"
    );
}
