module nomo.adapters.process.jobs;

import nomo.application.execution.ports.{ProcessControl, ProcessOperations};
import nomo.application.resources.ProjectRoot;
import nomo.application.scope.SessionContext;
import nomo.domain.processes.{ArchivedProcessJob, ArchivedOutput, InputResult, ProcessJob, ProcessOutput, ProcessEvent};
import std.fs.{WorkspacePath, path};
import std.host.command.{Command as command_Command, CommandEvent, CommandHandle, reconnect, start};

/// Start an allowlisted background process in the project after native approval. The handle belongs to this live Etas Host; persistence of metadata does not keep the Host alive.
public tool start_job(program: string, arguments: Array<string>) -> JobToolRecord

![SessionContext.current, ProcessOperations] {
    let session = perform SessionContext.current();
    return job_tool_record(perform ProcessOperations.start(session, program, arguments));
}

/// Read the next native output event. This waits for output or termination; max_bytes is the per-stream bound. Original bytes accompany the display text and remain in history.
public tool read_job(job: string, max_bytes: usize) -> JobOutputToolRecord

![SessionContext.current, ProcessOperations] {
    let session = perform SessionContext.current();
    return output_tool_record(perform ProcessOperations.read(session, job, max_bytes));
}

/// Write the exact input bytes after a separate native approval. No newline is added.
public tool write_job(job: string, input: string) -> InputToolResult

![SessionContext.current, ProcessOperations] {
    let session = perform SessionContext.current();
    return input_tool_result(perform ProcessOperations.write(session, job, input));
}

/// Close this job's stdin after native approval, allowing programs waiting for EOF to finish.
public tool close_job_input(job: string) -> InputToolResult

![SessionContext.current, ProcessOperations] {
    let session = perform SessionContext.current();
    return input_tool_result(perform ProcessOperations.close_input(session, job));
}

/// Stop an owned background process after fresh native approval and return its actual terminal event.
public tool stop_job(job: string) -> JobOutputToolRecord

![SessionContext.current, ProcessOperations] {
    let session = perform SessionContext.current();
    return output_tool_record(perform ProcessOperations.stop(session, job));
}

/// List this conversation's saved metadata; phases do not establish current liveness.
public tool list_jobs() -> Array<JobToolRecord>

![SessionContext.current, ProcessOperations] {
    let session = perform SessionContext.current();
    return job_tool_records(perform ProcessOperations.list(session));
}

/// Read all complete saved output events for this job without consuming Host output or replaying a process operation. This archive remains readable after restart.
public tool job_output(job: string) -> Array<JobOutputToolRecord>

![SessionContext.current, ProcessOperations] {
    let session = perform SessionContext.current();
    return output_tool_records(perform ProcessOperations.output(session, job));
}

/// List old project jobs retained by migration. Workspace ownership and saved phases are historical; these records contain no native process handle.
public tool archived_jobs() -> Array<ArchivedJobToolRecord>

![SessionContext.current, ProcessOperations] {
    return archived_tool_records(perform ProcessOperations.archived_jobs(perform SessionContext.current()));
}

/// Read one retained raw output part from an old project job. next_part identifies the next part, if any; no process is polled or restarted.
public tool archived_job_output(job: string, part: usize = 0) -> ArchivedOutput
![SessionContext.current, ProcessOperations] {
    return perform ProcessOperations.archived_output(perform SessionContext.current(), job, part);
}

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
        return match path<ProjectRoot>(".") {
            Ok(value) => value,
            Err(_) => abort("project root is unavailable"),
        };
    }

    flow start(self, root: WorkspacePath<ProjectRoot>, program: string, arguments: Array<string>) -> CommandHandle ![Command.start<DefaultCommandSandbox>] {
        return start(command_Command.new(program, arguments).with_cwd(root), DefaultCommandSandbox);
    }

    flow reference(self, process: CommandHandle) -> string ![] {
        return process.id();
    }

    flow attach(self, reference: string) -> CommandHandle ![Command.reconnect<DefaultCommandSandbox>] {
        return reconnect(reference, DefaultCommandSandbox);
    }

    flow read(self, process: CommandHandle, max_bytes: usize) -> ProcessEvent ![Command.read<DefaultCommandSandbox>] {
        return observed(process.read(max_bytes));
    }

    flow write(self, process: CommandHandle, input: bytes) -> unit ![Command.write<DefaultCommandSandbox>] {
        process.write(input);
    }

    flow close_input(self, process: CommandHandle) -> unit ![Command.write<DefaultCommandSandbox>] {
        process.close_stdin();
    }

    flow stop(self, process: CommandHandle) -> ProcessEvent ![Command.stop<DefaultCommandSandbox>] {
        return observed(process.stop());
    }
}

public type JobToolRecord = {
    id: string,
    session: string,
    program: string,
    arguments: Array<string>,
    handle: string,
    phase: string
};
public type JobOutputToolRecord = {
    job: string,
    call: i64,
    phase: string,
    exit_code: Option<i32>,
    stdout: string,
    stderr: string,
    stdout_bytes: bytes,
    stderr_bytes: bytes
};
public type ArchivedJobToolRecord = {
    id: string,
    workspace: string,
    arguments: Array<string>,
    phase: string,
    exit_code: Option<i32>,
    output_bytes: usize,
    parts: usize,
    original: string
};
public type InputToolResult = {
    job: string,
    operation: string,
    status: string
};
flow job_tool_record(value: ProcessJob) -> JobToolRecord ![] {
    return JobToolRecord {
        id = value.id,
        session = value.session,
        program = value.program,
        arguments = value.arguments,
        handle = value.handle,
        phase = value.phase.wire()
    };
}

flow output_tool_record(value: ProcessOutput) -> JobOutputToolRecord ![] {
    return JobOutputToolRecord {
        job = value.job,
        call = value.call,
        phase = value.phase.wire(),
        exit_code = value.exit_code,
        stdout = value.stdout,
        stderr = value.stderr,
        stdout_bytes = value.stdout_bytes,
        stderr_bytes = value.stderr_bytes
    };
}

flow archived_tool_record(value: ArchivedProcessJob) -> ArchivedJobToolRecord ![] {
    return ArchivedJobToolRecord {
        id = value.id,
        workspace = value.workspace,
        arguments = value.arguments,
        phase = value.phase.wire(),
        exit_code = value.exit_code,
        output_bytes = value.output_bytes,
        parts = value.parts,
        original = value.original
    };
}

flow input_tool_result(value: InputResult) -> InputToolResult ![] {
    return InputToolResult {
        job = value.job,
        operation = value.operation.wire(),
        status = "completed"
    };
}

flow job_tool_records(values: Array<ProcessJob>) -> Array<JobToolRecord> ![] {
    return values.iter().map(value => job_tool_record(value)).collect();
}

flow output_tool_records(values: Array<ProcessOutput>) -> Array<JobOutputToolRecord> ![] {
    return values.iter().map(value => output_tool_record(value)).collect();
}

flow archived_tool_records(values: Array<ArchivedProcessJob>) -> Array<ArchivedJobToolRecord> ![] {
    return values.iter().map(value => archived_tool_record(value)).collect();
}
