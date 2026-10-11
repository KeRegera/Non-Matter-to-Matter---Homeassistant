#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
bashio::log.info "Starting Matter Bridge..."
export DATA_DIR=/data
# ingress_port is 0 in config.yaml: the Supervisor assigns a free port (the add-on uses the host network)
INGRESS_PORT="$(bashio::addon.ingress_port)"
if [ -z "${INGRESS_PORT}" ] || [ "${INGRESS_PORT}" = "null" ] || [ "${INGRESS_PORT}" = "0" ]; then
    INGRESS_PORT=8099
fi
export INGRESS_PORT
bashio::log.info "Web UI (ingress) port: ${INGRESS_PORT}"
exec node /app/dist/index.js
