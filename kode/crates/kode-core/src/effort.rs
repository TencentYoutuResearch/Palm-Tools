//! Data-driven effort transport. Constructing argv is not evidence of model execution.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EffortConfig {
    pub default: Option<String>,
    pub levels: Vec<String>,
    pub adapter: EffortAdapter,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum EffortAdapter {
    None,
    Flag { flag: String },
    ConfigOverride { flag: String, key: String },
    ModelSuffix { prefix: String, suffix: String },
    AcpOption { option: String },
    TurnRpc { field: String },
}
fn safe_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn valid_flag(flag: &str) -> bool {
    let name = flag.strip_prefix("--").or_else(|| flag.strip_prefix('-'));
    flag.len() <= 64
        && name.is_some_and(|name| {
            name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        })
}

impl EffortConfig {
    /// Explicit requests and inherited defaults both fail closed at this low-level
    /// boundary. Higher-level selection may resolve an inherited downgrade first.
    pub fn selected<'a>(&'a self, requested: Option<&'a str>) -> Result<Option<&'a str>> {
        let Some(value) = requested.or(self.default.as_deref()) else {
            return Ok(None);
        };
        if !safe_value(value)
            || self.levels.is_empty()
            || self.levels.len() > 64
            || self.levels.iter().any(|v| !safe_value(v))
            || !self.levels.iter().any(|v| v == value)
        {
            bail!("unsupported or invalid reasoning effort")
        }
        Ok(Some(value))
    }
    pub fn inject_pty(
        &self,
        args: &[String],
        model_flag: Option<&str>,
        requested: Option<&str>,
    ) -> Result<Vec<String>> {
        let Some(value) = self.selected(requested)? else {
            return Ok(args.to_vec());
        };
        let mut result = args.to_vec();
        match &self.adapter {
            EffortAdapter::Flag { flag } => {
                if !valid_flag(flag) {
                    bail!("invalid effort flag")
                }
                // Reject duplicate/conflicting manual configuration rather than
                // silently claiming that the requested value was applied.
                if args
                    .iter()
                    .any(|arg| arg == flag || arg.starts_with(&format!("{flag}=")))
                {
                    bail!("effort flag already configured in arguments")
                }
                result.extend([flag.clone(), value.into()]);
            }
            EffortAdapter::ConfigOverride { flag, key } => {
                if !valid_flag(flag)
                    || key.is_empty()
                    || key.len() > 128
                    || !key
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                {
                    bail!("invalid effort config transport")
                }
                // Detect both split and joined switch forms; other config keys
                // are permitted. JSON quoting is also valid for a TOML string.
                for (i, arg) in args.iter().enumerate() {
                    let assignment = if arg == flag {
                        args.get(i + 1).map(String::as_str)
                    } else {
                        arg.strip_prefix(&format!("{flag}="))
                    };
                    if assignment
                        .and_then(|v| v.split_once('='))
                        .is_some_and(|(k, _)| k.trim() == key)
                    {
                        bail!("effort config key already configured in arguments")
                    }
                }
                result.extend([
                    flag.clone(),
                    format!("{key}={}", serde_json::to_string(value)?),
                ]);
            }
            EffortAdapter::ModelSuffix { prefix, suffix } => {
                if prefix.is_empty()
                    || prefix.len() > 64
                    || suffix.len() > 64
                    || prefix
                        .chars()
                        .chain(suffix.chars())
                        .any(|c| c.is_control() || c.is_whitespace())
                {
                    bail!("invalid effort model suffix")
                }
                let flag = model_flag
                    .filter(|flag| valid_flag(flag))
                    .ok_or_else(|| anyhow::anyhow!("effort suffix requires a model flag"))?;
                let positions: Vec<_> = result
                    .iter()
                    .enumerate()
                    .filter(|(_, arg)| arg.as_str() == flag || arg.starts_with(&format!("{flag}=")))
                    .map(|(i, _)| i)
                    .collect();
                if positions.len() != 1 {
                    bail!("effort suffix requires exactly one model argument")
                }
                let i = positions[0];
                if result[i] == flag {
                    let model = result
                        .get_mut(i + 1)
                        .filter(|v| !v.is_empty() && !v.starts_with('-'))
                        .ok_or_else(|| anyhow::anyhow!("missing model value"))?;
                    if model.contains(prefix) {
                        bail!("model already contains effort suffix")
                    }
                    model.push_str(&format!("{prefix}{value}{suffix}"));
                } else {
                    let model = result[i].split_once('=').unwrap().1;
                    if model.is_empty() || model.contains(prefix) {
                        bail!("invalid or already suffixed model")
                    }
                    result[i].push_str(&format!("{prefix}{value}{suffix}"));
                }
            }
            EffortAdapter::None => bail!("backend does not support reasoning effort"),
            EffortAdapter::AcpOption { .. } | EffortAdapter::TurnRpc { .. } => {
                bail!("reasoning effort requires a protocol adapter; PTY launch is unsupported")
            }
        }
        Ok(result)
    }
}

