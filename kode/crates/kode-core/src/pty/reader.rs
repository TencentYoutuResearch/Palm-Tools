//! 阻塞读 PTY master 的辅助线程。
//! 每次 read 后通过 unbounded mpsc 把字节发回 App。

use std::io::Read;
use std::thread::JoinHandle;

use tokio::sync::mpsc;

use crate::event::CoreEvent;
use crate::session::SessionId;

const READ_BUF: usize = 8 * 1024;

pub fn spawn_reader(
    id: SessionId,
    mut reader: Box<dyn Read + Send>,
    tx: mpsc::UnboundedSender<CoreEvent>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_BUF];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — 子进程关闭
                Ok(n) => {
                    let bytes = buf[..n].to_vec();
                    if tx.send(CoreEvent::PtyBytes { id, bytes }).is_err() {
                        // 上层 receiver 已经退出
                        break;
                    }
                }
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    tracing::warn!(?id, ?e, "pty reader error");
                    break;
                }
            }
        }
    })
}
