"""Real MiniMax acceptance of the project workflow in disposable synthetic data."""
from pathlib import Path
import argparse
import contextlib
import json
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from nomo_project_chat import ProjectApplication
from nomo_project_model import NativeModel
from nomo_history import SqliteHistory

CHECK = r'''from pathlib import Path
from html.parser import HTMLParser
import re

root = Path(__file__).resolve().parent
page = (root / 'index.html').read_text()
readme = (root / 'README.md').read_text()
assert len(page.encode()) <= 12288, 'HTML exceeds 12 KiB'
assert '<svg' in page and '<button' in page and '@keyframes' in page
assert '<script' in page and ('addEventListener' in page or 'onclick' in page)
assert '鹈鹕骑自行车' in page
assert 'index.html' in readme
class Links(HTMLParser):
    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ('src','href') and value:
                assert not re.match(r'(https?:)?//', value), 'external dependency'
Links().feed(page)
if (root / '.verification-phase').read_text().strip() == 'modified':
    assert '快乐的鹈鹕骑自行车' in page
    assert '快乐的鹈鹕骑自行车' in readme
print('PASS page_bytes=' + str(len(page.encode())) + ' phase=' + (root / '.verification-phase').read_text().strip())
'''


class Acceptance:
    def __init__(self, evidence):
        self.evidence, self.calls, self.models = evidence, 0, []
        self.last_action = None
        self.phases = []
        self.prior_usage = []
        result = evidence / 'result.json'
        if result.exists():
            previous = json.loads(result.read_text())
            self.calls = previous['logical_model_calls']
            self.prior_usage = previous['measured_usage']
            self.phases = previous['phases']
            (evidence / ('previous-result-' + str(self.calls) + '.json')).write_text(result.read_text())

    def model(self):
        acceptance = self
        class RecordedModel(NativeModel):
            def before(self, kind):
                if acceptance.calls >= 32:
                    raise RuntimeError('Acceptance reached 32 logical model calls; stopped without restarting the run')
                acceptance.calls += 1
                with (acceptance.evidence / 'calls.jsonl').open('a') as stream:
                    stream.write(json.dumps({'call': acceptance.calls, 'kind': kind, 'time': time.time()}) + '\n')

            def next(self, context):
                self.before('action')
                action = super().next(context)
                acceptance.last_action = action
                return action

            def summarize(self, context):
                self.before('summary')
                return super().summarize(context)
        model = RecordedModel()
        self.models.append(model)
        return model

    def approve(self, preview):
        action = self.last_action
        tool = action['tool']
        if tool in ('exec', 'spawn'):
            arguments = action['arguments']
            assert len(arguments) == 2 and Path(arguments[0]).name in ('python3', 'python'), 'unexpected executable proposal'
            assert arguments[1] == 'verify_page.py', 'only the prepared synthetic checker is authorized'
        elif tool in ('write', 'create', 'edit', 'batch', 'mkdir', 'move', 'delete'):
            changes = action['changes'] if tool == 'batch' else [action]
            for change in changes:
                assert change['path'] in ('index.html', 'README.md'), 'unexpected file proposal'
        else:
            raise AssertionError('unexpected mutation proposal: ' + tool)
        with (self.evidence / 'approved-previews.txt').open('a') as stream:
            stream.write(preview + '\n\n')
        return True

    def phase(self, name):
        self.phases.append(name)
        self.save('running')
        print('PHASE ' + name, file=sys.__stdout__, flush=True)

    def save(self, status, **extra):
        usage = self.prior_usage + [entry for model in self.models for entry in model.usage_events]
        result = {'status': status, 'phases': self.phases, 'logical_model_calls': self.calls,
                  'successful_http_responses': len(usage),
                  'input_tokens': sum(row['input'] for row in usage), 'output_tokens': sum(row['output'] for row in usage),
                  'measured_usage': usage, **extra}
        (self.evidence / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--credential-file', type=Path, required=True)
    parser.add_argument('--resume-evidence', type=Path)
    parser.add_argument('--finish-evidence', type=Path)
    args = parser.parse_args()
    if args.finish_evidence:
        return finish(args)
    evidence = args.resume_evidence.resolve() if args.resume_evidence else Path(tempfile.mkdtemp(prefix='nomo-real-project-', dir='/private/tmp')).resolve()
    root = evidence / 'project'
    if not args.resume_evidence:
        root.mkdir()
        (root / 'verify_page.py').write_text(CHECK)
        (root / '.verification-phase').write_text('initial')
        (root / '.gitignore').write_text('__pycache__/\n.verification-phase\n.nomo.toml\nverify_page.py\n')
        (root / '.nomo.toml').write_text('[project]\ncontext_window=1000000\nmax_output_tokens=131072\ncompact_ratio=0.75\n')
        (root / 'AGENTS.md').write_text('Use only inline SVG, CSS and JavaScript. No external dependencies. Do not alter verification helpers.\n')
        subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
    os.environ['MINIMAX_API_KEY'] = args.credential_file.read_text().strip()
    os.environ['NOMO_MODEL_BASE_URL'] = 'https://api.minimax.cn/v1'
    os.environ['NOMO_MODEL_ALLOW_PRIVATE'] = 'false'
    acceptance = Acceptance(evidence)
    app = None
    print('EVIDENCE ' + str(evidence), flush=True)
    started = time.monotonic()
    try:
        with (evidence / 'run.log').open('a', buffering=1) as log, contextlib.redirect_stdout(log):
            acceptance.phase('resume-create' if args.resume_evidence else 'create')
            prior = SqliteHistory(evidence / 'state').sessions(root) if args.resume_evidence else []
            app = ProjectApplication(evidence / 'state', root, prior[0]['id'] if prior else None, model=acceptance.model(), approve=acceptance.approve)
            identifier = app.session
            app.ask('请使用 batch 工具在项目根目录一次创建 index.html 和 README.md。网页主题是“鹈鹕骑自行车”：内联 SVG 画出长嘴、喉囊、翅膀的鹈鹕骑车；CSS 动画让车轮和踏板转动、身体轻微起伏；有暂停/继续按钮，蓝天草地，适配手机。HTML/CSS/JS 全放在 index.html，不超过 12 KiB，无外部依赖。README 写明打开方式。完成后只用 exec 执行精确 argv ["python3","verify_page.py"] 检查，再根据真实结果汇报。不得修改或绕过检查脚本；不要安装依赖、访问网络或提交 Git。')
            subprocess.run([sys.executable, 'verify_page.py'], cwd=root, check=True, stdout=log, stderr=log)
            original = (root / 'index.html').read_bytes()
            acceptance.phase('automatic-compaction-and-edit')
            # Test-only lowered trigger, keeping the production window/output
            # allowances unchanged. All extra history is synthetic neutral data.
            for index in range(3):
                app.history.append(identifier, 'tool', ('Synthetic archived observation %d: all work remains in this disposable project. ' % index) * 260, name='synthetic_observation')
            (root / '.nomo.toml').write_text('[project]\ncontext_window=1000000\nmax_output_tokens=131072\ncompact_ratio=0.02\n')
            (root / '.verification-phase').write_text('modified')
            app.close()
            app = ProjectApplication(evidence / 'state', root, identifier, model=acceptance.model(), approve=acceptance.approve)
            app.ask('请将网页的可见主标题和文档标题改为“快乐的鹈鹕骑自行车”，同步更新 README 中的标题。保持动画和按钮功能。请使用 batch 统一修改两个文件，完成后只用 exec 执行精确 argv ["python3","verify_page.py"] 检查。不要修改检查脚本，不要访问网络。')
            subprocess.run([sys.executable, 'verify_page.py'], cwd=root, check=True, stdout=log, stderr=log)
            assert (root / 'index.html').read_bytes() != original
            assert any(row['kind'] == 'compaction' for row in app.history.events(identifier)), 'automatic model summary was not recorded'
            acceptance.phase('background-job-and-git')
            # Restore the ordinary trigger for the rest of this acceptance.
            app.workspace.config.compact_ratio = .75
            app.ask('请使用 spawn 启动精确 argv ["python3","verify_page.py"]，再用 poll 读取其真实完成结果，然后使用 git_status 查看这个一次性项目的工作区状态并汇报。不要修改文件、提交或访问网络。')
            events = app.history.events(identifier)
            assert any(row['role'] == 'tool' and row['name'] == 'spawn' for row in events)
            assert any(row['role'] == 'tool' and row['name'] == 'poll' and 'PASS' in row['content'] for row in events)
            assert any(row['role'] == 'tool' and row['name'] == 'git_status' for row in events)
            acceptance.phase('restart-and-history-export')
            app.close()
            app = ProjectApplication(evidence / 'state', root, identifier, model=acceptance.model(), approve=acceptance.approve)
            app.workspace.config.compact_ratio = .75
            answer = app.ask('根据已保存的会话，简述实际创建和修改了什么、最终标题是什么、检查结果是什么。必须提到最终标题“快乐的鹈鹕骑自行车”。只回答，不要调用文件或命令工具。')
            assert '快乐的鹈鹕骑自行车' in answer
            app.history.export(identifier, evidence / 'conversation.json')
            restored = app.history.import_file(evidence / 'conversation.json')
            assert len(app.history.events(restored)) == len(app.history.events(identifier))
            acceptance.save('passed', session=identifier, project=str(root), page_bytes=(root / 'index.html').stat().st_size,
                            elapsed_seconds=round(time.monotonic() - started, 1))
        print('PASS ' + str(evidence / 'result.json'), flush=True)
    except BaseException as error:
        acceptance.save('failed', error=str(error), elapsed_seconds=round(time.monotonic() - started, 1))
        print('FAILED ' + str(error), file=sys.__stdout__, flush=True)
        raise
    finally:
        if app is not None:
            app.close()
        os.environ.pop('MINIMAX_API_KEY', None)


def finish(args):
    evidence = args.finish_evidence.resolve()
    root = evidence / 'project'
    history = SqliteHistory(evidence / 'state')
    identifier = history.sessions(root)[0]['id']
    # Continue only the unfinished read-only checks. Earlier edits and checks
    # stay in the same archive and are not replayed.
    subprocess.run([sys.executable, 'verify_page.py'], cwd=root, check=True)
    before = (root / 'index.html').read_bytes()
    os.environ.update(MINIMAX_API_KEY=args.credential_file.read_text().strip(),
                      NOMO_MODEL_BASE_URL='https://api.minimax.cn/v1', NOMO_MODEL_ALLOW_PRIVATE='false')
    acceptance = Acceptance(evidence)
    app = None
    started = time.monotonic()
    try:
        with (evidence / 'run.log').open('a', buffering=1) as log, contextlib.redirect_stdout(log):
            acceptance.phase('finish-git-status')
            app = ProjectApplication(evidence / 'state', root, identifier, model=acceptance.model(), approve=acceptance.approve)
            app.workspace.config.compact_ratio = .75
            app.ask('上一轮漏掉了 Git 状态检查。git_status 确实在当前 tools 工具目录内，可通过返回 Action 调用。现在请先调用 git_status，然后根据真实结果汇报；不要再运行 spawn/poll 或 exec，不要修改任何文件或提交。')
            outcomes = [row for row in app.history.events(identifier) if row['role'] == 'tool' and row['name'] == 'git_status']
            assert outcomes and json.loads(outcomes[-1]['content'])['exit_code'] == 0
            acceptance.phase('restart-and-history-export')
            app.close()
            app = ProjectApplication(evidence / 'state', root, identifier, model=acceptance.model(), approve=acceptance.approve)
            app.workspace.config.compact_ratio = .75
            answer = app.ask('根据已保存会话，简述实际创建和修改了哪些文件、最终标题和检查结果。必须提及文件名、最终标题“快乐的鹈鹕骑自行车”和真实检查结果。只回答，不调用工具、不修改文件。')
            assert '快乐的鹈鹕骑自行车' in answer and 'index.html' in answer and 'README' in answer
            assert (root / 'index.html').read_bytes() == before
            app.history.export(identifier, evidence / 'conversation.json')
            restored = app.history.import_file(evidence / 'conversation.json')
            assert len(app.history.events(restored)) == len(app.history.events(identifier))
            acceptance.save('passed', session=identifier, project=str(root), page_bytes=len(before),
                            elapsed_seconds=round(time.monotonic() - started, 1))
        print('PASS ' + str(evidence / 'result.json'), flush=True)
    except BaseException as error:
        acceptance.save('failed', error=str(error), elapsed_seconds=round(time.monotonic() - started, 1))
        raise
    finally:
        if app is not None:
            app.close()
        os.environ.pop('MINIMAX_API_KEY', None)


if __name__ == '__main__':
    main()