impl crate::BackendConfig {
    /// Return an isolated launch snapshot; never change a shared backend default.
    pub fn with_requested_effort(&self, requested: Option<&str>) -> Result<Self> {
        let mut snapshot = self.clone();
        if let Some(value) = requested {
            let effort = snapshot.effort.as_mut().ok_or_else(|| {
                anyhow::anyhow!("backend has no configured reasoning-effort transport")
            })?;
            effort.selected(Some(value))?;
            if matches!(effort.adapter, EffortAdapter::None) {
                bail!("backend does not support reasoning effort")
            }
            effort.default = Some(value.into());
        }
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(adapter: EffortAdapter) -> EffortConfig {
        EffortConfig {
            default: Some("high".into()),
            levels: vec!["low".into(), "high".into()],
            adapter,
        }
    }
    #[test]
    fn legacy_and_configured_backend_roundtrip() {
        let legacy: crate::BackendConfig =
            serde_json::from_value(serde_json::json!({"command":"fixture"})).unwrap();
        assert!(legacy.effort.is_none());
        let mut configured = legacy;
        configured.effort = Some(config(EffortAdapter::Flag {
            flag: "--effort".into(),
        }));
        let encoded = toml::to_string(&configured).unwrap();
        assert_eq!(
            toml::from_str::<crate::BackendConfig>(&encoded).unwrap(),
            configured
        );
        assert!(serde_json::from_value::<EffortConfig>(
            serde_json::json!({"default":"high","levels":["high"],"adapter":{"mode":"unknown"}})
        )
        .is_err());
    }
    #[test]
    fn argv_modes_are_nonpositional_and_reject_conflicts() {
        let flag = config(EffortAdapter::Flag {
            flag: "--effort".into(),
        });
        assert_eq!(
            flag.inject_pty(&[], None, None).unwrap(),
            ["--effort", "high"]
        );
        assert!(flag
            .inject_pty(&["--effort=low".into()], None, None)
            .is_err());
        assert!(flag.inject_pty(&[], None, Some("unsupported")).is_err());
        let cfg = config(EffortAdapter::ConfigOverride {
            flag: "-c".into(),
            key: "model_reasoning_effort".into(),
        });
        assert_eq!(
            cfg.inject_pty(&["-c".into(), "other=true".into()], None, Some("low"))
                .unwrap(),
            ["-c", "other=true", "-c", "model_reasoning_effort=\"low\""]
        );
        assert!(cfg
            .inject_pty(&["-c=model_reasoning_effort=\"low\"".into()], None, None)
            .is_err());
        let suffix = config(EffortAdapter::ModelSuffix {
            prefix: "[effort=".into(),
            suffix: "]".into(),
        });
        assert_eq!(
            suffix
                .inject_pty(&["--model".into(), "fixture".into()], Some("--model"), None)
                .unwrap(),
            ["--model", "fixture[effort=high]"]
        );
        assert!(suffix.inject_pty(&[], Some("--model"), None).is_err());
        assert!(suffix
            .inject_pty(
                &["--model=fixture[effort=low]".into()],
                Some("--model"),
                None
            )
            .is_err());
    }
    #[test]
    fn invalid_and_nonpty_transports_fail_before_launch() {
        for adapter in [
            EffortAdapter::None,
            EffortAdapter::AcpOption {
                option: "effort".into(),
            },
            EffortAdapter::TurnRpc {
                field: "effort".into(),
            },
            EffortAdapter::Flag {
                flag: "positional".into(),
            },
            EffortAdapter::Flag { flag: "--".into() },
            EffortAdapter::ConfigOverride {
                flag: "--".into(),
                key: "effort".into(),
            },
        ] {
            assert!(config(adapter).inject_pty(&[], None, None).is_err());
        }
        let mut cfg = config(EffortAdapter::Flag {
            flag: "--effort".into(),
        });
        cfg.default = None;
        assert_eq!(
            cfg.inject_pty(&["existing".into()], None, None).unwrap(),
            ["existing"]
        );
        cfg.levels.push("high;evil".into());
        assert!(cfg.inject_pty(&[], None, Some("high;evil")).is_err());
    }
}
