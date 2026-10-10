#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
bashio::log.info "Starting Matter Bridge..."
export DATA_DIR=/data
export INGRESS_PORT=8099
exec node /app/dist/index.js
