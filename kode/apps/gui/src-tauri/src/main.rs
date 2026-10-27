#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--kode-workbench-server") {
        let runtime = tokio::runtime::Runtime::new().expect("Kode backend runtime");
        if let Err(error) = runtime.block_on(kode_bridge::messaging::server::run(std::env::args().skip(2))) { eprintln!("Kode backend: {error:#}"); std::process::exit(1) }
        return;
    }
    kode_gui_lib::run()
}
