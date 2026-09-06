#!/usr/bin/env bash
set -e

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATLING_BIN_DIR="${GATLING_HOME:-$HOME/gatling/3.9.5}/bin"

JAVA_HOME="$(/usr/libexec/java_home -v 17)"
export JAVA_HOME

sh "$GATLING_BIN_DIR/gatling.sh" -rm local -s RinhaBackendSimulation \
  -rd "${1:-rinha}" \
  -rf "$WORKSPACE/user-files/results" \
  -sf "$WORKSPACE/user-files/simulations" \
  -rsf "$WORKSPACE/user-files/resources"

sleep 3
printf '\ncontagem-pessoas: '
curl -s "http://localhost:9999/contagem-pessoas"
printf '\n'
