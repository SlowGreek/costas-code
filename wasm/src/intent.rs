//! LUCID intents, owned by the engine.
//!
//! Which actions exist, which posture admits them, and what an intent looks
//! like on the wire are engine facts. A host that rebuilt them in its own
//! language could silently admit an action the engine would refuse.

use ugui_render::json::{self, Json};

pub const INTENT_SCHEMA: &str = "hermes-lucid-executive-intent/1";

const READ_VERBS: [&str; 2] = ["show", "get"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActionPosture {
    Held,
    Read,
    Ready,
}

impl ActionPosture {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Held => "held",
            Self::Read => "read",
            Self::Ready => "ready",
        }
    }

    fn admits(self, verb: &str) -> bool {
        match self {
            Self::Held => false,
            Self::Read => READ_VERBS.contains(&verb),
            Self::Ready => true,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionContext {
    pub generation: i64,
    pub document_hash: String,
    pub posture: ActionPosture,
}

fn is_hash(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn action_context(batch: &crate::executive::Batch, tab: &str) -> ActionContext {
    let generation = batch.generation.unwrap_or(0);
    let document_hash = batch.document_hash.clone().unwrap_or_default();
    let readable = batch
        .row(tab)
        .is_some_and(|row| row.state == crate::executive::RowState::Fresh && row.document.is_some());
    let admitted = generation > 0 && is_hash(&document_hash) && readable;
    ActionContext {
        generation: if generation > 0 { generation } else { 0 },
        document_hash: if is_hash(&document_hash) { document_hash } else { String::new() },
        posture: if admitted { ActionPosture::Read } else { ActionPosture::Held },
    }
}

/// The closed set of actions this engine emits. Anything else is not an intent.
pub fn action_for_handler(action: &str) -> Option<(&'static str, Json)> {
    let payload = |fields: Vec<(&str, Json)>| json::obj(fields);
    let exact = match action {
        "lucid.show.projects" => ("show", payload(vec![("kind", json::s("projects"))])),
        "lucid.show.status" => ("show", payload(vec![("kind", json::s("status"))])),
        "lucid.get.evidence" => ("get", payload(vec![("kind", json::s("evidence"))])),
        "lucid.get.posture" => ("get", payload(vec![("kind", json::s("posture"))])),
        "lucid.set.view-policy" => (
            "set",
            payload(vec![("kind", json::s("view-policy")), ("value", json::s("balanced"))]),
        ),
        "lucid.set.view-policy.compact" => (
            "set",
            payload(vec![("kind", json::s("view-policy")), ("value", json::s("compact"))]),
        ),
        "lucid.morph.fidelity" => (
            "morph",
            payload(vec![("kind", json::s("fidelity")), ("value", json::s("balanced"))]),
        ),
        "lucid.morph.fidelity.lossless" => (
            "morph",
            payload(vec![("kind", json::s("fidelity")), ("value", json::s("lossless"))]),
        ),
        "lucid.steer.hold.em" => (
            "steer",
            payload(vec![
                ("kind", json::s("role")),
                ("action", json::s("hold")),
                ("scope", json::s("role:em")),
            ]),
        ),
        "lucid.steer.hold.sidekick" => (
            "steer",
            payload(vec![
                ("kind", json::s("role")),
                ("action", json::s("hold")),
                ("scope", json::s("role:sidekick")),
            ]),
        ),
        _ => return parametric_action(action),
    };
    Some(exact)
}

fn parametric_action(action: &str) -> Option<(&'static str, Json)> {
    if let Some(id) = action.strip_prefix("lucid.dispatch.plan:") {
        return is_hex64(id).then(|| {
            (
                "dispatch",
                json::obj(vec![
                    ("kind", json::s("plan")),
                    ("id", json::s(&format!("plan:{id}"))),
                ]),
            )
        });
    }
    let rest = action.strip_prefix("lucid.cancel.execution:")?;
    let (id, mode) = rest.split_once(':')?;
    (is_hex64(id) && matches!(mode, "graceful" | "immediate")).then(|| {
        (
            "cancel",
            json::obj(vec![
                ("kind", json::s("execution")),
                ("id", json::s(&format!("dispatch:{id}"))),
                ("mode", json::s(mode)),
            ]),
        )
    })
}

pub fn build_intent(action: &str, context: &ActionContext, operation_id: &str) -> Option<Json> {
    let (verb, payload) = action_for_handler(action)?;
    if !admits(context, verb) {
        return None;
    }
    Some(json::obj(vec![
        ("schema", json::s(INTENT_SCHEMA)),
        ("verb", json::s(verb)),
        ("payload", payload),
        ("expected_generation", Json::Int(context.generation)),
        ("expected_document_hash", json::s(&context.document_hash)),
        ("operation_id", json::s(operation_id)),
    ]))
}

fn admits(context: &ActionContext, verb: &str) -> bool {
    context.generation >= 1 && is_hash(&context.document_hash) && context.posture.admits(verb)
}

/// Disable every `lucid.` action the posture would refuse, so a document is
/// never painted offering an affordance the engine will not honour.
pub fn apply_posture(document: &Json, context: &ActionContext) -> Json {
    match document {
        Json::Arr(items) => {
            Json::Arr(items.iter().map(|item| apply_posture(item, context)).collect())
        }
        Json::Obj(fields) => {
            let mut mapped = fields
                .iter()
                .map(|(key, value)| (key.clone(), apply_posture(value, context)))
                .collect::<Vec<_>>();
            let action = fields
                .iter()
                .find(|(key, _)| key == "action")
                .and_then(|(_, value)| value.as_str())
                .unwrap_or_default();
            if !action.starts_with("lucid.") {
                return Json::Obj(mapped);
            }
            let enabled = action_for_handler(action)
                .is_some_and(|(verb, _)| admits(context, verb));
            if !enabled {
                mapped.push(("disabled".to_string(), Json::Bool(true)));
                mapped.push((
                    "disabled_reason".to_string(),
                    json::s(match context.posture {
                        ActionPosture::Read => "owner-capability-required",
                        _ => "authority-held",
                    }),
                ));
            }
            Json::Obj(mapped)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
#[path = "../tests/unit/intent.rs"]
mod tests;
