#!/bin/sh
set -eu

if [ -z "${SAP_API_TOKEN:-}" ]; then
  token_file=/cache/.sap-api-token
  if [ -s "$token_file" ]; then
    SAP_API_TOKEN=$(cat "$token_file")
  else
    SAP_API_TOKEN=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
    umask 077
    printf '%s\n' "$SAP_API_TOKEN" > "$token_file"
    echo "Generated SAP_API_TOKEN=$SAP_API_TOKEN"
    echo "Keep this log private; the value is a bearer credential."
  fi
  export SAP_API_TOKEN
fi

exec /usr/local/bin/sap-signer "$@"
