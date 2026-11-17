//! SSH deployments share one workbench service with every frontend on the host.
//! Bootstrap only stages the daemon binary; existing bridges and agents keep running.
use anyhow::{Context, Result};
use serde_json::{json, Value};

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) async fn pair(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    host: &str,
    port: u16,
    upgrade: bool,
) -> Result<String> {
    let port = if port == 0 { 22 } else { port };
    kode_bridge::messaging::SshConfig {
        host: host.to_owned(),
        port,
        remote_port: 1,
        config_file: None,
    }
    .validate()?;
    let local: Value = client
        .get(format!("{}/node", base.trim_end_matches("/workbench")))
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    anyhow::ensure!(
        local["managed_peers"] == true,
        "update the local Kode backend before SSH pairing"
    );
    let local_node = local["node_id"]
        .as_str()
        .context("local Kode backend identity missing")?;
    let link_token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let host_owned = host.to_owned();
    let node_owned = local_node.to_owned();
    let remote = tokio::task::spawn_blocking(move || -> Result<Value> {
        let tarball = crate::deploy::resolve_local_tarball().map_err(anyhow::Error::msg)?;
        let staging = format!("/tmp/kode-workbench-{}", uuid::Uuid::new_v4().simple());
        crate::deploy::run_ssh(&host_owned, port, &format!("umask 077; mkdir {}", quote(&staging))).map_err(anyhow::Error::msg)?;
        let result = (|| -> Result<Value> {
            crate::deploy::run_scp(&host_owned, port, &tarball, &format!("{staging}/bundle.tar.gz")).map_err(anyhow::Error::msg)?;
            let script = format!(
                "set -eu; tar -xzf {archive} -C {directory} ./bin/kode-session-server; {directory}/bin/kode-session-server --bootstrap-workbench --local-node {node} --link-token {token}{upgrade}",
                archive=quote(&format!("{staging}/bundle.tar.gz")), directory=quote(&staging),
                node=quote(&node_owned), token=quote(&link_token), upgrade=if upgrade {" --upgrade"} else {""},
            );
            let output = crate::deploy::run_ssh(&host_owned, port, &script).map_err(anyhow::Error::msg)?;
            output.lines().rev().find_map(|line| serde_json::from_str::<Value>(line).ok())
                .context("remote Kode bootstrap returned no connection")
        })();
        let _ = crate::deploy::run_ssh(&host_owned, port, &format!("rm -rf -- {}", quote(&staging)));
        result
    }).await??;
    let node = remote["node_id"]
        .as_str()
        .context("remote Kode identity missing")?;
    let link = remote["link_token"]
        .as_str()
        .filter(|token| token.len() >= 32)
        .context("remote Kode pairing token missing")?;
    let remote_port = remote["remote_port"]
        .as_u64()
        .filter(|port| *port > 0 && *port <= 65535)
        .context("remote Kode port missing")?;
    client
        .post(format!("{base}/peers"))
        .bearer_auth(token)
        .json(&json!({
            "node_id":node,"link_token":link,"url":null,
            "ssh":{"host":host,"port":port,"remote_port":remote_port}
        }))
        .send()
        .await?
        .error_for_status()?;
    Ok(node.to_owned())
}
