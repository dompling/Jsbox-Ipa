#!/bin/sh
set -eu

cd "$(dirname "$0")"

if [ ! -f ../../ipatool/internal/sap/signer_local.go ]; then
  echo "Missing sibling ipatool checkout: ../../ipatool/internal/sap/signer_local.go" >&2
  exit 1
fi

python3 - <<'PY'
import os
from pathlib import Path
import secrets

path = Path('.env')
try:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    print('Keeping existing .env and API token.')
else:
    with os.fdopen(descriptor, 'w') as file:
        file.write('SAP_API_TOKEN=' + secrets.token_hex(32) + '\n')
        file.write('SAP_BIND_ADDRESS=127.0.0.1\nSAP_PORT=18080\n')
    print('Created .env with a private API token (mode 0600).')
PY

docker compose up -d --build
