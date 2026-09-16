#!/bin/sh
set -eu

# Cargo invokes this after every successful build. exec keeps Tauri's process
# supervision attached to the app, including rebuilds, Ctrl-C and panic exits.
binary=$1
shift
signed_binary=$("${FILO_DEV_NODE:-node}" "$(dirname "$0")/dev.mjs" --sign-binary "$binary")
exec "$signed_binary" "$@"
