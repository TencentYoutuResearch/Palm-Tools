# Place a built musl tarball here as `kode-remote-memory-bridge-linux-musl.tar.gz`
# before running `cargo build` / `tauri build` for the GUI.
#
# The tarball is produced by:
#   bash deploy/build-remote-memory-bridge.sh --musl
# which auto-copies it into this directory.
#
# This placeholder ensures the directory exists in git so Tauri's
# `bundle.resources` glob always resolves at build time.
