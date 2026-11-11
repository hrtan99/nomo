module nomo.native.processes;

import std.host.command.{CommandHandle, CommandEvent, command, with_cwd, start, reconnect, id as handle_id, read, write, close_stdin, stop};
import std.fs.path;
import std.codec.text.{utf8_encode, utf8_decode, Replace};
import std.io.{println, IOError};
import std.text.from_i64;
import std.memory.MemoryCursor;
import nomo.core.json.encode;
import nomo.native.workspace.ProjectRoot;
import nomo.native.history.{SessionContext, NativeHistory, ConversationStore, record, observe_started, observe_finished};
import nomo.native.lifecycle.{Attempt, begin, dispatching, returned, complete_attempt};

// phase is the last recorded Host observation, not a claim of current liveness.
public type Job = { id: string, session: string, program: string, arguments: Array<string>, handle: string, phase: string };
public type JobEvent = { job: string, call: i64, phase: string, exit_code: Option<i32>, stdout: string, stderr: string, stdout_bytes: bytes, stderr_bytes: bytes };
type StartRequest = { operation: string, program: string, arguments: Array<string> };
type JobRequest = { operation: string, job: string, handle: string };
type ReadRequest = { operation: string, job: string, handle: string, max_bytes: usize };
type WriteRequest = { operation: string, job: string, handle: string, input: string };
type InputResult = { job: string, operation: string, status: string };
alias Schema = MemoryRegion<{ Jobs: Store<string, Job>, Outputs: Store<string, JobEvent> }>;
let Data = std.memory.region<Schema>(stable_id = "nomo-native-processes-v1", store = "native-processes");

flow json<T>(value: T) -> string {
    return match encode(value, "process conversion failed", "process encoding failed") { Ok(text) => text, Err(error) => { abort(error); } };
}

flow preview<T>(value: T) -> unit { println("[PROCESS] " + json(value)); }
flow text(value: bytes) -> string {
    return match utf8_decode(value, Replace) { Ok(text) => text, Err(_) => { abort("process output conversion failed"); } };
}

flow owned(job: string) -> Job {
    let value = match Data.Jobs.get(job) { Some(value) => value, None() => { abort("native job not found"); } };
    if value.session != perform SessionContext.current() { abort("job belongs to another conversation"); }
    return value;
}

flow prepare<T>(operation: string, request: T) -> Attempt {
    let call = record("tool_call", "command", request, -1);
    let attempt = begin(perform SessionContext.current(), "command", operation, call, call);
    dispatching(attempt.id);
    return attempt;
}

flow complete<T>(attempt: Attempt, result: T) -> unit {
    returned(attempt.id, "tool", "command", json(result), attempt.input_event);
    complete_attempt(attempt.id);
}

flow attach(job: Job) -> CommandHandle {
    if job.handle == "" { abort("job has no recorded Host handle; inspect /runs before deciding recovery"); }
    preview(JobRequest { operation = "reconnect", job = job.id, handle = job.handle });
    return reconnect(job.handle, DefaultCommandSandbox);
}

flow event(job: Job, call: i64, value: CommandEvent) -> JobEvent {
    let result = match value {
        CommandEvent.Output(stdout, stderr) => JobEvent { job = job.id, call = call, phase = "output", exit_code = None(), stdout = text(stdout), stderr = text(stderr), stdout_bytes = stdout, stderr_bytes = stderr },
        CommandEvent.Exited(code, stdout, stderr) => JobEvent { job = job.id, call = call, phase = "exited", exit_code = Some(code), stdout = text(stdout), stderr = text(stderr), stdout_bytes = stdout, stderr_bytes = stderr },
        CommandEvent.Stopped(stdout, stderr) => JobEvent { job = job.id, call = call, phase = "stopped", exit_code = None(), stdout = text(stdout), stderr = text(stderr), stdout_bytes = stdout, stderr_bytes = stderr }
    };
    let phase = if result.phase == "output" { job.phase } else { result.phase };
    Data.Outputs.insert(job.session + ":" + from_i64(call), result);
    Data.Jobs.put(job.id, Job { id = job.id, session = job.session, program = job.program, arguments = job.arguments, handle = job.handle, phase = phase });
    return result;
}

