#!/usr/bin/env python3
"""Positive large-text contracts using the pinned CLI; no model or file edit."""
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = r'''module app.probe;
import std.io.println;
import nomo.core.json.encode;
import nomo.model.read_protocol.{question_error, decode_plan, decode_work_plan, decode_child, answer};
import nomo.harness.harness_edit_contract.{decode_work_plan as edit_plan, decode_work_edit};
import nomo.harness.harness_tool_chat_contract.Previous;
import nomo.harness.read_tool_chat_contract.prior_error;
import nomo.session.event_text_codec.{encode_prefix, decode};
import nomo.session.recoverable_events.{work_batch, invalid};
import nomo.session.redaction.Policy;
import nomo.core.conversation.Event;

flow text(size: usize) -> string {
    var value = "x"; var width: usize = 1;
    while width < size limit Iterations(21) { value = value + value; width = width * 2; }
    return value;
}
flow json(values: Array<string>) -> string {
    return match encode(values, "conversion failed", "encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
}
flow check(label: string, passed: bool) -> unit {
    if !passed { abort(label); }
    println("PASS " + label);
}
public flow observe(args: Array<string>) -> i32 {
    let request = text(65536); let full = text(1048576);
    let wire = json(["delegate", full]);
    check("64 KiB request", question_error(request) == "");
    check("1 MiB read delegation", match decode_work_plan(wire) { Ok(value) => value == full, Err(_) => false });
    check("1 MiB standard delegation", match decode_plan(wire) { Ok(value) => value == full, Err(_) => false });
    check("1 MiB edit delegation", match edit_plan(wire) { Ok(value) => value == full, Err(_) => false });
    check("1 MiB parent answer", match answer(full) { Ok(value) => value == full, Err(_) => false });
    check("1 MiB child answer", match decode_child(json(["final", full]), ["note.txt"], true) { Ok(value) => value.text == full, Err(_) => false });
    check("64 KiB literal fields", match decode_work_edit(json(["edit", request, request + "new"])) { Ok(value) => value.target == request && value.replacement == request + "new", Err(_) => false });
    let multiline = "Read note.txt\n" + request + "\tand report its contents";
    check("multiline delegated task", match decode_work_plan(json(["delegate", multiline])) { Ok(value) => value == multiline, Err(_) => false });
    let previous = Previous { task = multiline, result = full, tool = "", outcome = "", answer = full };
    check("large resumed prior", prior_error(previous) == "");
    let policy = Policy { format = 1, literals = ["SYNTHETIC_NEVER_PRESENT"] };
    let prefix = match encode_prefix(full, false, policy) { Ok(value) => value, Err(error) => { abort(error); } };
    check("1 MiB saved check output", !prefix.truncated && match decode(prefix.value, policy) { Ok(value) => value == full, Err(_) => false });
    let events = [Event { role = "main", kind = "plan", name = "", text = multiline }, Event { role = "assistant", kind = "answer", name = "", text = full }];
    check("large persisted event frame", match work_batch(events, policy) { Ok(value) => invalid(value, policy) == "", Err(_) => false });
    return 0;
}
'''


def main():
    evidence = Path(tempfile.mkdtemp(prefix='nomo-large-text-contract-')).resolve()
    project = evidence / 'project'
    (project / 'src/app').mkdir(parents=True)
    pending = re.findall(r'(?:public )?import (nomo[\w.]+)', SOURCE)
    copied = set()
    while pending:
        imported = pending.pop()
        parts = imported.split('.')
        candidates = [Path('src').joinpath(*parts[:end]).with_suffix('.es') for end in range(2, len(parts) + 1)]
        selected = next(path for path in candidates if (ROOT / path).is_file())
        if selected in copied:
            continue
        body = (ROOT / selected).read_text()
        target = project / selected
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body)
        copied.add(selected)
        pending.extend(re.findall(r'(?:public )?import (nomo[\w.]+)', body))
    (project / 'src/app/probe.es').write_text(SOURCE)
    (project / 'etas.toml').write_text('''[package]
name = "large-text-contract"
version = "0.0.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "fixture"
[runtime.profiles.fixture]
boundary_policy = "large-text-contract"
[runtime.profiles.fixture.policy]
mode = "local-static"
rules = ["console=allow"]
[runtime.profiles.fixture.approval]
mode = "deny"
[[bin]]
name = "probe"
module = "app.probe"
flow = "observe"
profile = "fixture"
''')
    command = ['docker', 'compose', '--env-file', '/dev/null', '--file', str(ROOT / 'compose.yaml'),
               '--file', str(ROOT / 'config/etas-041-official-compose.yaml'), '--file', str(ROOT / 'config/etas-runtime-cache-compose.yaml'),
               'run', '--rm', '--no-deps', '--pull', 'never', '--tty=false', '--volume', f'{evidence}:{evidence}',
               'dev', 'python3', '-B', '/workspace/scripts/nomo-verified-etas.py', 'run', str(project), '--flow', 'observe', '--allow-effects']
    print('evidence', evidence, flush=True)
    result = subprocess.run(command, capture_output=True, timeout=300)
    (evidence / 'stdout.txt').write_bytes(result.stdout)
    (evidence / 'stderr.txt').write_bytes(result.stderr)
    print(result.stdout.decode(), end='')
    if result.returncode:
        print(result.stderr.decode())
    assert result.returncode == 0 and result.stdout.count(b'PASS ') == 11, evidence
    print(json.dumps({'status': 'passed', 'checks': 11, 'evidence': str(evidence)}))


if __name__ == '__main__':
    main()
