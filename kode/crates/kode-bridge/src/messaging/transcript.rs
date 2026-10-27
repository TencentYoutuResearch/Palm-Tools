//! Bounded recent-history previews; original CLI logs remain authoritative.
use anyhow::Result;
use serde_json::{json,Value};
use std::{io::{Read,Seek,SeekFrom},path::Path};

fn timestamp(value:&Value)->Option<i64>{
    value.as_i64().or_else(||value.as_str().and_then(|text|chrono::DateTime::parse_from_rfc3339(text).ok()).map(|time|time.timestamp_millis())).filter(|time|*time>=0)
}
fn bounded(value:&Value,limit:usize)->String{crate::semantic::value_to_preview(value,limit)}
fn records(line:&str)->Vec<Value>{
    let Ok(value)=serde_json::from_str::<Value>(line) else{return vec![]};
    let time=timestamp(&value["timestamp"]).or_else(||timestamp(&value["time"]));
    let mut rows=Vec::new();
    let payload=if value["type"]=="response_item"{&value["payload"]}else{&value};
    match payload["type"].as_str().unwrap_or(""){
        "function_call"|"custom_tool_call"=>{
            let arguments=payload.get("arguments").or_else(||payload.get("input")).cloned().unwrap_or(json!({}));
            let arguments=if let Some(text)=arguments.as_str(){serde_json::from_str::<Value>(text).unwrap_or(json!({"input":text}))}else{arguments};
            rows.push(json!({"kind":"tool_call","call_id":payload.get("call_id").or_else(||payload.get("callId")),"name":payload["name"],"arguments":arguments}));
        },
        "function_call_output"|"custom_tool_call_output"|"function_call_result"=>rows.push(json!({"kind":"tool_result","call_id":payload.get("call_id").or_else(||payload.get("callId")),"text":bounded(&payload["output"],4096),"is_error":matches!(payload["status"].as_str(),Some("failed"|"error"|"errored"))})),
        _=>{
            rows.extend(crate::parse_transcript_lines([line]).into_iter().filter(|row|row["kind"]=="text"));
            if let Some(content)=value.pointer("/message/content").and_then(Value::as_array){for block in content{
                match block["type"].as_str(){
                    Some("tool_use")=>rows.push(json!({"kind":"tool_call","call_id":block["id"],"name":block["name"],"arguments":block["input"]})),
                    Some("tool_result")=>rows.push(json!({"kind":"tool_result","call_id":block["tool_use_id"],"text":bounded(&block["content"],4096),"is_error":block["is_error"].as_bool().unwrap_or(false)})),
                    _=>{}
                }
            }}
        }
    }
    if value["type"]=="event_msg"{
        let event=&value["payload"];
        match event["type"].as_str(){
            Some("task_started"|"turn_started")=>rows.push(json!({"kind":"turn_start","native_turn_id":event["turn_id"]})),
            Some("task_complete"|"task_completed"|"turn_complete")=>rows.push(json!({"kind":"turn_end","reason":"completed"})),
            Some("turn_aborted"|"task_aborted")=>rows.push(json!({"kind":"turn_end","reason":"aborted"})),
            _=>{}
        }
    }
    for row in &mut rows {if let Some(time)=time{row["time"]=json!(time);}}
    rows
}

pub(super) fn recent(path:&Path,limit:usize,tail_bytes:usize)->Result<Value> {
    recent_before(path,limit,tail_bytes,None)
}
pub(super) fn recent_before(path:&Path,limit:usize,tail_bytes:usize,before:Option<i64>)->Result<Value> {
    let mut file=std::fs::File::open(path)?;
    let size=file.metadata()?.len();
    let start=size.saturating_sub(tail_bytes as u64);
    file.seek(SeekFrom::Start(start))?;
    let mut source=String::new();
    let mut bytes=Vec::with_capacity(size.saturating_sub(start) as usize);
    file.read_to_end(&mut bytes)?;
    // A tail may begin in UTF-8 or JSON; discard just that incomplete record.
    let begin=if start==0 {0}else{bytes.iter().position(|byte|*byte==b'\n').map(|position|position+1).unwrap_or(bytes.len())};
    source.push_str(&String::from_utf8_lossy(&bytes[begin..]));
    let mut timeline=source.lines().flat_map(records).collect::<Vec<_>>();
    if let Some(before)=before{timeline.retain(|row|row["time"].as_i64().is_some_and(|time|time<before));}
    let texts=timeline.iter().enumerate().filter(|(_,row)|row["kind"]=="text").map(|(index,_)|index).collect::<Vec<_>>();
    let omitted=texts.len().saturating_sub(limit);
    let first=texts.get(omitted).copied().unwrap_or(0);
    // Keep a real native start marker immediately preceding the selected window.
    let first=timeline[..first].iter().rposition(|row|row["kind"]=="turn_start").filter(|index|!timeline[*index..first].iter().any(|row|row["kind"]=="text")).unwrap_or(first);
    if first>0 {timeline.drain(..first);}
    let messages=timeline.iter().filter(|row|row["kind"]=="text").cloned().collect::<Vec<_>>();
    let count=messages.len();
    Ok(json!({"messages":messages,"timeline":timeline,"available":true,"history_window":{"count":count,"truncated":start>0||omitted>0}}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn large_native_logs_load_only_recent_complete_messages() {
        let root=tempfile::tempdir().unwrap();let path=root.path().join("history.jsonl");
        let mut file=std::fs::File::create(&path).unwrap();file.set_len(80*1024*1024).unwrap();file.seek(SeekFrom::End(0)).unwrap();writeln!(file).unwrap();
        for text in ["older","recent request","recent answer"] {
            writeln!(file,"{}",json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}})).unwrap();
        }
        let result=recent(&path,2,4096).unwrap();
        assert_eq!(result["history_window"],json!({"count":2,"truncated":true}));
        assert_eq!(result["messages"][0]["text"],"recent request");assert_eq!(result["messages"][1]["text"],"recent answer");
    }
    #[test]
    fn native_timestamps_tools_and_completion_are_retained(){
        let root=tempfile::tempdir().unwrap();let path=root.path().join("history.jsonl");
        let rows=[json!({"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}),json!({"timestamp":"2026-01-01T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Check cwd"}]}}),json!({"timestamp":"2026-01-01T00:00:03Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call-1","arguments":"{\"cmd\":\"pwd\"}"}}),json!({"timestamp":"2026-01-01T00:00:05Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"/srv/project"}}),json!({"timestamp":"2026-01-01T00:00:20Z","type":"event_msg","payload":{"type":"task_complete"}})];
        std::fs::write(&path,rows.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        let result=recent(&path,80,4096).unwrap();let timeline=result["timeline"].as_array().unwrap();
        assert_eq!(timeline.iter().map(|row|row["kind"].as_str().unwrap()).collect::<Vec<_>>(),vec!["turn_start","text","tool_call","tool_result","turn_end"]);
        assert_eq!(timeline[2]["arguments"]["cmd"],"pwd");assert_eq!(timeline[4]["time"].as_i64().unwrap()-timeline[0]["time"].as_i64().unwrap(),20000);
    }
}
