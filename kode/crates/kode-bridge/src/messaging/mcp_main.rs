#[tokio::main]
async fn main() -> anyhow::Result<()> {
    kode_bridge::session_mcp::run().await
}
