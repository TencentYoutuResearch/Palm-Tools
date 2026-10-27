//! Frontend-independent Kode service, also launchable by the desktop binary.
use anyhow::{bail,Context,Result};
pub async fn run(args: impl Iterator<Item=String>) -> Result<()> {
    let mut args=args;let mut config=None;let mut token_file=None;let mut bind="127.0.0.1:47870".to_owned();
    while let Some(arg)=args.next(){match arg.as_str(){"--config"=>config=args.next(),"--token-file"=>token_file=args.next(),"--bind"=>bind=args.next().context("--bind requires an address")?,_=>bail!("unknown service argument: {arg}")}}
    let config:super::Config=serde_json::from_slice(&std::fs::read(config.context("--config is required")?)?)?;
    let token=std::fs::read_to_string(token_file.context("--token-file is required")?)?.trim().to_owned();
    if token.len()<32{bail!("administrator token must contain at least 32 bytes")}
    let ctx=crate::build_runtime_ctx(kode_core::config::Config::load(),token);
    let hub=super::Hub::open(config,&ctx)?;let router=hub.router();hub.start();
    let listener=tokio::net::TcpListener::bind(&bind).await?;
    println!("kode-session-server {} {}",hub.node_id(),listener.local_addr()?);
    axum::serve(listener,router).with_graceful_shutdown(async{let _=tokio::signal::ctrl_c().await;}).await?;
    hub.shutdown();Ok(())
}
