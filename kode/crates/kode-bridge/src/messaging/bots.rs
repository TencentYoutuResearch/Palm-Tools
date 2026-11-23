//! Bots ("伙伴"): named, long-lived agents the user sets up once. A bot is a
//! session template with an identity: persona, Agent, memory scope and a
//! permission ceiling. Kode owns the identity; extensions (teams, routines,
//! IM) only use it. Stored as one versioned workbench document.
use super::{model::valid_id, Hub};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DOCUMENT: &str = "bots";
const MAX_BOTS: usize = 64;
const MAX_PERSONA_BYTES: usize = 16 * 1024;

/// Least to most permissive. A bot never runs above its ceiling.
pub const PERMISSION_MODES: &[&str] = &["plan", "default", "acceptEdits", "bypassPermissions"];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Bot {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub persona: String,
    /// Agent that runs the bot (a backend key such as `claude`).
    pub backend_key: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default = "default_ceiling")]
    pub permission_ceiling: String,
    #[serde(default)]
    pub default_cwd: Option<String>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

fn default_ceiling() -> String {
    "default".into()
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Roster {
    #[serde(default)]
    pub bots: Vec<Bot>,
    #[serde(default)]
    pub default_bot: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Change {
    Upsert { bot: Bot },
    Delete { id: String },
    SetDefault { id: Option<String> },
}

impl Bot {
    pub fn memory_scope(&self) -> String {
        format!("bot:{}", self.id)
    }

    /// Persona text for the session's system prompt (or first message).
    pub fn persona_prompt(&self) -> String {
        kode_core::session::persona_prompt(&self.name, &self.persona, &self.memory_scope())
    }

    /// What extensions may see: identity and limits, not the persona text.
    pub fn public(&self, default: bool) -> Value {
        json!({
            "id": self.id, "name": self.name, "avatar": self.avatar,
            "backend_key": self.backend_key, "model": self.model,
            "permission_ceiling": self.permission_ceiling, "memory_scope": self.memory_scope(),
            "default": default,
        })
    }

    fn validate(&self) -> Result<()> {
        let name = self.name.trim();
        if name.is_empty() || name.chars().count() > 80 {
            bail!("bot name must have 1 to 80 characters")
        }
        if self.persona.len() > MAX_PERSONA_BYTES {
            bail!("persona must stay under 16 KiB")
        }
        if !valid_id(&self.backend_key) {
            bail!("invalid backend_key")
        }
        if !PERMISSION_MODES.contains(&self.permission_ceiling.as_str()) {
            bail!("permission_ceiling must be one of {}", PERMISSION_MODES.join(", "))
        }
        if self.default_cwd.as_deref().is_some_and(|cwd| !std::path::Path::new(cwd).is_absolute()) {
            bail!("default_cwd must be an absolute path")
        }
        if self.avatar.as_ref().is_some_and(|a| a.len() > 256) || self.model.as_ref().is_some_and(|m| m.len() > 160) {
            bail!("avatar or model is too long")
        }
        Ok(())
    }
}

fn rank(mode: &str) -> Option<usize> {
    PERMISSION_MODES.iter().position(|m| *m == mode)
}

/// The mode a bot session starts in: the request, or `default`, but never
/// above the ceiling. Asking for more than the ceiling is refused, not
/// silently lowered, so a caller cannot mistake a plan-only bot for a writer.
pub fn effective_permission(requested: Option<&str>, ceiling: &str) -> Result<String> {
    let ceiling_rank = rank(ceiling).context("invalid permission ceiling")?;
    let requested = match requested {
        Some("bypass") => "bypassPermissions",
        Some(mode) => mode,
        None => return Ok(PERMISSION_MODES[ceiling_rank.min(1)].into()),
    };
    let requested_rank = rank(requested).context("unsupported permission mode")?;
    if requested_rank > ceiling_rank {
        bail!("this bot is limited to {ceiling}")
    }
    Ok(requested.into())
}

pub fn roster(hub: &Hub) -> Result<(u64, Roster)> {
    let document = hub.store.document(DOCUMENT)?;
    let revision = document["revision"].as_u64().unwrap_or(0);
    let value = &document["value"];
    let roster = if value.is_null() { Roster::default() } else { serde_json::from_value(value.clone())? };
    Ok((revision, roster))
}

pub fn change(hub: &Hub, change: Change) -> Result<Roster> {
    let _gate = hub.gate.lock();
    let (revision, mut roster) = roster(hub)?;
    apply(&mut roster, change, crate::now_ms())?;
    hub.store.save_document(DOCUMENT, revision, serde_json::to_value(&roster)?)?;
    Ok(roster)
}

fn apply(roster: &mut Roster, change: Change, now: u64) -> Result<()> {
    match change {
        Change::Upsert { mut bot } => {
            bot.name = bot.name.trim().into();
            bot.validate()?;
            bot.updated_at = now;
            if let Some(existing) = roster.bots.iter_mut().find(|b| !bot.id.is_empty() && b.id == bot.id) {
                bot.created_at = existing.created_at;
                *existing = bot;
            } else {
                if !bot.id.is_empty() {
                    bail!("unknown bot")
                }
                if roster.bots.len() >= MAX_BOTS {
                    bail!("at most {MAX_BOTS} bots")
                }
                bot.id = format!("bot_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
                bot.created_at = now;
                // The first bot becomes "my assistant" until the user picks another.
                if roster.default_bot.is_none() {
                    roster.default_bot = Some(bot.id.clone());
                }
                roster.bots.push(bot);
            }
        }
        Change::Delete { id } => {
            let before = roster.bots.len();
            roster.bots.retain(|b| b.id != id);
            if roster.bots.len() == before {
                bail!("unknown bot")
            }
            if roster.default_bot.as_deref() == Some(id.as_str()) {
                roster.default_bot = None;
            }
        }
        Change::SetDefault { id } => {
            if id.as_ref().is_some_and(|id| !roster.bots.iter().any(|b| &b.id == id)) {
                bail!("unknown bot")
            }
            roster.default_bot = id;
        }
    }
    Ok(())
}

/// A bot by id, or the user's default bot for `"default"`.
pub fn resolve(hub: &Hub, id: &str) -> Result<Bot> {
    let (_, roster) = roster(hub)?;
    let id = if id == "default" {
        roster.default_bot.clone().context("no default bot yet; create one in Kode first")?
    } else {
        id.to_owned()
    };
    roster.bots.into_iter().find(|b| b.id == id).context("unknown bot")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(name: &str) -> Bot {
        serde_json::from_value(json!({"name":name,"backend_key":"claude","persona":"Reviews code."})).unwrap()
    }

    #[test]
    fn first_bot_becomes_default_and_deleting_it_clears_the_default() {
        let mut roster = Roster::default();
        apply(&mut roster, Change::Upsert { bot: bot(" Kit ") }, 1).unwrap();
        apply(&mut roster, Change::Upsert { bot: bot("Rex") }, 2).unwrap();
        let kit = roster.bots[0].clone();
        assert_eq!(kit.name, "Kit");
        assert!(kit.id.starts_with("bot_"));
        assert_eq!(roster.default_bot.as_deref(), Some(kit.id.as_str()));
        let mut renamed = kit.clone();
        renamed.name = "Kit 2".into();
        apply(&mut roster, Change::Upsert { bot: renamed }, 3).unwrap();
        assert_eq!((roster.bots[0].created_at, roster.bots[0].updated_at), (1, 3));
        apply(&mut roster, Change::Delete { id: kit.id.clone() }, 4).unwrap();
        assert_eq!(roster.default_bot, None);
        assert!(apply(&mut roster, Change::SetDefault { id: Some(kit.id) }, 5).is_err());
        let mut forged = bot("Ghost");
        forged.id = "bot_forged".into();
        assert!(apply(&mut roster, Change::Upsert { bot: forged }, 6).is_err(), "callers cannot choose ids");
    }

    #[test]
    fn invalid_bots_are_rejected() {
        let mut roster = Roster::default();
        for patch in [json!({"name":""}), json!({"permission_ceiling":"root"}), json!({"default_cwd":"relative"}), json!({"backend_key":"a b"})] {
            let mut value = serde_json::to_value(bot("Kit")).unwrap();
            for (k, v) in patch.as_object().unwrap() {
                value[k] = v.clone();
            }
            let candidate: Bot = serde_json::from_value(value).unwrap();
            assert!(apply(&mut roster, Change::Upsert { bot: candidate }, 1).is_err(), "{patch}");
        }
    }

    #[test]
    fn permission_never_exceeds_the_ceiling() {
        assert_eq!(effective_permission(None, "plan").unwrap(), "plan");
        assert_eq!(effective_permission(None, "bypassPermissions").unwrap(), "default");
        assert_eq!(effective_permission(Some("bypass"), "bypassPermissions").unwrap(), "bypassPermissions");
        assert_eq!(effective_permission(Some("plan"), "acceptEdits").unwrap(), "plan");
        assert!(effective_permission(Some("acceptEdits"), "default").is_err());
        assert!(effective_permission(Some("sudo"), "bypassPermissions").is_err());
    }

    #[test]
    fn extensions_see_identity_but_not_the_persona() {
        let mut kit = bot("Kit");
        kit.id = "bot_kit".into();
        let public = kit.public(true);
        assert_eq!(public["memory_scope"], "bot:bot_kit");
        assert!(public.get("persona").is_none());
        assert!(kit.persona_prompt().contains("Reviews code.") && kit.persona_prompt().contains("bot:bot_kit"));
    }
}
