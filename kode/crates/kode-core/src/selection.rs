//! Runtime-reported selection, distinct from requested/acknowledged configuration.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SelectionSource {
    CodexTurnContext,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SelectionObservation {
    pub source: SelectionSource,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub turn_id: Option<String>,
    pub session_uuid: Option<String>,
    pub historical: bool,
}
