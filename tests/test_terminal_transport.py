#!/usr/bin/env python3
"""Transport-only recording doubles; no real fixture, Docker, Etas or PTY."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
LAUNCH = ROOT / "scripts/local-tryout.sh"
TOKEN = "terminal-transport-synthetic-key"


class TerminalTransportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="nomo-terminal-transport-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()
        self.fixture = self.directory / "never-created-tryout"
        self.docker_record = self.directory / "docker.json"
        self.preflight_record = self.directory / "preflight.json"
        binary = self.directory / "bin"
        binary.mkdir()
        self.stub(binary / "python3", """import json,os,sys
from pathlib import Path
assert len(sys.argv)==5 and Path(sys.argv[1]).name=='prepare-local-tryout.py' and sys.argv[2:4]==['--check','--']
Path(os.environ['NOMO_TERMINAL_TEST_PREFLIGHT']).write_text(json.dumps(sys.argv[1:]))
print(sys.argv[4])
""")
        self.stub(binary / "docker", """import json,os,sys
from pathlib import Path
prefixes=('ETAS_HOST_MODEL','ETAS_HOST_OMLX','NOMO_QWEN','NOMO_GATEWAY')
record={'argv':sys.argv[1:],'model_env_keys':sorted(k for k in os.environ if k.startswith(prefixes)),
        'host_approval':os.environ.get('ETAS_HOST_APPROVAL'),'stdin':list(sys.stdin.buffer.read()),
        'state':os.environ.get('NOMO_EDIT_STATE_DIR'),'workspace':os.environ.get('NOMO_EDIT_WORKSPACE_DIR'),
        'context':os.environ.get('NOMO_WORK_CONTEXT_DIR')}
Path(os.environ['NOMO_TERMINAL_TEST_DOCKER']).write_text(json.dumps(record))
raise SystemExit(int(os.environ.get('NOMO_TERMINAL_TEST_EXIT','0')))
""")
        self.environment = {
            "PATH": str(binary) + os.pathsep + os.defpath,
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "NOMO_TERMINAL_TEST_DOCKER": str(self.docker_record),
            "NOMO_TERMINAL_TEST_PREFLIGHT": str(self.preflight_record),
        }

    def stub(self, path, body):
        path.write_text("#!" + sys.executable + "\n" + body)
        path.chmod(0o700)

    def launch(self, *arguments, data=b"", **overrides):
        env = dict(self.environment)
        env.update(overrides)
        observed = subprocess.run([str(LAUNCH), *map(str, arguments)], cwd=ROOT, env=env,
                                  input=data, capture_output=True, timeout=10)
        self.assertFalse(self.fixture.exists(), "the transport test must never provision a work fixture")
        return observed

    def test_non_tty_terminal_forwards_pipe_and_fixed_prompt(self):
        request = "literal $(never-execute) 'quoted'"
        arguments = ["new", "--id", "root-op", "--child-id", "child-op", "--workspace", "owned",
                     "--path", "target.txt", "--once", request, "--allow", "context.txt"]
        data = b"only a request line\n"
        observed = self.launch("terminal", self.fixture, *arguments, data=data,
                               ETAS_HOST_APPROVAL="auto", NOMO_QWEN_SERVER_API_KEY=TOKEN)
        self.assertEqual(observed.returncode, 0, observed.stderr.decode())
        record = json.loads(self.docker_record.read_text())
        argv = record["argv"]
        self.assertIn("--tty=false", argv)
        self.assertNotIn("--tty=true", argv)
        self.assertIn("ETAS_HOST_APPROVAL=prompt", argv)
        self.assertEqual(argv[argv.index("ETAS_HOST_APPROVAL=prompt") - 1], "-e")
        self.assertNotIn("ETAS_HOST_APPROVAL=auto", argv)
        self.assertEqual(record["host_approval"], "auto")
        self.assertEqual(record["stdin"], list(data), "the wrapper must not inject consent")
        self.assertEqual(argv[argv.index("--flow") + 1], "terminal")
        self.assertEqual(argv[argv.index("--profile") + 1], "work-chain")
        self.assertEqual(argv[argv.index("--args") + 1:], arguments)
        self.assertEqual(json.loads(self.preflight_record.read_text()),
                         [str(ROOT / "scripts/prepare-local-tryout.py"), "--check", "--", str(self.fixture)])
        self.assertEqual(record["state"], str(self.fixture / "state"))
        self.assertEqual(record["workspace"], str(self.fixture / "workspace"))
        self.assertEqual(record["context"], str(self.fixture / "context"))
        self.assertIn(str(ROOT / "config/local-tryout-model-compose.yaml"), argv)

    def test_terminal_help_is_provider_free_readonly_and_needs_no_fixture(self):
        observed = self.launch("terminal-help", ETAS_HOST_APPROVAL="auto",
                               ETAS_HOST_MODEL_BASE_URL="http://invalid.test",
                               ETAS_HOST_MODEL_API_KEY=TOKEN, ETAS_HOST_OMLX_API_KEY=TOKEN,
                               NOMO_QWEN_SERVER_API_KEY=TOKEN, NOMO_GATEWAY_CLIENT_TOKEN=TOKEN)
        self.assertEqual(observed.returncode, 0, observed.stderr.decode())
        self.assertFalse(self.preflight_record.exists())
        record = json.loads(self.docker_record.read_text())
        argv = record["argv"]
        self.assertEqual(record["model_env_keys"], [])
        self.assertIsNone(record["state"])
        self.assertIn("--tty=false", argv)
        self.assertIn("ETAS_HOST_APPROVAL=deny", argv)
        self.assertEqual(argv[argv.index("ETAS_HOST_APPROVAL=deny") - 1], "-e")
        self.assertEqual(argv[argv.index("--flow") + 1], "terminal_help")
        self.assertEqual(argv[argv.index("--profile") + 1], "chain-help")
        overlays = [argv[i + 1] for i, value in enumerate(argv[:-1]) if value == "--file"]
        self.assertEqual(overlays[-1], str(ROOT / "config/local-tryout-readonly-compose.yaml"))
        self.assertNotIn(str(ROOT / "config/local-tryout-model-compose.yaml"), overlays)
        self.assertIn('ETAS_HOST_APPROVAL: "deny"', (ROOT / "config/local-tryout-readonly-compose.yaml").read_text())

    def test_terminal_missing_directory_refuses_before_preflight_or_docker(self):
        observed = self.launch("terminal")
        self.assertEqual(observed.returncode, 64)
        self.assertFalse(self.preflight_record.exists())
        self.assertFalse(self.docker_record.exists())

    def test_terminal_help_preserves_docker_failure_status(self):
        observed = self.launch("terminal-help", NOMO_TERMINAL_TEST_EXIT="37")
        self.assertEqual(observed.returncode, 37)
        self.assertFalse(self.preflight_record.exists())


if __name__ == "__main__":
    unittest.main()
