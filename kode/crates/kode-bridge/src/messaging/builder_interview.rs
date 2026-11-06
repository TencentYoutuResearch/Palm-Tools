//! Declarative interview plans. Branching uses explicit answers, never project-text authority.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Questionnaire {
    pub id: String,
    pub version: String,
    pub questions: Vec<Question>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub id: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when_answer: Option<Condition>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    pub question_id: String,
    pub equals: String,
}
impl Questionnaire {
    pub fn validate(&self) -> Result<()> {
        if !super::model::valid_id(&self.id)
            || !super::model::valid_id(&self.version)
            || self.questions.is_empty()
            || self.questions.len() > 128
        {
            bail!("invalid Builder questionnaire")
        }
        let mut previous = HashSet::new();
        for q in &self.questions {
            if !super::model::valid_id(&q.id)
                || previous.contains(&q.id)
                || q.prompt.trim().is_empty()
                || q.prompt.len() > 2048
                || q.prompt.contains('\0')
                || q.when_answer.as_ref().is_some_and(|c| {
                    !previous.contains(&c.question_id)
                        || c.equals.trim().is_empty()
                        || c.equals.len() > 8192
                        || c.equals.contains('\0')
                })
            {
                bail!("invalid Builder question or forward dependency")
            }
            previous.insert(&q.id);
        }
        Ok(())
    }
}
