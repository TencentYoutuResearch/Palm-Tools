//! Bounded recent-history previews; original CLI logs remain authoritative.
use anyhow::Result;
use serde_json::{json,Value};
use std::{io::{Read,Seek,SeekFrom},path::Path};

pub(super) fn recent(path:&Path,limit:usize,tail_bytes:usize)->Result<Value> {
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
    let mut messages=crate::parse_transcript_lines(source.lines()).into_iter().filter(|row|row["kind"]=="text").collect::<Vec<_>>();
    let omitted=messages.len().saturating_sub(limit);
    if omitted>0 {messages.drain(..omitted);}
    let count=messages.len();
    Ok(json!({"messages":messages,"available":true,"history_window":{"count":count,"truncated":start>0||omitted>0}}))
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
}
