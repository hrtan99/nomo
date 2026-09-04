#!/usr/bin/env python3
"""Deterministic OpenAI-compatible fixture for ETAS-003 model-path tests."""

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


EXPECTED_AUTHORIZATION = "Bearer ETAS003_TEST_TOKEN_DO_NOT_PRINT"


class Handler(BaseHTTPRequestHandler):
    server_version = "etas003-mock/1"

    def log_message(self, _format, *_args):
        return

    def do_GET(self):
        if self.path == "/health":
            self._json_response(200, {"status": "healthy"})
            return
        self._json_response(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self._json_response(404, {"error": {"message": "not found"}})
            return
        if self.headers.get("Authorization") != EXPECTED_AUTHORIZATION:
            self._json_response(
                401,
                {"error": {"message": "API key required", "type": "authentication_error"}},
            )
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self._json_response(400, {"error": {"message": "invalid request"}})
            return

        model = request.get("model")
        if request.get("chat_template_kwargs") != {"enable_thinking": False}:
            self._json_response(
                422,
                {"error": {"message": "explicit non-thinking option required"}},
            )
            return
        if model == "mock-unavailable":
            self._json_response(404, {"error": {"message": "model not found"}})
            return
        if model == "mock-malformed":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"not-json")
            return
        if model == "mock-timeout":
            time.sleep(2)

        self._json_response(
            200,
            {
                "id": "etas003-mock-response",
                "object": "chat.completion",
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "ETAS003_MOCK_OK",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 8,
                    "completion_tokens": 4,
                    "total_tokens": 12,
                },
            },
        )

    def _json_response(self, status, value):
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18848)
    args = parser.parse_args()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
