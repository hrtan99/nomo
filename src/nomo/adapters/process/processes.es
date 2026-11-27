module nomo.adapters.process.processes;

import std.host.command.{Command as HostCommand, CommandHandle, CommandEvent, start, reconnect};
import std.fs.{path, WorkspacePath};
import nomo.native.workspace.ProjectRoot;
import nomo.domain.process.observations.ProcessEvent;
import nomo.application.processes.ports.ProcessControl;

flow observed(value: CommandEvent) -> ProcessEvent {
    return match value {
        CommandEvent.Output(stdout, stderr) => ProcessEvent.Output(stdout, stderr),
        CommandEvent.Exited(code, stdout, stderr) => ProcessEvent.Exited(code, stdout, stderr),
        CommandEvent.Stopped(stdout, stderr) => ProcessEvent.Stopped(stdout, stderr)
    };
}
public type HostProcessControl = {};
impl HostProcessControl ~ ProcessControl<CommandHandle> {
    flow root(self) -> WorkspacePath<ProjectRoot> ![] {
        return match path<ProjectRoot>(".") { Ok(value) => value, Err(_) => abort("project root is unavailable"), };
    }
    flow start(self, root: WorkspacePath<ProjectRoot>, program: string, arguments: Array<string>) -> CommandHandle ![Command.start<DefaultCommandSandbox>] {
        return start(HostCommand.new(program, arguments).with_cwd(root), DefaultCommandSandbox);
    }
    flow reference(self, process: CommandHandle) -> string ![] { return process.id(); }
    flow attach(self, reference: string) -> CommandHandle ![Command.reconnect<DefaultCommandSandbox>] { return reconnect(reference, DefaultCommandSandbox); }
    flow read(self, process: CommandHandle, max_bytes: usize) -> ProcessEvent ![Command.read<DefaultCommandSandbox>] { return observed(process.read(max_bytes)); }
    flow write(self, process: CommandHandle, input: bytes) -> unit ![Command.write<DefaultCommandSandbox>] { process.write(input); }
    flow close_input(self, process: CommandHandle) -> unit ![Command.write<DefaultCommandSandbox>] { process.close_stdin(); }
    flow stop(self, process: CommandHandle) -> ProcessEvent ![Command.stop<DefaultCommandSandbox>] { return observed(process.stop()); }
}
