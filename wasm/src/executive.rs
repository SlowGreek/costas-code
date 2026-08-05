//! Catalyst's executive envelope, owned by the engine.
//!
//! Admission, freshness posture, and batch reconciliation used to live in
//! TypeScript beside a second document validator. They are not host concerns:
//! every UGUI client admits and reconciles the same way, so the rules live here
//! and hosts only carry bytes.

use ugui_render::json::{self, Json};

pub const ENVELOPE_SCHEMA: &str = "ae-executive-document-envelope/1";
pub const ROW_SCHEMA: &str = "ae-executive-document-row/1";

const FRESHNESS: [&str; 4] = ["fresh", "degraded", "stale", "unavailable"];
const POSTURES: [&str; 6] =
    ["observed", "missing", "fixture", "held", "structural", "unavailable"];
const AUTHORITIES: [&str; 2] = ["none", "RUN_EXECUTIVE_COMPOSER"];
const RUN_COMPOSER: &str = "RUN_EXECUTIVE_COMPOSER";
const MAX_TEXT: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Fault(pub String);

impl Fault {
    fn new(code: impl Into<String>) -> Self {
        Self(code.into())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RowState {
    Fresh,
    Stale,
    Unavailable,
    Fixture,
    Structural,
}

impl RowState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Stale => "stale",
            Self::Unavailable => "unavailable",
            Self::Fixture => "fixture",
            Self::Structural => "structural",
        }
    }

    fn preserves_prior_document(self) -> bool {
        matches!(self, Self::Stale | Self::Unavailable)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Posture {
    Live,
    Degraded,
    Stale,
    Unavailable,
}

impl Posture {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Degraded => "degraded",
            Self::Stale => "stale",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Blocker {
    pub code: String,
    pub boundary: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub tab: String,
    pub source_hash: Option<String>,
    pub source_generation: i64,
    pub observed_ms: Option<i64>,
    pub freshness: String,
    pub posture: String,
    pub artifact_posture: String,
    pub document: Option<Json>,
    pub code: Option<String>,
    pub state: RowState,
    pub preserved: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Batch {
    pub authority: String,
    pub generation: Option<i64>,
    pub document_hash: Option<String>,
    pub source_set_hash: Option<String>,
    pub observed_ms: Option<i64>,
    pub freshness: String,
    pub artifact_generation: String,
    pub posture: Posture,
    pub artifact_posture: String,
    pub admission_code: String,
    pub blocker: Option<Blocker>,
    pub rows: Vec<Row>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Reconciliation {
    pub accepted: bool,
    pub reason: &'static str,
    pub batch: Batch,
}

fn is_hash(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn safe_text(value: &Json) -> Option<String> {
    let text = value.as_str()?;
    (!text.is_empty() && text.len() <= MAX_TEXT && !text.chars().any(char::is_control))
        .then(|| text.to_owned())
}

/// JSON has one number type; an executive generation that arrived as `2.5` is
/// not a generation, so fractional values are refused rather than truncated.
fn safe_integer(value: &Json) -> Option<i64> {
    match value {
        Json::Int(number) => Some(*number),
        Json::Num(number) if number.fract() == 0.0 && number.is_finite() => Some(*number as i64),
        _ => None,
    }
}

fn non_negative(value: &Json) -> Option<i64> {
    safe_integer(value).filter(|number| *number >= 0)
}

fn field<'a>(value: &'a Json, key: &str) -> &'a Json {
    value.get(key).unwrap_or(&Json::Null)
}

fn optional_hash(value: &Json, fault: &str) -> Result<Option<String>, Fault> {
    match value {
        Json::Null => Ok(None),
        other => match other.as_str() {
            Some(text) if is_hash(text) => Ok(Some(text.to_owned())),
            _ => Err(Fault::new(fault)),
        },
    }
}

fn one_of(value: &Json, admitted: &[&str]) -> Option<String> {
    let text = value.as_str()?;
    admitted.contains(&text).then(|| text.to_owned())
}

fn parse_blocker(value: &Json) -> Result<Option<Blocker>, Fault> {
    if matches!(value, Json::Null) {
        return Ok(None);
    }
    let fault = || Fault::new("ae-executive-document-blocker");
    let code = safe_text(field(value, "code")).ok_or_else(fault)?;
    let boundary = safe_text(field(value, "boundary")).ok_or_else(fault)?;
    if field(value, "closed").as_bool() != Some(true) {
        return Err(fault());
    }
    Ok(Some(Blocker { code, boundary }))
}

fn row_state(posture: &str, freshness: &str, document: Option<&Json>) -> RowState {
    if document.is_none() || matches!(posture, "missing" | "held" | "unavailable") {
        return RowState::Unavailable;
    }
    match posture {
        "fixture" => RowState::Fixture,
        "structural" => RowState::Structural,
        _ if freshness == "stale" => RowState::Stale,
        _ => RowState::Fresh,
    }
}

fn parse_row(value: &Json, expected_tab: &str) -> Result<Row, Fault> {
    let fault = || Fault::new(format!("ae-executive-document-row:{expected_tab}"));
    if field(value, "schema").as_str() != Some(ROW_SCHEMA)
        || field(value, "tab").as_str() != Some(expected_tab)
    {
        return Err(fault());
    }

    let source_generation = non_negative(field(value, "source_generation")).ok_or_else(fault)?;
    let source_hash = optional_hash(field(value, "source_hash"), "").map_err(|_| fault())?;
    let observed_ms = match field(value, "observed_ms") {
        Json::Null => None,
        other => Some(non_negative(other).ok_or_else(fault)?),
    };
    let freshness = one_of(field(value, "freshness"), &FRESHNESS).ok_or_else(fault)?;
    let posture = one_of(field(value, "posture"), &POSTURES).ok_or_else(fault)?;
    let artifact_posture = one_of(field(value, "artifact_posture"), &POSTURES).ok_or_else(fault)?;
    let code = match field(value, "code") {
        Json::Null => None,
        other => Some(safe_text(other).ok_or_else(fault)?),
    };

    let document = match field(value, "document") {
        Json::Null => None,
        candidate => {
            // The engine's own contract admits the document; the host does not
            // carry a second vocabulary that can drift from it.
            let faults = ugui_render::validate_document_value(candidate);
            if faults != "[]" {
                return Err(Fault::new(format!("ae-executive-document:{expected_tab}")));
            }
            Some(candidate.clone())
        }
    };

    let state = row_state(&posture, &freshness, document.as_ref());
    Ok(Row {
        tab: expected_tab.to_owned(),
        source_hash,
        source_generation,
        observed_ms,
        freshness,
        posture,
        artifact_posture,
        document,
        code,
        state,
        preserved: false,
    })
}

pub fn parse_envelope(value: &Json, tabs: &[&str]) -> Result<Batch, Fault> {
    let fault = || Fault::new("ae-executive-document-envelope");
    if field(value, "schema").as_str() != Some(ENVELOPE_SCHEMA) {
        return Err(fault());
    }

    let authority = one_of(field(value, "authority"), &AUTHORITIES).ok_or_else(fault)?;
    let executive_generation =
        non_negative(field(value, "executive_generation")).ok_or_else(fault)?;
    let freshness = one_of(field(value, "freshness"), &FRESHNESS).ok_or_else(fault)?;
    let artifact_posture = one_of(field(value, "artifact_posture"), &POSTURES).ok_or_else(fault)?;
    let admission_code = safe_text(field(value, "admission_code")).ok_or_else(fault)?;
    let artifact_generation = field(value, "artifact_generation")
        .as_str()
        .filter(|text| is_hash(text))
        .ok_or_else(fault)?
        .to_owned();
    let rows = field(value, "rows").as_array().filter(|rows| rows.len() == tabs.len()).ok_or_else(fault)?;

    let live = executive_generation > 0;
    let provenance = || Fault::new("ae-executive-document-provenance");
    let (document_hash, source_set_hash, observed_ms) = if live {
        (
            optional_hash(field(value, "document_hash"), "").map_err(|_| provenance())?,
            optional_hash(field(value, "source_set_hash"), "").map_err(|_| provenance())?,
            Some(non_negative(field(value, "observed_ms")).ok_or_else(provenance)?),
        )
    } else {
        for key in ["document_hash", "source_set_hash", "observed_ms"] {
            if !matches!(field(value, key), Json::Null) {
                return Err(provenance());
            }
        }
        (None, None, None)
    };
    if live && (document_hash.is_none() || source_set_hash.is_none()) {
        return Err(provenance());
    }

    let blocker = parse_blocker(field(value, "blocker"))?;
    if (!live && authority != "none") || (authority == RUN_COMPOSER && blocker.is_some()) {
        return Err(Fault::new("ae-executive-document-authority"));
    }

    let rows = rows
        .iter()
        .zip(tabs.iter())
        .map(|(row, tab)| parse_row(row, tab))
        .collect::<Result<Vec<_>, _>>()?;

    let posture = if !live || freshness == "unavailable" {
        Posture::Unavailable
    } else if blocker.is_some() || freshness == "degraded" {
        Posture::Degraded
    } else if freshness == "stale" {
        Posture::Stale
    } else {
        Posture::Live
    };

    Ok(Batch {
        authority,
        generation: live.then_some(executive_generation),
        document_hash,
        source_set_hash,
        observed_ms,
        freshness,
        artifact_generation,
        posture,
        artifact_posture,
        admission_code,
        blocker,
        rows,
    })
}

pub fn reconcile(previous: Option<&Batch>, incoming: Batch) -> Reconciliation {
    let accept = |batch: Batch, reason: &'static str| Reconciliation {
        accepted: true,
        reason,
        batch,
    };
    let refuse = |batch: &Batch, reason: &'static str| Reconciliation {
        accepted: false,
        reason,
        batch: batch.clone(),
    };

    let Some(previous) = previous else {
        return accept(incoming, "accepted");
    };
    let Some(incoming_generation) = incoming.generation else {
        return refuse(previous, "unavailable-episode-not-live");
    };
    let Some(previous_generation) = previous.generation else {
        return accept(incoming, "accepted");
    };
    if incoming.artifact_generation != previous.artifact_generation {
        return refuse(previous, "artifact-generation-conflict");
    }
    if incoming_generation < previous_generation {
        return refuse(previous, "out-of-order-generation");
    }
    if incoming.observed_ms < previous.observed_ms {
        return refuse(previous, "stale-observation");
    }

    if incoming_generation == previous_generation {
        if previous.authority == RUN_COMPOSER && incoming.authority == "none" {
            return refuse(previous, "authority-regression");
        }
        if incoming.document_hash != previous.document_hash
            || incoming.source_set_hash != previous.source_set_hash
            || incoming.observed_ms != previous.observed_ms
            || incoming.freshness != previous.freshness
        {
            return refuse(previous, "same-generation-conflict");
        }
        if previous.authority == "none" && incoming.authority == RUN_COMPOSER {
            return accept(incoming, "accepted");
        }
        return Reconciliation { accepted: true, reason: "duplicate", batch: previous.clone() };
    }

    if incoming.document_hash == previous.document_hash {
        return refuse(previous, "generation-hash-conflict");
    }

    // A newer generation must not blank a tab that merely went stale: the last
    // good document for that tab is carried forward and marked preserved.
    let mut carried = incoming;
    for row in &mut carried.rows {
        if row.document.is_some() && !row.state.preserves_prior_document() {
            continue;
        }
        if let Some(prior) =
            previous.rows.iter().find(|prior| prior.tab == row.tab && prior.document.is_some())
        {
            row.document = prior.document.clone();
            row.preserved = true;
        }
    }
    accept(carried, "accepted")
}

impl Row {
    pub fn to_json(&self) -> Json {
        json::obj(vec![
            ("schema", json::s(ROW_SCHEMA)),
            ("tab", json::s(&self.tab)),
            ("state", json::s(self.state.as_str())),
            ("freshness", json::s(&self.freshness)),
            ("posture", json::s(&self.posture)),
            ("artifactPosture", json::s(&self.artifact_posture)),
            ("sourceGeneration", Json::Int(self.source_generation)),
            ("sourceHash", optional_string(self.source_hash.as_deref())),
            ("observedMs", self.observed_ms.map_or(Json::Null, Json::Int)),
            ("code", optional_string(self.code.as_deref())),
            ("preserved", Json::Bool(self.preserved)),
            ("hasDocument", Json::Bool(self.document.is_some())),
        ])
    }
}

impl Batch {
    pub fn row(&self, tab: &str) -> Option<&Row> {
        self.rows.iter().find(|row| row.tab == tab)
    }

    pub fn document_for_tab(&self, tab: &str) -> Option<&Json> {
        self.row(tab)?.document.as_ref()
    }

    pub fn to_json(&self) -> Json {
        json::obj(vec![
            ("schema", json::s(ENVELOPE_SCHEMA)),
            ("authority", json::s(&self.authority)),
            ("generation", self.generation.map_or(Json::Null, Json::Int)),
            ("documentHash", optional_string(self.document_hash.as_deref())),
            ("sourceSetHash", optional_string(self.source_set_hash.as_deref())),
            ("observedMs", self.observed_ms.map_or(Json::Null, Json::Int)),
            ("freshness", json::s(&self.freshness)),
            ("artifactGeneration", json::s(&self.artifact_generation)),
            ("posture", json::s(self.posture.as_str())),
            ("artifactPosture", json::s(&self.artifact_posture)),
            ("admissionCode", json::s(&self.admission_code)),
            (
                "blocker",
                self.blocker.as_ref().map_or(Json::Null, |blocker| {
                    json::obj(vec![
                        ("code", json::s(&blocker.code)),
                        ("boundary", json::s(&blocker.boundary)),
                        ("closed", Json::Bool(true)),
                    ])
                }),
            ),
            ("rows", Json::Arr(self.rows.iter().map(Row::to_json).collect())),
        ])
    }
}

fn optional_string(value: Option<&str>) -> Json {
    value.map_or(Json::Null, json::s)
}

#[cfg(test)]
#[path = "../tests/unit/executive.rs"]
mod tests;
