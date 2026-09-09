#!/usr/bin/env python3
"""Exercise the real SAP service with synthetic data, without Apple credentials."""

import argparse
import base64
import json
import os
from pathlib import Path
import struct
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def configuration():
    values = {}
    path = Path(__file__).with_name(".env")
    if path.is_file():
        for line in path.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith("#"):
                key, separator, value = line.partition("=")
                if separator:
                    values[key.strip()] = value.strip()
    for key in ("SAP_API_TOKEN", "SAP_PORT"):
        if key in os.environ:
            values[key] = os.environ[key]
    return values


def tag(name, payload):
    return name.encode("ascii") + struct.pack(">I", len(payload)) + payload


def sample_bodies(guid):
    query = "('com.apple.itunes.extended\\-media\\-kind:131072')"
    payload = b"".join(
        [
            tag("mstc", struct.pack(">I", int(time.time()))),
            tag("mlid", struct.pack(">I", 1)),
            tag("mikd", b"\x02"),
            tag("musr", struct.pack(">I", 1)),
            tag("mder", struct.pack(">I", 0)),
            tag("mque", query.encode("utf-8")),
            tag("aetl", b""),
        ]
    )
    return [
        ("purchases-update-form", f"session-id=1&revision-number=(null)&query={query}".encode()),
        ("purchases-items-dmap", tag("adsr", payload)),
        ("arbitrary-binary", bytes([0, 255, 128, 13, 10, 0, 254]) + "原始字节".encode()),
        ("xml-plist", f'<?xml version="1.0"?><plist version="1.0"><dict><key>guid</key><string>{guid}</string></dict></plist>\n'.encode()),
    ]


def main():
    settings = configuration()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=f"http://127.0.0.1:{settings.get('SAP_PORT', '18080')}")
    parser.add_argument("--guid", default="020000000001")
    args = parser.parse_args()
    token = settings.get("SAP_API_TOKEN", "")
    if not token:
        raise RuntimeError("SAP_API_TOKEN is missing; run ./setup.sh first")
    endpoint = args.url.rstrip("/")

    with urlopen(endpoint + "/healthz", timeout=5) as response:
        if response.status != 200:
            raise RuntimeError("health endpoint is unavailable")
    print("PASS: HTTP process health", flush=True)

    request = Request(endpoint + "/sign", data=b"{}", headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=5):
            raise RuntimeError("unauthenticated signing was allowed")
    except HTTPError as error:
        if error.code != 401:
            raise
    print("PASS: unauthenticated request rejected", flush=True)

    signatures = set()
    for name, body in sample_bodies(args.guid):
        data = json.dumps({"guid": args.guid, "bodyBase64": base64.b64encode(body).decode("ascii")}).encode()
        request = Request(
            endpoint + "/sign",
            data=data,
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
        )
        started = time.monotonic()
        print(f"Signing {name} ({len(body)} bytes)...", flush=True)
        with urlopen(request, timeout=480) as response:
            result = json.load(response)
            if response.headers.get("Cache-Control") != "no-store":
                raise RuntimeError("signing response is missing Cache-Control: no-store")
        signature = base64.b64decode(result["signature"], validate=True)
        if not signature or signature in signatures:
            raise RuntimeError("signature is empty or reused for different input")
        if result["bytesSigned"] != len(body) or result["guid"] != args.guid.upper():
            raise RuntimeError("signing metadata did not match the original request")
        signatures.add(signature)
        print(f"PASS: {name}; {len(signature)} signature bytes; {time.monotonic() - started:.2f}s", flush=True)
    print("Real SAP signing passed for all four payload types. Authenticated Apple purchase requests were not sent.")


if __name__ == "__main__":
    try:
        main()
    except HTTPError as error:
        print(f"FAIL: HTTP {error.code}: {error.read(2000).decode('utf-8', errors='replace')}", file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
