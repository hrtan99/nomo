#!/usr/bin/env python3
"""Transport-only, fail-closed oMLX gateway for the ETAS-003 dev profile."""

from __future__ import annotations

import hmac
import http.client
import json
import sys
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


@dataclass(frozen=True)
class GatewayConfig:
    upstream_host: str
    upstream_port: int
    upstream_api_key: str
    client_token: str
    model: str
    connect_timeout_seconds: float = 2.0
    response_timeout_seconds: float = 180.0
    max_request_bytes: int = 65_536
    max_response_bytes: int = 2_097_152


def _read_secret(path: str) -> str:
    value = Path(path).read_text(encoding="utf-8").strip()
    if not value:
        raise RuntimeError(f"required secret file is empty: {path}")
    return value


def _write_log(**fields: object) -> None:
    print(json.dumps(fields, sort_keys=True, separators=(",", ":")), file=sys.stderr)


def handler_factory(config: GatewayConfig) -> type[BaseHTTPRequestHandler]:
    class GatewayHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "nomo-omlx-gateway/1"

        def log_message(self, _format: str, *_args: object) -> None:
            return

        def _json_error(self, status: int, code: str) -> None:
            body = json.dumps({"error": {"code": code}}, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            _write_log(event="request", method=self.command, status=status, code=code)

        def do_GET(self) -> None:
            if self.path != "/healthz":
                self._json_error(404, "path_not_allowed")
                return
            body = b'{"status":"ok"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            started = time.monotonic()
            if self.path != "/v1/chat/completions":
                self._json_error(404, "path_not_allowed")
                return
            authorization = self.headers.get("Authorization", "")
            expected = f"Bearer {config.client_token}"
            if not hmac.compare_digest(authorization, expected):
                self._json_error(401, "authentication_failed")
                return
            if self.headers.get("Transfer-Encoding") is not None:
                self._json_error(400, "transfer_encoding_not_allowed")
                return
            try:
                content_length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                self._json_error(411, "content_length_required")
                return
            if content_length < 2 or content_length > config.max_request_bytes:
                self._json_error(413, "request_size_rejected")
                return
            request_body = self.rfile.read(content_length)
            try:
                payload = json.loads(request_body)
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._json_error(400, "invalid_json")
                return
            if not isinstance(payload, dict) or payload.get("model") != config.model:
                self._json_error(400, "model_not_allowed")
                return
            if payload.get("stream") not in (None, False):
                self._json_error(400, "streaming_not_allowed")
                return

            connection = http.client.HTTPConnection(
                config.upstream_host,
                config.upstream_port,
                timeout=config.connect_timeout_seconds,
            )
            try:
                connection.connect()
                if connection.sock is None:
                    raise ConnectionError("upstream socket unavailable")
                connection.sock.settimeout(config.response_timeout_seconds)
                connection.request(
                    "POST",
                    "/v1/chat/completions",
                    body=request_body,
                    headers={
                        "Authorization": f"Bearer {config.upstream_api_key}",
                        "Content-Type": "application/json",
                        "Content-Length": str(len(request_body)),
                        "Connection": "close",
                    },
                )
                response = connection.getresponse()
                response_body = response.read(config.max_response_bytes + 1)
                if len(response_body) > config.max_response_bytes:
                    self._json_error(502, "upstream_response_too_large")
                    return
                self.send_response(response.status)
                self.send_header(
                    "Content-Type", response.getheader("Content-Type", "application/json")
                )
                self.send_header("Content-Length", str(len(response_body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(response_body)
                _write_log(
                    event="request",
                    method="POST",
                    status=response.status,
                    request_bytes=len(request_body),
                    response_bytes=len(response_body),
                    elapsed_ms=round((time.monotonic() - started) * 1000),
                )
            except (OSError, http.client.HTTPException) as error:
                _write_log(
                    event="upstream_failure",
                    error_type=type(error).__name__,
                    errno=getattr(error, "errno", None),
                )
                self._json_error(502, "upstream_unavailable")
            finally:
                connection.close()

        def _method_not_allowed(self) -> None:
            self._json_error(405, "method_not_allowed")

        do_DELETE = _method_not_allowed
        do_HEAD = _method_not_allowed
        do_OPTIONS = _method_not_allowed
        do_PATCH = _method_not_allowed
        do_PUT = _method_not_allowed

    return GatewayHandler


def main() -> None:
    config = GatewayConfig(
        upstream_host="host.docker.internal",
        upstream_port=8848,
        upstream_api_key=_read_secret("/run/secrets/omlx_api_key"),
        client_token=_read_secret("/run/secrets/gateway_client_token"),
        model="Qwen3.5-9B-MLX-4bit",
    )
    server = ThreadingHTTPServer(("0.0.0.0", 8080), handler_factory(config))
    server.daemon_threads = True
    _write_log(
        event="gateway_started",
        listen="0.0.0.0:8080",
        upstream="host.docker.internal:8848",
        model=config.model,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
