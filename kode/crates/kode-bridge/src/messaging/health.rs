//! Connection-scoped transport observations and queued-request wakeups.
use super::{model::now, Hub};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    sync::Arc,
    time::{Duration, Instant},
};
pub(super) struct Observation {
    version: u32,
    received: Instant,
    received_at: u64,
    ready: Arc<tokio::sync::Notify>,
}
pub(super) struct Link<'a> {
    hub: &'a Hub,
    peer: String,
    id: String,
    ready: Arc<tokio::sync::Notify>,
}
impl Hub {
    pub(super) fn observe_link(&self, peer: &str, version: u32) -> Link<'_> {
        let id = uuid::Uuid::new_v4().to_string();
        let ready = Arc::new(tokio::sync::Notify::new());
        self.link_observations
            .lock()
            .entry(peer.into())
            .or_default()
            .insert(
                id.clone(),
                Observation {
                    version,
                    received: Instant::now(),
                    received_at: now(),
                    ready: ready.clone(),
                },
            );
        Link {
            hub: self,
            peer: peer.into(),
            id,
            ready,
        }
    }
    pub(super) fn wake_peer(&self, peer: &str) {
        if let Some(links) = self.link_observations.lock().get(peer) {
            for link in links.values() {
                // Retain a permit if the socket is currently processing a response.
                // The pending queue's sent flag arbitrates multiple live connections.
                link.ready.notify_one();
            }
        }
    }
    pub(super) fn communication_health(&self) -> Value {
        let peers = self.peers();
        let observations = self.link_observations.lock();
        let rows:Vec<_> = peers.iter().map(|peer| {
            let links:Vec<_> = observations.get(&peer.node_id).into_iter().flat_map(|links|links.values()).collect();
            let recent = links.iter().filter(|link|link.received.elapsed() <= Duration::from_secs(15)).count();
            let versions:BTreeSet<_> = links.iter().map(|link|link.version).collect();
            json!({"node_id":peer.node_id,"state":if recent>0{"connected"}else if links.is_empty(){"not_connected"}else{"stale"},
                "connections":links.len(),"recent_connections":recent,"protocol_versions":versions,
                "last_received_at":links.iter().map(|link|link.received_at).max()})
        }).collect();
        json!({"node_id":self.node_id(),"observed_at":now(),"hub":"responding","scope":"local_transport_observation","peers":rows,
            "limitations":["connected_is_not_worker_ready","no_runtime_or_quota_probe","not_connected_does_not_identify_cause","observations_reset_on_hub_restart"]})
    }
}
impl Link<'_> {
    pub(super) async fn send_ready(&self, tick: &mut tokio::time::Interval) {
        tokio::select! {
            _ = tick.tick() => {},
            _ = self.ready.notified() => {},
        }
    }
    pub(super) fn received(&self) {
        if let Some(row) = self
            .hub
            .link_observations
            .lock()
            .get_mut(&self.peer)
            .and_then(|rows| rows.get_mut(&self.id))
        {
            row.received = Instant::now();
            row.received_at = now();
        }
    }
}
impl Drop for Link<'_> {
    fn drop(&mut self) {
        let mut all = self.hub.link_observations.lock();
        if let Some(rows) = all.get_mut(&self.peer) {
            rows.remove(&self.id);
            if rows.is_empty() {
                all.remove(&self.peer);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn observations_are_connection_scoped_fresh_and_never_runtime_health() {
        let root = tempfile::tempdir().unwrap();
        let ctx =
            crate::build_test_ctx(kode_core::config::Config::default(), "fixture-admin".into());
        let hub = Hub::open(
            super::super::Config {
                node_id: "home".into(),
                database: root.path().join("hub.sqlite"),
                peers: vec![super::super::Peer {
                    node_id: "remote".into(),
                    link_token: "fixture-link-only-0000000000000000".into(),
                    url: None,
                    ssh: None,
                }],
            },
            &ctx,
        )
        .unwrap();
        assert_eq!(
            hub.communication_health()["peers"][0]["state"],
            "not_connected"
        );
        let first = hub.observe_link("remote", 1);
        let second = hub.observe_link("remote", 2);
        assert_eq!(hub.communication_health()["peers"][0]["connections"], 2);
        let unrelated = hub.observe_link("unrelated", 2);
        // Notifications survive work between select iterations and coalesce bursts.
        hub.wake_peer("remote");
        hub.wake_peer("remote");
        for link in [&first, &second] {
            tokio::time::timeout(Duration::from_millis(100), link.ready.notified())
                .await
                .unwrap();
            assert!(tokio::time::timeout(Duration::from_millis(10), link.ready.notified())
                .await
                .is_err());
        }
        assert!(tokio::time::timeout(Duration::from_millis(10), unrelated.ready.notified())
            .await
            .is_err());
        drop(unrelated);
        drop(first);
        let value = hub.communication_health();
        assert_eq!(value["peers"][0]["state"], "connected");
        assert_eq!(value["peers"][0]["protocol_versions"], json!([2]));
        assert!(!value.to_string().contains("fixture-link"));
        for row in hub
            .link_observations
            .lock()
            .get_mut("remote")
            .unwrap()
            .values_mut()
        {
            row.received = Instant::now() - Duration::from_secs(16)
        }
        assert_eq!(hub.communication_health()["peers"][0]["state"], "stale");
        second.received();
        assert_eq!(hub.communication_health()["peers"][0]["state"], "connected");
        drop(second);
        assert_eq!(
            hub.communication_health()["peers"][0]["state"],
            "not_connected"
        );
        assert!(hub.link_observations.lock().is_empty());
        hub.shutdown();
    }
}
