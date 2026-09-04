import importlib.util
import json
import socket
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "etas003_gateway.py"
SPEC = importlib.util.spec_from_file_location("etas003_gateway", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
GATEWAY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = GATEWAY
SPEC.loader.exec_module(GATEWAY)


class UpstreamHandler(BaseHTTPRequestHandler):
    seen_authorization = None

    def log_message(self, _format, *_args):
        return

    def do_POST(self):
        length = int(self.headers["Content-Length"])
        self.rfile.read(length)
        type(self).seen_authorization = self.headers.get("Authorization")
        body = b'{"choices":[{"message":{"content":"OK"}}]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class GatewayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()
        config = GATEWAY.GatewayConfig(
            upstream_host="127.0.0.1",
            upstream_port=cls.upstream.server_address[1],
            upstream_api_key="real-upstream-key",
            client_token="ephemeral-client-token",
            model="Qwen3.5-9B-MLX-4bit",
        )
        cls.gateway = ThreadingHTTPServer(
            ("127.0.0.1", 0), GATEWAY.handler_factory(config)
        )
        cls.gateway_thread = threading.Thread(target=cls.gateway.serve_forever, daemon=True)
        cls.gateway_thread.start()
        cls.url = f"http://127.0.0.1:{cls.gateway.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.gateway.shutdown()
        cls.upstream.shutdown()
        cls.gateway.server_close()
        cls.upstream.server_close()

    def request(self, path, payload, token="ephemeral-client-token", method="POST"):
        data = json.dumps(payload).encode()
        request = urllib.request.Request(
            self.url + path,
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            body = error.read()
            error.close()
            return error.code, body

    def test_forwards_only_allowlisted_request_and_replaces_authorization(self):
        status, body = self.request(
            "/v1/chat/completions",
            {"model": "Qwen3.5-9B-MLX-4bit", "messages": []},
        )
        self.assertEqual(status, 200)
        self.assertIn(b'"content":"OK"', body)
        self.assertEqual(UpstreamHandler.seen_authorization, "Bearer real-upstream-key")

    def test_fails_closed_for_auth_path_method_model_and_streaming(self):
        valid = {"model": "Qwen3.5-9B-MLX-4bit", "messages": []}
        self.assertEqual(self.request("/v1/chat/completions", valid, token="wrong")[0], 401)
        self.assertEqual(self.request("/v1/other", valid)[0], 404)
        self.assertEqual(self.request("/v1/chat/completions", valid, method="PUT")[0], 405)
        self.assertEqual(
            self.request("/v1/chat/completions", {**valid, "model": "other"})[0], 400
        )
        self.assertEqual(
            self.request("/v1/chat/completions", {**valid, "stream": True})[0], 400
        )

    def test_fails_closed_when_upstream_is_unavailable(self):
        reserved = socket.socket()
        reserved.bind(("127.0.0.1", 0))
        unavailable_port = reserved.getsockname()[1]
        reserved.close()
        config = GATEWAY.GatewayConfig(
            upstream_host="127.0.0.1",
            upstream_port=unavailable_port,
            upstream_api_key="real-upstream-key",
            client_token="ephemeral-client-token",
            model="Qwen3.5-9B-MLX-4bit",
            connect_timeout_seconds=0.2,
        )
        server = ThreadingHTTPServer(("127.0.0.1", 0), GATEWAY.handler_factory(config))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        request = urllib.request.Request(
            f"http://127.0.0.1:{server.server_address[1]}/v1/chat/completions",
            data=json.dumps(
                {"model": "Qwen3.5-9B-MLX-4bit", "messages": []}
            ).encode(),
            headers={
                "Authorization": "Bearer ephemeral-client-token",
                "Content-Type": "application/json",
            },
        )
        try:
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(request, timeout=2)
            self.assertEqual(raised.exception.code, 502)
            raised.exception.close()
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
