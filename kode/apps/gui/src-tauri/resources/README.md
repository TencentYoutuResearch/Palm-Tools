# Bundled Linux deployment resources
#
# Place the built musl archives here before running a GUI release build:
#   kode-remote-memory-bridge-linux-musl.tar.gz
#   kode-sync-server-linux-musl.tar.gz
#
# The tarball is produced by:
#   bash deploy/build-remote-memory-bridge.sh --musl
#   bash deploy/build-sync-server.sh
# Both scripts auto-copy their artifact into this directory.
#
# This placeholder ensures the directory exists in git so Tauri's
# `bundle.resources` entry can include the directory even when the
# optional tarballs have not been built locally.
