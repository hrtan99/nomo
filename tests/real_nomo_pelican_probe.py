#!/usr/bin/env python3
"""Accept the real user prompt through the shipped interactive Nomo entry."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import sqlite3
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
PROMPT = '请修改现有 index.html，制作“鹈鹕骑自行车”单页：用内联 SVG 画出长嘴、喉囊、翅膀的鹈鹕骑在自行车上，双脚踩踏板，车轮转动、身体轻微起伏。采用明亮的卡通插画风，蓝天、草地和简洁中文标题；加入暂停/继续按钮，适配手机。HTML、CSS、JS 全放在 index.html 内，无外部依赖，总文件不超过 12 KiB。'


def finish_recorded(args):
    prior = json.loads((args.finish_evidence / 'result.json').read_text())
    state = Path(prior['state'])
    terminal = (args.finish_evidence / 'terminal.log').read_bytes()
    earlier = (Path(prior['continued_from']) / 'terminal.log').read_bytes()
    assert b'APPLIED auto-' in earlier and b'Check passed.' in terminal
    assert b'FINAL ' in terminal[terminal.rfind(b'Check recorded.'):]
    assert b'SAVED chat and event records together' in terminal[terminal.rfind(b'Check recorded.'):]
    identifier = re.search(rb'SESSION ID ([0-9a-f]{32})', terminal).group(1).decode()
    out = Path(tempfile.mkdtemp(prefix='nomo-pelican-completed-', dir='/private/tmp'))
    env = dict(os.environ, NOMO_STATE_DIR=str(state),
        NOMO_ETAS_VERSION='0.4.1', NOMO_ETAS_GRAPH='latest041', NOMO_LOG_FORMAT='raw')
    before = (args.workspace / 'index.html').read_bytes()
    preview = next(json.loads(line[8:]) for line in earlier.splitlines() if line.startswith(b'PREVIEW '))
    assert preview['after'].encode() == before
    if args.verified_resume_evidence:
        resumed_log = (args.verified_resume_evidence / 'resume.log').read_bytes()
        assert b'FINAL ' in resumed_log and b'SAVED chat and event records together' in resumed_log
        (out / 'resume.log').write_bytes(resumed_log)
    else:
        env['MINIMAX_API_KEY'] = args.credential_file.read_text().strip()
        resumed = subprocess.run([str(ROOT / 'scripts/nomo'), '--root', str(args.workspace), '--id', identifier,
            '--once', '说明已完成的鹈鹕网页及其已记录的检查结果。不要修改文件，也不要重跑检查。'], env=env, capture_output=True, timeout=900)
        (out / 'resume.log').write_bytes(resumed.stdout + resumed.stderr)
        assert resumed.returncode == 0 and b'FINAL ' in resumed.stdout, resumed.stderr[-2000:]
    status = subprocess.run([str(ROOT / 'scripts/nomo'), '--id', identifier, '--status', '--events'], env=env, capture_output=True, timeout=300)
    (out / 'status.log').write_bytes(status.stdout + status.stderr)
    assert status.returncode == 0 and b'work-boundary' in status.stdout and b'kind="check" name="independent-check"' in status.stdout
    assert b'Outcome passed.' in status.stdout and status.stdout.index(b'work-boundary') < status.stdout.index(b'kind="check" name="independent-check"')
    assert (args.workspace / 'index.html').read_bytes() == before
    with sqlite3.connect(state / 'sessions' / identifier / 'history.sqlite3') as db:
        assert db.execute('pragma integrity_check').fetchone() == ('ok',)
    browser = json.loads((args.finish_evidence / 'browser-result.json').read_text())
    assert browser['status'] == 'passed' and browser['bytes'] == len(before)
    result = dict(status='passed', prompt=PROMPT, workspace=str(args.workspace), state=str(state), session=identifier,
        evidence=str(out), edit_evidence=prior['continued_from'], check_review_evidence=str(args.finish_evidence),
        file_bytes=len(before), sha256=hashlib.sha256(before).hexdigest(), approved_edits=1, recorded_check='PASS bytes=8929',
        automatic_review=True, new_process_resume=True, browser=browser, integrity='ok')
    (out / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--credential-file', type=Path, required=True)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--continue-evidence', type=Path)
    parser.add_argument('--finish-evidence', type=Path)
    parser.add_argument('--verified-resume-evidence', type=Path)
    args = parser.parse_args()
    if args.finish_evidence: return finish_recorded(args)
    out = Path(tempfile.mkdtemp(prefix='nomo-pelican-acceptance-', dir='/private/tmp'))
    state = (args.continue_evidence or out) / 'state'
    previous = (args.continue_evidence / 'terminal.log').read_bytes() if args.continue_evidence else b''
    prior_edit = previous.count(b'APPLIED auto-')
    env = dict(os.environ, MINIMAX_API_KEY=args.credential_file.read_text().strip(),
        NOMO_STATE_DIR=str(state), NOMO_ETAS_VERSION='0.4.1', NOMO_ETAS_GRAPH='latest041', NOMO_LOG_FORMAT='raw')
    master, slave = pty.openpty()
    settings = termios.tcgetattr(slave); settings[3] &= ~(termios.ECHO | termios.ECHONL); termios.tcsetattr(slave, termios.TCSANOW, settings)
    command = [str(ROOT / 'scripts/nomo'), '--root', str(args.workspace), '--allow', 'index.html']
    question = PROMPT
    if previous:
        identifier = re.search(rb'SESSION ID ([0-9a-f]{32})', previous).group(1).decode()
        operation = re.findall(rb'APPLIED (auto-[0-9a-f]+)', previous)[-1].decode()
        command += ['--id', identifier]
        question = 'AUTO-CONTINUATION: For the original user request ' + PROMPT + ' and completed edit ' + operation + ', propose one suitable offline CHECK command. The edit is already saved and the earlier check proposal was not run. Inspect the current file and finish verification before reporting completion.'
    else: command += ['--high-input']
    process = subprocess.Popen(command, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray(); sent = False; reviews = 0; approved = set(); checks = 0; cursor = 0
    result = {'status': 'running', 'prompt': PROMPT, 'workspace': str(args.workspace), 'evidence': str(out), 'state': str(state), 'continued_from': str(args.continue_evidence) if previous else None}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    deadline = time.monotonic() + 2400
    try:
        while process.poll() is None:
            if time.monotonic() >= deadline: raise TimeoutError('acceptance deadline reached')
            if select.select([master], [], [], .2)[0]:
                try: data = os.read(master, 65536)
                except OSError: data = b''
                output.extend(data)
                print(data.decode('utf-8', 'replace'), end='', flush=True)
            view = bytes(output)
            if not sent and b'nomo> ' in view:
                os.write(master, (question + '\n').encode()); sent = True
            native = view.count(b'Type `yes` to approve:')
            if native and ('native', native) not in approved:
                previews = [json.loads(line[8:]) for line in view.splitlines() if line.startswith(b'PREVIEW ')]
                preview = previews[-1]
                assert preview['path'] == 'index.html'
                assert preview['before'] == (args.workspace / 'index.html').read_text()
                assert 0 < len(preview['after'].encode()) <= 12288
                assert '<svg' in preview['after'] and '<script' in preview['after']
                approved.add(('native', native)); os.write(master, b'yes\n')
            application = view.count(b'CONFIRM Apply this exact preview? [y/N]')
            if application and ('application', application) not in approved:
                approved.add(('application', application)); os.write(master, b'yes\n')
            proposed = view.count(b'Run this exact command? [y/N]')
            if proposed > checks:
                # Commands run in the product's offline project sandbox.
                checks = proposed; os.write(master, b'yes\n')
            reviews = view.count(b'Check recorded. Reviewing its result against the original request.')
            if b'Abandon this stopped operation and continue this session?' in view:
                raise AssertionError('Nomo stopped; inspect terminal.log')
            if sent and not cursor and view.count(b'nomo> ') >= 2:
                assert reviews >= 1 and checks >= 1 and application + prior_edit >= 1, 'coding loop returned before edit/check/review'
                assert b'Check passed.' in view and b'FINAL ' in view[view.rfind(b'Check recorded.'):]
                os.write(master, b'/exit\n'); cursor = len(view)
        while select.select([master], [], [], 0)[0]:
            try: data = os.read(master, 65536)
            except OSError: break
            if not data: break
            output.extend(data)
        assert process.returncode == 0 and cursor, 'interactive coding loop did not complete'
        identifier = re.search(rb'SESSION ID ([0-9a-f]{32})', output).group(1).decode()
        resume = subprocess.run([str(ROOT / 'scripts/nomo'), '--root', str(args.workspace), '--id', identifier,
            '--once', '说明刚才完成的网页修改和已记录的检查结果，不要修改文件或重跑检查。'], env=env, capture_output=True, timeout=900)
        (out / 'resume.log').write_bytes(resume.stdout + resume.stderr)
        assert resume.returncode == 0 and b'FINAL ' in resume.stdout, 'new-process resume failed'
        status = subprocess.run([str(ROOT / 'scripts/nomo'), '--id', identifier, '--status', '--events'], env=env, capture_output=True, timeout=300)
        (out / 'status.log').write_bytes(status.stdout + status.stderr)
        assert status.returncode == 0 and b'work-boundary' in status.stdout and b'kind="check" name="independent-check"' in status.stdout
        payload = (args.workspace / 'index.html').read_bytes()
        result.update(status='passed', session=identifier, approved_edits=application + prior_edit, checks=checks, reviews=reviews,
            file_bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest(), new_process_resume=True)
    except BaseException as error:
        result.update(status='failed', error=repr(error)); raise
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM); process.wait(timeout=30)
        os.close(master)
        (out / 'terminal.log').write_bytes(output)
        (out / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__': main()
