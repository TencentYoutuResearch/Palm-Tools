//! Bots ("伙伴"): named, long-lived agents the user sets up once. A bot is a
//! session template with an identity: persona, Agent, memory scope and a
//! permission ceiling. Kode owns the identity; extensions (teams, routines,
//! IM) only use it. Stored as one versioned workbench document.
use super::{model::valid_id, Hub};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

const DOCUMENT: &str = "bots";
const MAX_BOTS: usize = 64;
const MAX_PERSONA_BYTES: usize = 16 * 1024;
const MAX_SKILLS: usize = 32;

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
    /// Sidebar/card background style (`auto`, `none`, `preset:<id>`, `color:#rrggbb`, etc.).
    #[serde(default)]
    pub banner: Option<String>,
    #[serde(default)]
    pub persona: String,
    /// One line shown under the name wherever the bot is listed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tagline: Option<String>,
    /// Skills installed into the bot's own folder.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<BotSkill>,
    /// Recommended template the bot was made from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Messages the bot sends outside Kode (WeCom): `direct` (default) or
    /// `draft`, which waits for the user to approve each one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outbound: Option<String>,
    /// Agent that runs the bot (a backend key such as `claude`).
    pub backend_key: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default = "default_ceiling")]
    pub permission_ceiling: String,
    #[serde(default)]
    pub default_cwd: Option<String>,
    /// The bot's long-lived conversation ("main session"): the one its
    /// contact entry opens. Set by the front end that runs it.
    #[serde(default)]
    pub main_session: Option<MainSession>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

/// A skill the front end installed under the bot's folder. Kode records it;
/// the files themselves are the front end's.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BotSkill {
    pub slug: String,
    /// `skillhub` or `local`.
    pub source: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MainSession {
    /// Front end that runs it, such as `dsh`.
    pub runtime: String,
    pub session_id: String,
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
    /// Where bots without their own workspace keep one; default
    /// `~/.kode/plugins/bots`.
    #[serde(default)]
    pub root: Option<String>,
    /// dsh sessions that belong to a bot although they run elsewhere (made
    /// before the bot had its own folder, or moved to it by the user):
    /// session id → bot id.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub adopted: std::collections::BTreeMap<String, String>,
    /// Bot notifications in this local-time window wait and arrive as one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quiet_hours: Option<QuietHours>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct QuietHours {
    /// `HH:MM`; a window may cross midnight (`22:00`–`08:00`).
    pub start: String,
    pub end: String,
}

fn minutes(hhmm: &str) -> Option<u32> {
    let (h, m) = hhmm.split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60 && hhmm.len() == 5).then_some(h * 60 + m)
}

impl QuietHours {
    pub fn validate(&self) -> Result<()> {
        match (minutes(&self.start), minutes(&self.end)) {
            (Some(a), Some(b)) if a != b => Ok(()),
            _ => bail!("免打扰时段要写成 HH:MM，且开始和结束不能相同"),
        }
    }

    /// Is `now` (minutes since local midnight) inside the window?
    pub fn contains(&self, now: u32) -> bool {
        let (Some(start), Some(end)) = (minutes(&self.start), minutes(&self.end)) else { return false };
        if start < end { (start..end).contains(&now) } else { now >= start || now < end }
    }
}

impl Roster {
    pub fn root(&self) -> PathBuf {
        self.root.as_deref().map(PathBuf::from).unwrap_or_else(default_root)
    }
}

pub fn default_root() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).join(".kode/plugins/bots")
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Change {
    Upsert { bot: Bot },
    Delete { id: String },
    SetDefault { id: Option<String> },
    /// Point a bot at its main session, or clear it with `None`.
    SetMainSession { id: String, session: Option<MainSession> },
    /// Move the folder that holds bots' own workspaces (`None` = default).
    SetRoot { root: Option<String> },
    /// File a dsh session under a bot (`id: None` releases it).
    Adopt { session: String, id: Option<String> },
    SetQuietHours { quiet_hours: Option<QuietHours> },
}

