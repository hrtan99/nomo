"""Git adapter registered after the ordinary project tools."""
from dataclasses import dataclass
import json
import subprocess


@dataclass
class GitTool:
    name: str
    root: object
    mutates: bool = False

    def commands(self, action):
        if self.name == 'git_status':
            return [['git', 'status', '--short', '--branch']]
        if self.name == 'git_diff':
            return [['git', 'diff', *(['--cached'] if action['target'] == 'staged' else []), '--', *action['arguments']]]
        if self.name == 'git_log':
            return [['git', 'log', '--oneline', '-n', str(action['end'] or 20)]]
        if self.name == 'git_branches':
            return [['git', 'branch', '--list']]
        if self.name == 'git_init':
            return [['git', 'init']]
        if self.name == 'git_branch':
            return [['git', 'branch', action['target']]]
        if self.name == 'git_switch':
            return [['git', 'switch', action['target']]]
        commands = [['git', 'add', '--', *action['arguments']]] if action['arguments'] else []
        return [*commands, ['git', 'commit', '-m', action['text']]]

    def preview(self, action):
        return 'Git proposal in ' + str(self.root) + '\n' + '\n'.join(json.dumps(argv, ensure_ascii=False) for argv in self.commands(action))

    def execute(self, action):
        output = []
        for command in self.commands(action):
            result = subprocess.run(command, cwd=self.root, stdin=subprocess.DEVNULL, capture_output=True, text=True)
            output.append(result.stdout + result.stderr)
            if result.returncode:
                return {'exit_code': result.returncode, 'output': '\n'.join(output)}
        return {'exit_code': 0, 'output': '\n'.join(output)}


def register_git(registry, root):
    for name in ('git_status', 'git_diff', 'git_log', 'git_branches', 'git_init', 'git_branch', 'git_switch', 'git_commit'):
        registry.register(GitTool(name, root, name not in ('git_status', 'git_diff', 'git_log', 'git_branches')))
