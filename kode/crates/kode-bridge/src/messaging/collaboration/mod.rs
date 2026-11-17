//! Owner-controlled collaboration surfaces and task archives in the authoritative Hub store.
//! Routing acceptance is NOT execution admission: no legacy Coordinator input is fabricated.
mod model;
pub(in crate::messaging) mod context_access;
pub(in crate::messaging) mod scoped_thread_create;
mod conversation_notices;
pub(in crate::messaging) mod clarification_answers;
pub(in crate::messaging) mod discussion_dispatch;
pub(in crate::messaging) mod execution;
mod routes;
mod storage;
mod tasks;
#[cfg(test)]
mod tests;
pub(super) use routes::router;
pub(in crate::messaging) use storage::insert_message as insert_scoped_message;
pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS collaboration_surfaces(
 id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('channel','dm')),
 revision INTEGER NOT NULL CHECK(revision>0), enabled INTEGER NOT NULL CHECK(enabled IN(0,1)), body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS collaboration_surface_scope ON collaboration_surfaces(scope_key,id);
CREATE TABLE IF NOT EXISTS collaboration_receipts(
 namespace TEXT NOT NULL, request_id TEXT NOT NULL, request TEXT NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(namespace,request_id));
CREATE TABLE IF NOT EXISTS collaboration_messages(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,surface_id TEXT NOT NULL,thread_id TEXT NOT NULL,
 kind TEXT NOT NULL,body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS collaboration_message_page ON collaboration_messages(surface_id,thread_id,seq);
CREATE TABLE IF NOT EXISTS collaboration_tasks(
 id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,origin_surface_id TEXT NOT NULL,origin_message_id TEXT NOT NULL,
 archive_surface_id TEXT NOT NULL,thread_id TEXT NOT NULL UNIQUE,team_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),body TEXT NOT NULL,
 UNIQUE(origin_surface_id,origin_message_id,team_id));
CREATE INDEX IF NOT EXISTS collaboration_task_archive ON collaboration_tasks(archive_surface_id,id);
CREATE TABLE IF NOT EXISTS collaboration_task_events(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS collaboration_task_event_page ON collaboration_task_events(task_id,seq);
"#;

#[cfg(test)]
#[path="../interactive_team_tests.rs"]
mod interactive_team_tests;

#[cfg(test)]
#[path="../team_configuration_acceptance_tests.rs"]
mod team_configuration_acceptance_tests;
