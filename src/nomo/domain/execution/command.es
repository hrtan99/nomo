module nomo.domain.execution.command;

public type CommandRequest = { program: string, arguments: Array<string>, stdin: Option<string> };
public type CommandOutput = { exit_code: i32, stdout: string, stderr: string };
public type CommandObservation = { result_event: i64, output: CommandOutput };
public type CommandPreview = { program: string, arguments: Array<string> };
public type CommandInput = { program: string, arguments: Array<string>, stdin: string };

public enum CommandMode { Mutating, Observation(string) }
public type CommandJournal = { kind: string, role: string, name: string, label: string };

public flow journal(mode: CommandMode, program: string) -> CommandJournal {
    return match mode {
        CommandMode.Mutating => CommandJournal { kind = "command", role = "tool_call", name = "command", label = program },
        CommandMode.Observation(name) => CommandJournal { kind = "observation", role = "observation_call", name, label = name }
    };
}
