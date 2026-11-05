#!/usr/bin/env python3
"""Local deterministic contrast of the shared controller's UTF-8 and ASCII policies."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import shared_chat_controller_probe as source
from normal_graph_identity import verify_cli

ROOT = Path(__file__).resolve().parent.parent

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence-dir', required=True, type=Path)
    args = parser.parse_args()
    args.evidence_dir.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix='shared-chat-utf8-', dir=args.evidence_dir))
    source.prepare(folder)
    project = folder / 'controller'
    for _, path in source.closure('nomo.harness.read_tool_chat_controller').items():
        target = project / 'src' / path.relative_to(ROOT / 'src')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    app = project / 'src/app/chat_stage_probe.es'
    text = app.read_text().replace('import nomo.harness.harness_tool_chat_controller.run_turn_controller;',
        'import nomo.harness.read_tool_chat_controller.run_turn_controller;\nimport nomo.harness.harness_tool_chat_controller.run_turn_controller as legacy_run;')
    first = source.vector('unicode_direct', request='请说明', task='查找', result='结果', answer='回答')
    second = source.vector('unicode_tool', first['expected']['state'], request='请继续', task='读取', result='蓝色',
                           answer='已找到', tool='read', outcome='complete: blue<LF>')
    for value in (first, second):
        raw = json.dumps(['delegate', value['task']], ensure_ascii=False, separators=(',', ':'))
        value['raw_plan'] = raw
        value['expected']['completed']['records'][1]['text'] = raw
    text, count = re.subn(r'flow vectors\(\) -> Array<Vector> \{ return \[.*?\];\s*\}',
        lambda _: 'flow vectors() -> Array<Vector> { return [' + source.vector_source(first) + ',' + source.vector_source(second) + ']; }', text, flags=re.S)
    assert count == 1
    observe = '''public flow observe(args: Array<string>) -> i32 {
    let values = vectors();
    let observed = exercise(values[0], values[0].before);
    let next = exercise(values[1], observed.state);
    let refused = legacy_run("请说明", ["a.txt"], fresh_invocation()) with {
        LegacyChatStages.main(_) => { abort("legacy unexpectedly called main"); }
        LegacyChatStages.child(_, _, _, _, _, _) => { abort("legacy unexpectedly called child"); }
    };
    if refused.status != 1 { abort("legacy accepted Unicode request"); }
    println("PASS legacy_unicode_refused_before_dispatch");
    return 0;
}
'''
    text, count = re.subn(r'public flow observe\(args: Array<string>\) -> i32 \{.*?\n\}\n(?=public flow backend_abort)',
        lambda _: observe, text, flags=re.S)
    assert count == 1
    app.write_text(text)
    cli = verify_cli()
    commands = [('check', [str(cli), 'check', '--all', str(project)]),
                ('observe', [str(cli), 'run', str(project), '--flow', 'observe', '--allow-effects'])]
    for name, cmd in commands:
        result = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
        (folder / (name + '.stdout')).write_bytes(result.stdout)
        (folder / (name + '.stderr')).write_bytes(result.stderr)
        assert result.returncode == 0 and not result.stderr, name
        if name == 'observe':
            expected = source.transcript(first) + source.transcript(second) + 'REFUSED question requires 1..128 printable ASCII chars, not only spaces\nPASS legacy_unicode_refused_before_dispatch\n'
            assert result.stdout.decode() == expected, 'full UTF-8 transcript differs'
    (folder / 'result.json').write_text(json.dumps({'status':'passed', 'unicode_success':True, 'legacy_pre_dispatch_refusal':True}) + '\n')
    print('PASS shared UTF-8 controller and legacy refusal', folder)

if __name__ == '__main__':
    main()
