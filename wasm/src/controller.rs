//! Catalyst's controller: the same shape `projects/` proved out.
//!
//! The host holds element handles and enacts typed effects. Every decision —
//! what was admitted, which tab is selected, what a gesture means, what may
//! leave the client — is made here.

use crate::executive::{self, Batch};
use crate::intent;
use ugui_render::json::{self, Json};

#[derive(Default)]
pub struct Controller {
    tabs: Vec<String>,
    batch: Option<Batch>,
    tab: Option<String>,
}

/// One typed effect for the host to enact. The host never decides these.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Effect {
    SelectTab(String),
    Repaint,
    Intent(String),
    StudioSubmit { event: String, revision: i64, document_hash: String },
    Refused { code: String, detail: String },
}

impl Effect {
    fn to_json(&self) -> Json {
        match self {
            Self::SelectTab(tab) => {
                json::obj(vec![("kind", json::s("tab.select")), ("tab", json::s(tab))])
            }
            Self::Repaint => json::obj(vec![("kind", json::s("paint"))]),
            Self::Intent(encoded) => json::obj(vec![
                ("kind", json::s("lucid.intent")),
                ("intent", json::parse(encoded).unwrap_or(Json::Null)),
            ]),
            Self::StudioSubmit { event, revision, document_hash } => json::obj(vec![
                ("kind", json::s("studio.submit")),
                ("event", json::parse(event).unwrap_or(Json::Null)),
                ("revision", Json::Int(*revision)),
                ("documentHash", json::s(document_hash)),
            ]),
            Self::Refused { code, detail } => json::obj(vec![
                ("kind", json::s("refused")),
                ("code", json::s(code)),
                ("detail", json::s(detail)),
            ]),
        }
    }
}

impl Controller {
    pub fn new(tabs: Vec<String>) -> Self {
        let tab = tabs.first().cloned();
        Self { tabs, batch: None, tab }
    }

    pub fn selected_tab(&self) -> Option<&str> {
        self.tab.as_deref()
    }

    pub fn batch(&self) -> Option<&Batch> {
        self.batch.as_ref()
    }

    pub fn selected_document(&self) -> Option<&Json> {
        self.batch.as_ref()?.document_for_tab(self.tab.as_deref()?)
    }

    /// What the host must paint: the admitted document with posture applied, so
    /// no refused affordance is ever offered.
    pub fn painted_document(&self) -> Option<Json> {
        let document = self.selected_document()?;
        let batch = self.batch.as_ref()?;
        let context = intent::action_context(batch, self.tab.as_deref().unwrap_or_default());
        Some(intent::apply_posture(document, &context))
    }

    /// The exact editor revision a studio submission must carry.
    pub fn studio_context(&self) -> Option<(i64, String)> {
        let row = self.batch.as_ref()?.row(self.tab.as_deref()?)?;
        let hash = row.source_hash.clone()?;
        (row.document.is_some() && row.source_generation >= 0)
            .then_some((row.source_generation, hash))
    }

    pub fn observe(&mut self, envelope_json: &str) -> Json {
        let Some(value) = json::parse(envelope_json) else {
            return refusal("E_CATALYST_EXECUTIVE_ENVELOPE", "envelope is not valid JSON");
        };
        let tabs = self.tabs.iter().map(String::as_str).collect::<Vec<_>>();
        let incoming = match executive::parse_envelope(&value, &tabs) {
            Ok(batch) => batch,
            Err(fault) => return refusal("E_CATALYST_EXECUTIVE_ENVELOPE", &fault.0),
        };
        let outcome = executive::reconcile(self.batch.as_ref(), incoming);
        let changed = self.batch.as_ref() != Some(&outcome.batch);
        self.batch = Some(outcome.batch);
        json::obj(vec![
            ("schema", json::s("catalyst-executive-observation/1")),
            ("accepted", Json::Bool(outcome.accepted)),
            ("reason", json::s(outcome.reason)),
            ("batch", self.batch.as_ref().map_or(Json::Null, Batch::to_json)),
            (
                "effects",
                Json::Arr(if changed { vec![Effect::Repaint.to_json()] } else { Vec::new() }),
            ),
        ])
    }

