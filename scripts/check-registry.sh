#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Use root for isolated net/UTS namespaces.' >&2; exit 1; }
repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
client_source="${FASTP2P_CLIENT_SOURCE_DIR:-$repository/../fastp2p}"
gateway="${FASTP2P_C_GATEWAY_BUILD_DIR:-$repository/build}/fastp2p-gateway"
client="${FASTP2P_C_BUILD_DIR:-$client_source/build}/fastp2p"
for binary in "$gateway" "$client"; do
  [[ -x "$binary" ]] || { echo "Build $binary first." >&2; exit 1; }
done
exec unshare --net --uts bash -c '
  set -euo pipefail
  ip link set lo up
  exec python3 "$@"
' _ "$repository/tests/registry_integration.py" --gateway "$gateway" --client "$client" "$@"
