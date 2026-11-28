module nomo.application.execution.commands;

import nomo.application.conversation.ports.{ConversationReader, ConversationWriter, ResultPublication};
import nomo.application.execution.attempts.{begin, complete_attempt, dispatching, returned};
import nomo.application.execution.ports.{AttemptRepository, CommandOperations, CommandPreviewSink, CommandRunner};
import nomo.application.scope.{SessionContext, SettingsContext};
import nomo.domain.commands.{
    CheckOutcome,
    CommandInput,
    CommandMode,
    CommandObservation,
    CommandOutput,
    CommandPreview,
    CommandRequest,
    GitRequest,
    journal
};
import nomo.domain.wire.encode;
import std.io.IOError;
import std.text.from_i32;

flow program_path(name: string) -> string {
    return match name {
        "python3" => "/usr/bin/python3",
        "git" => "/usr/bin/git",
        "sh" => "/bin/sh",
        _ => name
    };
}

public flow checks_run() -> CheckOutcome {
    let settings = perform SettingsContext.current();
    let command = settings.check.iter().skip_while(value => value == "");
    return match command.nth(0) {
        None() => CheckOutcome {
            configured = false,
            output = []
        },
        Some(program) => CheckOutcome {
            configured = true,
            output = [commands_requests_execute(program_path(program), command.skip(1).collect())]
        },
    };
}

public flow request_text(request: CommandRequest) -> string {
    let result = match request.stdin {
        Some(value) => encode(
            CommandInput {
                program = request.program,
                arguments = request.arguments,
                stdin = value
            },
            "history conversion failed",
            "history encoding failed"
        ),
        None() => encode(
            CommandPreview {
                program = request.program,
                arguments = request.arguments
            },
            "history conversion failed",
            "history encoding failed"
        )
    };
    return match result {
        Ok(value) => value,
        Err(error) => abort(error),
    };
}

public flow preview_text(request: CommandRequest) -> string {
    let result = match request.stdin {
        Some(value) => encode(
            CommandInput {
                program = request.program,
                arguments = request.arguments,
                stdin = value
            },
            "command input conversion failed",
            "command input encoding failed"
        ),
        None() => encode(
            CommandPreview {
                program = request.program,
                arguments = request.arguments
            },
            "command preview conversion failed",
            "command preview encoding failed"
        )
    };
    return match result {
        Ok(value) => value,
        Err(error) => abort(error),
    };
}

public flow result_text(output: CommandOutput) -> string {
    return match encode(output, "command result conversion failed", "command result encoding failed") {
        Ok(value) => value,
        Err(error) => abort(error),
    };
}

public flow step_result(output: CommandOutput) -> string {
    return match encode(output, "history conversion failed", "history encoding failed") {
        Ok(value) => value,
        Err(error) => abort(error),
    };
}

public flow git_execute(request: GitRequest) -> CommandOutput {
    return match request {
        GitRequest.Status => execute_readonly(
            "git_status",
            "/usr/bin/git",
            ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--short", "--branch"]
        ),
        GitRequest.Diff(staged, paths) => {
            var arguments = ["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv"];
            if staged {
                arguments = arguments.push("--cached");
            }
            execute_readonly("git_diff", "/usr/bin/git", arguments.push("--").extend(paths))
        },
        GitRequest.Log(count) => execute_readonly(
            "git_log",
            "/usr/bin/git",
            ["--no-optional-locks", "log", "--oneline", "-n", from_i32(count)]
        ),
        GitRequest.Branches => execute_readonly(
            "git_branches",
            "/usr/bin/git",
            ["--no-optional-locks", "branch", "--list"]
        ),
        GitRequest.Init => commands_requests_execute("/usr/bin/git", ["init", "--initial-branch=main"]),
        GitRequest.Branch(name) => commands_requests_execute("/usr/bin/git", ["branch", "--", name]),
        GitRequest.Switch(name) => commands_requests_execute("/usr/bin/git", ["switch", "--", name]),
        GitRequest.Commit(message, paths) => {
            if paths.len() > 0 {
                let staged = commands_requests_execute("/usr/bin/git", ["add", "--"].extend(paths));
                if staged.exit_code != 0 {
                    return staged;
                }
            }
            commands_requests_execute("/usr/bin/git", ["commit", "-m", message])
        }
    };
}

