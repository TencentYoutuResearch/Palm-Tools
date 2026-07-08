#[tokio::main]
async fn main() -> anyhow::Result<()> {
    kode_bridge::run().await
}
