#!/usr/bin/env python3
"""OpenAI-compatible server that requires omlx's thinking-control extension."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


CAPTURE_PATH = os.environ["ETAS_REPRO_CAPTURE_PATH"]


class Handler(BaseHTTPRequestHandler):
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
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length))
        with open(CAPTURE_PATH, "w", encoding="utf-8") as capture:
            json.dump(request, capture, sort_keys=True)

        thinking = request.get("chat_template_kwargs", {}).get("enable_thinking")
        if thinking is not False:
            self._json_response(
                422,
                {
                    "error": {
                        "message": "chat_template_kwargs.enable_thinking=false required"
                    }
                },
            )
            return
        self._json_response(
            200,
            {
                "id": "thinking-option-repro",
                "object": "chat.completion",
                "model": "qwen-thinking-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "OK"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 8,
                    "completion_tokens": 1,
                    "total_tokens": 9,
                },
            },
        )

    def _json_response(self, status, value):
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


ThreadingHTTPServer(("127.0.0.1", 18852), Handler).serve_forever()