public flow bindings<
    H ~ ConversationReader + ConversationWriter
        + ResultPublication,
    A ~ AttemptRepository,
    R ~ CommandRunner,
    V ~ CommandPreviewSink
>(history: H, attempts: A, runner: R, preview: V) -> ![
    CommandOperations => Memory,
    Console,
    Command.run<DefaultCommandSandbox>,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>,
    Error<BudgetExceeded>
] ![] {
    return handler {
        CommandOperations.execute(session, mode, request) => commands_service_run(
            runner,
            preview,
            attempts,
            history,
            history,
            history,
            session,
            mode,
            request
        );
        CommandOperations.step(session, request, parent) => step(
            runner,
            preview,
            history,
            session,
            request,
            parent
        );
    };
}

flow execute_request(mode: CommandMode, request: CommandRequest) -> CommandObservation
![SessionContext.current, CommandOperations] {
    return perform CommandOperations.execute(perform SessionContext.current(), mode, request);
}

public flow commands_requests_execute(program: string, arguments: Array<string>) -> CommandOutput
![SessionContext.current, CommandOperations] {
    return execute_request(CommandMode.Mutating, CommandRequest {
        program,
        arguments,
        stdin = None()
    }).output;
}

public flow execute_input(program: string, arguments: Array<string>, input: string) -> CommandOutput
![SessionContext.current, CommandOperations] {
    return execute_request(CommandMode.Mutating, CommandRequest {
        program,
        arguments,
        stdin = Some(input)
    }).output;
}

public flow execute_readonly(name: string, program: string, arguments: Array<string>) -> CommandOutput
![SessionContext.current, CommandOperations] {
    return execute_request(
        CommandMode.Observation(name),
        CommandRequest {
            program,
            arguments,
            stdin = None()
        }
    ).output;
}

public flow execute_readonly_input(name: string, program: string, arguments: Array<string>, input: string) -> CommandObservation
![SessionContext.current, CommandOperations] {
    return execute_request(
        CommandMode.Observation(name),
        CommandRequest {
            program,
            arguments,
            stdin = Some(input)
        }
    );
}

public flow execute_step(program: string, arguments: Array<string>, parent: i64) -> CommandOutput
![SessionContext.current, CommandOperations] {
    return perform CommandOperations.step(
        perform SessionContext.current(),
        CommandRequest {
            program,
            arguments,
            stdin = None()
        },
        parent
    );
}

public flow commands_service_run<
    R ~ CommandRunner,
    V ~ CommandPreviewSink,
    A ~ AttemptRepository,
    P ~ ResultPublication,
    C ~ ConversationReader,
    W ~ ConversationWriter
>(
    runner: R,
    preview: V,
    repository: A,
    publication: P,
    history: C,
    writer: W,
    session: string,
    mode: CommandMode,
    request: CommandRequest
) -> CommandObservation
![
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>,
    Error<BudgetExceeded>
] {
    let entry = journal(mode, request.program);
    let call = writer.append(session, entry.role.wire(), entry.name, request_text(request), -1);
    let attempt = begin(repository, session, entry.kind.attempt_kind(), entry.label, call, call);
    dispatching(repository, attempt.id);
    preview.show(request);
    let output = runner.run(request);
    let index = returned(repository, publication, attempt.id, "tool", entry.name, result_text(output), call);
    complete_attempt(repository, publication, history, attempt.id);
    return CommandObservation {
        result_event = index,
        output
    };
}

public flow step<R ~ CommandRunner, V ~ CommandPreviewSink, W ~ ConversationWriter>(
    runner: R,
    preview: V,
    writer: W,
    session: string,
    request: CommandRequest,
    parent: i64
) -> CommandOutput
![
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>,
    Error<BudgetExceeded>
] {
    writer.append(session, "operation", "command", request_text(request), parent);
    preview.show(request);
    let output = runner.run(request);
    writer.append(session, "operation_result", "command", step_result(output), parent);
    return output;
}
