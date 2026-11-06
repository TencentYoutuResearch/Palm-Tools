//! Freeze v1 envelopes independently of evolving internal DTOs.
use super::{
    model::{Address, Frame, Message, SessionInfo},
    workspaces::Command,
};
use anyhow::{bail, Result};
use serde_json::{json, Value};
fn address(value: &Address) -> Value {
    json!({"node_id":value.node_id,"session_id":value.session_id})
}
fn session(value: &SessionInfo) -> Value {
    json!({"address":address(&value.address),"title":value.title,"runtime":value.runtime,"online":value.online,"updated_at":value.updated_at})
}
fn message(value: &Message) -> Value {
    json!({"id":value.id,"source":address(&value.source),"target":address(&value.target),"content":value.content,
        "idempotency_key":value.idempotency_key,"in_reply_to":value.in_reply_to,"hop_count":value.hop_count,
        "created_at":value.created_at,"expires_at":value.expires_at,"status":value.status,"detail":value.detail})
}
fn workspace(command: &Command) -> Value {
    match command {
        Command::SessionCatalog { offset } => json!({"action":"session-catalog","offset":offset}),
        Command::AssignmentCatalog { after } => {
            json!({"action":"assignment-catalog","after":after})
        }
        Command::List => json!({"action":"list"}),
        Command::Create { path, title } => json!({"action":"create","path":path,"title":title}),
        Command::Rename { id, title } => json!({"action":"rename","id":id,"title":title}),
        Command::Delete { id } => json!({"action":"delete","id":id}),
    }
}
pub(super) fn encode(frame: &Frame, version: u32) -> Result<String> {
    if version == 2 {
        return Ok(serde_json::to_string(frame)?);
    }
    if version != 1 {
        bail!("unsupported wire version")
    }
    let value = match frame {
        Frame::Hello {
            node_id,
            version: 1,
        } => json!({"type":"hello","node_id":node_id,"version":1}),
        Frame::Directory { sessions } => {
            json!({"type":"directory","sessions":sessions.iter().map(session).collect::<Vec<_>>()})
        }
        Frame::Message { message: value } => json!({"type":"message","message":message(value)}),
        Frame::Receipt { id, status, detail } => {
            json!({"type":"receipt","id":id,"status":status,"detail":detail})
        }
        Frame::WorkspaceRequest {
            command: Command::AssignmentCatalog { .. },
            ..
        } => bail!("Assignment catalog requires negotiated v2 capability"),
        Frame::WorkspaceRequest { id, command } => {
            json!({"type":"workspace_request","id":id,"command":workspace(command)})
        }
        // v1 defined the workspace result as an opaque JSON value, not SessionInfo.
        Frame::WorkspaceResponse { id, value, error } => {
            json!({"type":"workspace_response","id":id,"value":value,"error":error})
        }
        _ => bail!("frame requires negotiated v2 capability"),
    };
    Ok(serde_json::to_string(&value)?)
}

#[cfg(test)]
mod tests {
    use super::super::model::Status;
    use super::*;
    #[test]
    fn legacy_fields_are_explicit_and_preserve_nulls_and_routing() {
        let a = Address {
            node_id: "node".into(),
            session_id: "worker".into(),
        };
        let row = SessionInfo {
            address: a.clone(),
            title: "Title".into(),
            runtime: "dsh".into(),
            online: true,
            updated_at: 42,
        };
        let value: Value = serde_json::from_str(
            &encode(
                &Frame::Directory {
                    sessions: vec![row],
                },
                1,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            value,
            json!({"type":"directory","sessions":[{"address":{"node_id":"node","session_id":"worker"},"title":"Title","runtime":"dsh","online":true,"updated_at":42}]})
        );
        let frame = Frame::Message {
            message: Message {
                id: "message".into(),
                source: a.clone(),
                target: a,
                content: "中🦊".into(),
                idempotency_key: "key".into(),
                in_reply_to: None,
                hop_count: 2,
                created_at: 1,
                expires_at: 2,
                status: Status::Received,
                detail: None,
            },
        };
        let value: Value = serde_json::from_str(&encode(&frame, 1).unwrap()).unwrap();
        assert_eq!(value["message"].as_object().unwrap().len(), 11);
        assert_eq!(value["message"]["source"].as_object().unwrap().len(), 2);
        assert_eq!(value["message"]["in_reply_to"], Value::Null);
        assert_eq!(value["message"]["detail"], Value::Null);
        assert_eq!(value, serde_json::to_value(&frame).unwrap());
        assert_eq!(
            encode(&frame, 2).unwrap(),
            serde_json::to_string(&frame).unwrap()
        );
        assert!(encode(&frame, 3).is_err());
    }
    #[test]
    fn legacy_rejects_new_frames_and_preserves_workspace_envelopes() {
        for frame in [
            Frame::Capabilities { features: vec![] },
            Frame::DeliveryAck { through: 1 },
            Frame::DeliveryBatch { entries: vec![] },
            Frame::OperationResponse {
                id: "request".into(),
                value: None,
                error: None,
            },
            Frame::Hello {
                node_id: "node".into(),
                version: 2,
            },
        ] {
            assert!(encode(&frame, 1).is_err());
            assert!(encode(&frame, 2).is_ok());
        }
        for command in [
            Command::List,
            Command::SessionCatalog { offset: 4 },
            Command::Create {
                path: "/srv/project".into(),
                title: None,
            },
            Command::Rename {
                id: "work".into(),
                title: "New".into(),
            },
            Command::Delete { id: "work".into() },
        ] {
            let frame = Frame::WorkspaceRequest {
                id: "req".into(),
                command,
            };
            assert_eq!(
                serde_json::from_str::<Value>(&encode(&frame, 1).unwrap()).unwrap(),
                serde_json::to_value(frame).unwrap()
            );
        }
        for frame in [
            Frame::Receipt {
                id: "message".into(),
                status: Status::Accepted,
                detail: None,
            },
            Frame::WorkspaceResponse {
                id: "req".into(),
                value: Some(json!({"opaque":"retained"})),
                error: None,
            },
        ] {
            assert_eq!(
                serde_json::from_str::<Value>(&encode(&frame, 1).unwrap()).unwrap(),
                serde_json::to_value(frame).unwrap()
            );
        }
    }
}