impl Bot {
    /// The bot's workspace: its own setting, else a folder of its own under
    /// the roster root. Created on first use.
    pub fn workspace(&self, root: &std::path::Path) -> PathBuf {
        self.default_cwd.as_deref().map(PathBuf::from).unwrap_or_else(|| root.join(&self.id))
    }

    /// The bot's own folder, whatever its workspace: generated assets and
    /// other side sessions live here, apart from every other bot.
    pub fn home(&self, root: &std::path::Path) -> PathBuf {
        root.join(&self.id)
    }

    pub fn ensure_workspace(&self, root: &std::path::Path) -> Result<PathBuf> {
        let path = self.workspace(root);
        std::fs::create_dir_all(&path).with_context(|| format!("cannot create {}", path.display()))?;
        Ok(path)
    }

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
            "id": self.id, "name": self.name, "avatar": self.avatar, "banner": self.banner,
            "tagline": self.tagline, "skills": self.skills.iter().map(|s| &s.slug).collect::<Vec<_>>(),
            "backend_key": self.backend_key, "model": self.model,
            "permission_ceiling": self.permission_ceiling, "memory_scope": self.memory_scope(),
            "main_session": self.main_session,
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
        if self.avatar.as_ref().is_some_and(|a| a.len() > 256)
            || self.banner.as_ref().is_some_and(|b| b.len() > 256 || b.chars().any(|c| c.is_control()))
            || self.model.as_ref().is_some_and(|m| m.len() > 160)
        {
            bail!("avatar, banner, or model is invalid or too long")
        }
        let line = |value: &Option<String>, max: usize| value.as_ref().is_some_and(|v| v.chars().count() > max || v.chars().any(|c| c.is_control()));
        if line(&self.tagline, 120) || line(&self.template, 64) {
            bail!("tagline or template is invalid or too long")
        }
        if self.outbound.as_deref().is_some_and(|mode| !["direct", "draft"].contains(&mode)) {
            bail!("outbound must be direct or draft")
        }
        if self.skills.len() > MAX_SKILLS {
            bail!("at most {MAX_SKILLS} skills")
        }
        let mut seen = std::collections::HashSet::new();
        for skill in &self.skills {
            let slug_ok = !skill.slug.is_empty() && skill.slug.len() <= 128
                && skill.slug.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)) && !skill.slug.starts_with('.');
            if !slug_ok || !seen.insert(skill.slug.as_str()) || !["skillhub", "local"].contains(&skill.source.as_str())
                || skill.name.trim().is_empty() || line(&Some(skill.name.clone()), 120)
                || skill.description.as_ref().is_some_and(|d| d.chars().count() > 1024)
            {
                bail!("invalid skill {}", skill.slug)
            }
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
                // Editing the profile keeps the conversation; only SetMainSession moves it.
                bot.main_session = existing.main_session.clone();
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
            roster.adopted.retain(|_, bot| *bot != id);
        }
        Change::SetMainSession { id, session } => {
            if session.as_ref().is_some_and(|s| !valid_id(&s.runtime) || s.session_id.is_empty() || s.session_id.len() > 160) {
                bail!("invalid main session")
            }
            let bot = roster.bots.iter_mut().find(|b| b.id == id).context("unknown bot")?;
            bot.main_session = session;
            bot.updated_at = now;
        }
        Change::SetRoot { root } => {
            if root.as_deref().is_some_and(|r| !std::path::Path::new(r).is_absolute()) {
                bail!("bots folder must be an absolute path")
            }
            roster.root = root.filter(|r| !r.trim().is_empty());
        }
        Change::Adopt { session, id } => {
            if session.is_empty() || session.len() > 160 || !session.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b)) {
                bail!("invalid session")
            }
            match id {
                Some(id) if roster.bots.iter().any(|b| b.id == id) => {
                    roster.adopted.insert(session, id);
                }
                Some(_) => bail!("unknown bot"),
                None => {
                    roster.adopted.remove(&session);
                }
            }
        }
        Change::SetQuietHours { quiet_hours } => {
            if let Some(quiet) = &quiet_hours {
                quiet.validate()?;
            }
            roster.quiet_hours = quiet_hours;
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
/// A bot and the folder its own workspace lives in.
pub fn resolve(hub: &Hub, id: &str) -> Result<(Bot, PathBuf)> {
    let (_, roster) = roster(hub)?;
    let root = roster.root();
    let id = if id == "default" {
        roster.default_bot.clone().context("no default bot yet; create one in Kode first")?
    } else {
        id.to_owned()
    };
    let bot = roster.bots.into_iter().find(|b| b.id == id).context("unknown bot")?;
    Ok((bot, root))
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
        let rex = roster.bots[0].id.clone();
        let session = MainSession { runtime: "dsh".into(), session_id: "session-1".into() };
        apply(&mut roster, Change::SetMainSession { id: rex.clone(), session: Some(session.clone()) }, 6).unwrap();
        let mut edited = roster.bots[0].clone();
        edited.persona = "New persona".into();
        edited.main_session = None;
        apply(&mut roster, Change::Upsert { bot: edited }, 7).unwrap();
        assert_eq!(roster.bots[0].main_session, Some(session), "editing a profile keeps its conversation");
        assert!(apply(&mut roster, Change::SetMainSession { id: rex, session: Some(MainSession { runtime: "a b".into(), session_id: "x".into() }) }, 8).is_err());
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
    fn bots_default_to_their_own_folder_under_a_movable_root() {
        let mut roster = Roster::default();
        apply(&mut roster, Change::Upsert { bot: bot("Kit") }, 1).unwrap();
        let kit = roster.bots[0].clone();
        assert_eq!(kit.workspace(&roster.root()), default_root().join(&kit.id));
        apply(&mut roster, Change::SetRoot { root: Some("/data/bots".into()) }, 2).unwrap();
        assert_eq!(kit.workspace(&roster.root()), PathBuf::from("/data/bots").join(&kit.id));
        assert!(apply(&mut roster, Change::SetRoot { root: Some("relative".into()) }, 3).is_err());
        let mut pinned = kit.clone();
        pinned.default_cwd = Some("/work/repo".into());
        assert_eq!(pinned.workspace(&roster.root()), PathBuf::from("/work/repo"), "a chosen workspace wins");
    }

    #[test]
    fn sessions_are_adopted_by_existing_bots_and_released_with_them() {
        let mut roster = Roster::default();
        apply(&mut roster, Change::Upsert { bot: serde_json::from_value(json!({"name":"Kit","backend_key":"claude"})).unwrap() }, 1).unwrap();
        let kit = roster.bots[0].id.clone();
        apply(&mut roster, Change::Adopt { session: "session-1".into(), id: Some(kit.clone()) }, 2).unwrap();
        assert_eq!(roster.adopted.get("session-1"), Some(&kit));
        assert!(apply(&mut roster, Change::Adopt { session: "session-2".into(), id: Some("nobody".into()) }, 3).is_err());
        assert!(apply(&mut roster, Change::Adopt { session: "../x y".into(), id: Some(kit.clone()) }, 3).is_err());
        apply(&mut roster, Change::Delete { id: kit }, 4).unwrap();
        assert!(roster.adopted.is_empty(), "a deleted bot leaves its sessions unfiled");
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
        kit.banner = Some("preset:aurora".into());
        let public = kit.public(true);
        assert_eq!(public["memory_scope"], "bot:bot_kit");
        assert_eq!(public["banner"], "preset:aurora");
        assert!(public.get("persona").is_none());
        assert!(kit.persona_prompt().contains("Reviews code.") && kit.persona_prompt().contains("bot:bot_kit"));
    }

    #[test]
    fn profile_and_skills_are_optional_and_validated() {
        let old: Bot = serde_json::from_value(json!({"name":"Kit","backend_key":"claude"})).unwrap();
        assert!(old.skills.is_empty() && old.tagline.is_none());
        assert!(serde_json::to_value(&old).unwrap().get("skills").is_none(), "older readers still parse new writes");
        let mut roster = Roster::default();
        let skill = |slug: &str| json!({"slug": slug, "source": "skillhub", "name": "Review"});
        let mut kit = bot("Kit");
        kit.tagline = Some("Reviews every PR".into());
        kit.skills = vec![serde_json::from_value(skill("code-review")).unwrap()];
        apply(&mut roster, Change::Upsert { bot: kit.clone() }, 1).unwrap();
        assert_eq!(roster.bots[0].public(false)["skills"], json!(["code-review"]));
        for bad in [skill("../x"), skill(".hidden"), json!({"slug":"x","source":"web","name":"X"}), json!({"slug":"x","source":"local","name":" "})] {
            let mut candidate = kit.clone();
            candidate.skills = vec![serde_json::from_value(bad.clone()).unwrap()];
            assert!(apply(&mut Roster::default(), Change::Upsert { bot: candidate }, 1).is_err(), "{bad}");
        }
        let mut twice = kit.clone();
        twice.skills.push(twice.skills[0].clone());
        assert!(apply(&mut Roster::default(), Change::Upsert { bot: twice }, 1).is_err(), "duplicate slug");
        let mut long = kit;
        long.tagline = Some("x".repeat(121));
        assert!(apply(&mut Roster::default(), Change::Upsert { bot: long }, 1).is_err());
    }

    #[test]
    fn quiet_hours_cross_midnight_and_outbound_is_checked() {
        let night = QuietHours { start: "22:00".into(), end: "08:00".into() };
        assert!(night.contains(23 * 60) && night.contains(7 * 60 + 59) && !night.contains(8 * 60) && !night.contains(12 * 60));
        let lunch = QuietHours { start: "12:00".into(), end: "13:30".into() };
        assert!(lunch.contains(12 * 60 + 30) && !lunch.contains(13 * 60 + 30));
        let mut roster = Roster::default();
        apply(&mut roster, Change::SetQuietHours { quiet_hours: Some(night.clone()) }, 1).unwrap();
        assert_eq!(roster.quiet_hours, Some(night));
        for bad in [("9:00", "10:00"), ("22:00", "22:00"), ("24:00", "08:00")] {
            assert!(apply(&mut roster, Change::SetQuietHours { quiet_hours: Some(QuietHours { start: bad.0.into(), end: bad.1.into() }) }, 2).is_err(), "{bad:?}");
        }
        let mut kit = bot("Kit");
        kit.outbound = Some("draft".into());
        apply(&mut roster, Change::Upsert { bot: kit.clone() }, 3).unwrap();
        kit.outbound = Some("yolo".into());
        assert!(apply(&mut Roster::default(), Change::Upsert { bot: kit }, 3).is_err());
    }

    #[test]
    fn banner_is_validated_and_persisted() {
        let mut roster = Roster::default();
        let mut kit = bot("Kit");
        kit.banner = Some("color:#5865f2".into());
        apply(&mut roster, Change::Upsert { bot: kit }, 1).unwrap();
        assert_eq!(roster.bots[0].banner.as_deref(), Some("color:#5865f2"));
        let mut bad = bot("Bad");
        bad.banner = Some("line1\nline2".into());
        assert!(apply(&mut roster, Change::Upsert { bot: bad }, 2).is_err());
        let mut huge = bot("Huge");
        huge.banner = Some("x".repeat(300));
        assert!(apply(&mut roster, Change::Upsert { bot: huge }, 3).is_err());
    }
}
