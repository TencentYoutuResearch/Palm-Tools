//! Resolve plain `env KEY=value cli ...` wrappers before injecting CLI flags.
//! Process probes must inspect the CLI, and injected flags must follow its name.
use crate::config::BackendConfig;

pub(super) fn resolve(backend: &BackendConfig) -> (BackendConfig, Vec<(String,String)>) {
    let mut result = backend.clone();
    if std::path::Path::new(&backend.command).file_name().and_then(|name|name.to_str()) != Some("env") {
        return (result,Vec::new());
    }
    let mut variables = Vec::new();
    let mut index = 0;
    while let Some(arg) = backend.args.get(index) {
        if arg == "--" { index += 1; break }
        if arg.starts_with('-') { return (result,Vec::new()) }
        let Some((key,value)) = arg.split_once('=') else { break };
        if key.is_empty() { return (result,Vec::new()) }
        variables.push((key.to_owned(),value.to_owned()));
        index += 1;
    }
    let Some(command) = backend.args.get(index).filter(|arg|!arg.starts_with('-')) else { return (result,Vec::new()) };
    result.command = command.clone();
    result.args = backend.args[index+1..].to_vec();
    (result,variables)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn environment_wrappers_preserve_cli_identity_and_arguments() {
        let mut backend=crate::config::Config::default().backends["codex"].clone();
        backend.command="/usr/bin/env".into();backend.args=vec!["EXAMPLE_TOKEN=contains=equals".into(),"worker-codex".into(),"--config".into(),"example=true".into()];
        let (resolved,env)=resolve(&backend);
        assert_eq!(resolved.command,"worker-codex");assert_eq!(resolved.args,["--config","example=true"]);
        assert_eq!(env,vec![("EXAMPLE_TOKEN".into(),"contains=equals".into())]);
        assert_eq!(backend.command,"/usr/bin/env");
    }
}