/// Start an allowlisted background process in the project after native approval. The handle belongs to this live Etas Host; persistence of metadata does not keep the Host alive.
public tool start_job(program: string, arguments: Array<string>) -> Job
    ![SessionContext, Memory, Console, Command.start<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    let request = StartRequest { operation = "start", program = program, arguments = arguments };
    let attempt = prepare("start_job", request);
    let job = Job { id = attempt.session + "-job-" + from_i64(attempt.input_event), session = attempt.session,
        program = program, arguments = arguments, handle = "", phase = "starting" };
    Data.Jobs.insert(job.id, job);
    let root = match path<ProjectRoot>(".") { Ok(value) => value, Err(_) => { abort("project root is unavailable"); } };
    preview(request);
    let process = start(with_cwd(command(program, arguments), root), DefaultCommandSandbox);
    let result = Job { id = job.id, session = job.session, program = program, arguments = arguments, handle = handle_id(process), phase = "started" };
    Data.Jobs.put(result.id, result);
    complete(attempt, result);
    return result;
}

/// Read the next native output event. This waits for output or termination; max_bytes is the per-stream bound. Original bytes accompany the display text and remain in history.
public tool read_job(job: string, max_bytes: usize) -> JobEvent
    ![SessionContext, Memory, Console, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    let selected = owned(job);
    let request = ReadRequest { operation = "read", job = job, handle = selected.handle, max_bytes = max_bytes };
    let attempt = prepare("read_job", request);
    let process = attach(selected);
    preview(request);
    let result = event(selected, attempt.input_event, read(process, max_bytes));
    complete(attempt, result);
    return result;
}

/// Write the exact input bytes after a separate native approval. No newline is added.
public tool write_job(job: string, input: string) -> InputResult
    ![SessionContext, Memory, Console, Command.reconnect<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    let selected = owned(job);
    let request = WriteRequest { operation = "write", job = job, handle = selected.handle, input = input };
    let attempt = prepare("write_job", request);
    let process = attach(selected);
    preview(request);
    write(process, utf8_encode(input));
    let result = InputResult { job = job, operation = "write", status = "completed" };
    complete(attempt, result);
    return result;
}

/// Close this job's stdin after native approval, allowing programs waiting for EOF to finish.
public tool close_job_input(job: string) -> InputResult
    ![SessionContext, Memory, Console, Command.reconnect<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    let selected = owned(job);
    let request = JobRequest { operation = "close_stdin", job = job, handle = selected.handle };
    let attempt = prepare("close_job_input", request);
    let process = attach(selected);
    preview(request);
    close_stdin(process);
    let result = InputResult { job = job, operation = "close_stdin", status = "completed" };
    complete(attempt, result);
    return result;
}

/// Stop an owned background process after fresh native approval and return its actual terminal event.
public tool stop_job(job: string) -> JobEvent
    ![SessionContext, Memory, Console, Command.reconnect<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    let selected = owned(job);
    let request = JobRequest { operation = "stop", job = job, handle = selected.handle };
    let attempt = prepare("stop_job", request);
    let process = attach(selected);
    preview(request);
    let result = event(selected, attempt.input_event, stop(process));
    complete(attempt, result);
    return result;
}

/// List this conversation's saved job metadata. Last recorded phases do not prove the process is alive or reconnectable after a restart.
public flow jobs(session: string) -> Array<Job> ![Memory, Error<StorageError>] {
    var result: Array<Job> = [];
    var cursor: Option<MemoryCursor> = None();
    while true limit Iterations(2147483647) {
        let page = Data.Jobs.page(cursor, 100);
        for item in page.entries limit Iterations(2147483647) { if item.value.session == session { result = result.push(item.value); } }
        match page.cursor { Some(value) => { cursor = Some(value); } None() => { break; } }
    }
    return result;
}

public tool list_jobs() -> Array<Job> ![SessionContext, Memory, Error<StorageError>] {
    return jobs(perform SessionContext.current());
}

/// Read all complete saved output events for this job without consuming Host output or replaying a process operation. This archive remains readable after restart.
public tool job_output(job: string) -> Array<JobEvent>
    ![SessionContext, Memory, Error<StorageError>, Error<MemoryConflict>] {
    let selected = owned(job);
    let call = observe_started("job_output", job);
    let history = NativeHistory {};
    var result: Array<JobEvent> = [];
    for item in history.messages(selected.session, 0) limit Iterations(2147483647) {
        if item.role != "tool_call" || item.name != "command" { continue; }
        match Data.Outputs.get(selected.session + ":" + item.id) {
            Some(value) => { if value.job == job { result = result.push(value); } }
            None() => {}
        }
    }
    observe_finished("job_output", call, result);
    return result;
}