    pub fn select(&mut self, tab: &str) -> Json {
        if !self.tabs.iter().any(|known| known == tab) {
            return refusal("E_CATALYST_EXECUTIVE_TAB", "tab is not admitted");
        }
        let changed = self.tab.as_deref() != Some(tab);
        self.tab = Some(tab.to_owned());
        json::obj(vec![
            ("schema", json::s("catalyst-executive-selection/1")),
            ("tab", json::s(tab)),
            (
                "effects",
                Json::Arr(if changed { vec![Effect::Repaint.to_json()] } else { Vec::new() }),
            ),
        ])
    }

    /// A gesture becomes typed effects here, so the host never pattern-matches
    /// action strings to decide what a click means.
    pub fn dispatch_action(&mut self, action: &str, operation_id: &str) -> Json {
        let mut effects = Vec::new();
        if let Some(tab) = action.strip_prefix("shell.tab.") {
            if self.tabs.iter().any(|known| known == tab) {
                self.tab = Some(tab.to_owned());
                effects.push(Effect::SelectTab(tab.to_owned()));
                effects.push(Effect::Repaint);
            } else {
                effects.push(Effect::Refused {
                    code: "E_CATALYST_EXECUTIVE_TAB".to_string(),
                    detail: tab.to_string(),
                });
            }
        } else if let Some(batch) = self.batch.as_ref() {
            let context = intent::action_context(batch, self.tab.as_deref().unwrap_or_default());
            match intent::build_intent(action, &context, operation_id) {
                Some(built) => effects.push(Effect::Intent(json::canonical_string(&built))),
                None => effects.push(Effect::Refused {
                    code: "E_CATALYST_LUCID_ACTION".to_string(),
                    detail: context.posture.as_str().to_string(),
                }),
            }
        } else {
            effects.push(Effect::Refused {
                code: "E_CATALYST_EXECUTIVE_ENVELOPE".to_string(),
                detail: "no admitted batch".to_string(),
            });
        }

        json::obj(vec![
            ("schema", json::s("catalyst-executive-dispatch/1")),
            ("action", json::s(action)),
            ("effects", Json::Arr(effects.iter().map(Effect::to_json).collect())),
        ])
    }

    /// Route one painted-document event. Studio edits carry their revision from
    /// the admitted row rather than from anything the host reconstructs.
    pub fn dispatch_event(&mut self, event_json: &str, operation_id: &str) -> Json {
        let Some(event) = json::parse(event_json) else {
            return refusal("E_CATALYST_UGUI_EVENT", "event is not valid JSON");
        };
        let action = event.get("action").and_then(Json::as_str).unwrap_or_default().to_owned();
        if self.tab.as_deref() == Some("studio") && !action.starts_with("shell.tab.") {
            let effect = match self.studio_context() {
                Some((revision, document_hash)) => {
                    Effect::StudioSubmit { event: event_json.to_owned(), revision, document_hash }
                }
                None => Effect::Refused {
                    code: "E_CATALYST_STUDIO_REVISION".to_string(),
                    detail: "editor revision or hash unavailable".to_string(),
                },
            };
            return json::obj(vec![
                ("schema", json::s("catalyst-executive-dispatch/1")),
                ("action", json::s(&action)),
                ("effects", Json::Arr(vec![effect.to_json()])),
            ]);
        }
        self.dispatch_action(&action, operation_id)
    }
}

pub fn refusal(code: &str, detail: &str) -> Json {
    json::obj(vec![
        ("schema", json::s("catalyst-ugui-refusal/1")),
        ("error", json::s(code)),
        ("detail", json::s(detail)),
    ])
}

#[cfg(test)]
#[path = "../tests/unit/controller.rs"]
mod tests;
