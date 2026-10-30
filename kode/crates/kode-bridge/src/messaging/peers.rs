//! Owner-authorized SSH pairing; additions persist without restarting live sessions.
use super::{link, model::valid_id, store::Store, Config, Hub, Peer};
use anyhow::{bail, Result};
use std::sync::Arc;

fn validate(local: &str, peer: &Peer) -> Result<()> {
    if !valid_id(&peer.node_id) || peer.node_id == local || peer.link_token.len() < 32 {
        bail!("invalid peer identity or link token")
    }
    if let Some(url) = &peer.url { link::validate_url(url)?; }
    if let Some(ssh) = &peer.ssh {
        ssh.validate()?;
        if peer.url.is_some() { bail!("peer must choose url or ssh") }
    }
    Ok(())
}

pub(super) fn load(store: &Store, config: &Config) -> Result<Vec<Peer>> {
    let mut peers = config.peers.clone();
    let document = store.document("managed-peers")?;
    let managed: Vec<Peer> = document.get("value").filter(|v| !v.is_null())
        .map(|v| serde_json::from_value(v.clone())).transpose()?.unwrap_or_default();
    for peer in managed {
        validate(&config.node_id, &peer)?;
        if let Some(existing) = peers.iter().find(|p| p.node_id == peer.node_id) {
            if serde_json::to_value(existing)? != serde_json::to_value(&peer)? {
                bail!("managed peer conflicts with host configuration")
            }
        } else { peers.push(peer); }
    }
    Ok(peers)
}

impl Hub {
    pub(super) fn peers(&self) -> Vec<Peer> { self.peers.lock().clone() }

    pub(super) fn peer_allowed(&self, node: &str, token: &str) -> bool {
        self.peers.lock().iter().any(|p| p.node_id == node && crate::constant_eq(&p.link_token, token))
    }

    pub(super) fn remove_peer(&self, node: &str) -> Result<()> {
        let _guard = self.gate.lock();
        if self.config.peers.iter().any(|p| p.node_id == node) { bail!("peer is owned by host configuration") }
        let mut peers = self.peers.lock();
        let document = self.store.document("managed-peers")?;
        let mut managed: Vec<Peer> = document.get("value").filter(|v| !v.is_null())
            .map(|v| serde_json::from_value(v.clone())).transpose()?.unwrap_or_default();
        managed.retain(|p| p.node_id != node);
        self.store.save_document("managed-peers", document["revision"].as_u64().unwrap_or(0), serde_json::to_value(managed)?)?;
        peers.retain(|p| p.node_id != node);
        self.remote.lock().remove(node);
        Ok(())
    }

    pub(super) fn add_peer(self: &Arc<Self>, peer: Peer) -> Result<()> {
        validate(self.node_id(), &peer)?;
        {
            let _guard = self.gate.lock();
            let mut peers = self.peers.lock();
            if let Some(existing) = peers.iter().find(|p| p.node_id == peer.node_id) {
                if serde_json::to_value(existing)? == serde_json::to_value(&peer)? { return Ok(()) }
                bail!("peer already exists with different connection settings")
            }
            if peers.len() >= 128 { bail!("too many paired hosts") }
            let document = self.store.document("managed-peers")?;
            let mut managed: Vec<Peer> = document.get("value").filter(|v| !v.is_null())
                .map(|v| serde_json::from_value(v.clone())).transpose()?.unwrap_or_default();
            managed.push(peer.clone());
            self.store.save_document("managed-peers", document["revision"].as_u64().unwrap_or(0), serde_json::to_value(managed)?)?;
            peers.push(peer.clone());
        }
        if peer.url.is_some() || peer.ssh.is_some() { link::connect(self.clone(), peer); }
        Ok(())
    }
}
