module nomo.application.execution.jobs;

import nomo.application.conversation.ports.{ConversationReader, ConversationWriter, ResultPublication};
import nomo.application.execution.attempts.{begin, complete_attempt, dispatching, returned};
import nomo.application.execution.ports.{
    ArchivedJobCatalog,
    ArchivedJobParts,
    AttemptRepository,
    JobRepository,
    OutputArchive,
    ProcessControl,
    ProcessOperations,
    ProcessPreviewSink
};
import nomo.domain.processes.{
    ArchivedJob,
    ArchivedOutput,
    InputResult,
    JobRequest,
    ProcessEvent,
    ReadRequest,
    StartRequest,
    WriteRequest,
    observed,
    recorded_phase
};
import nomo.domain.wire.encode;
import nomo.native.lifecycle.Attempt;
import nomo.native.processes.{Job, JobEvent};
import std.bytes.from_array;
import std.codec.text.utf8_encode;
import std.io.IOError;
import std.text.from_i64;

public flow bindings<H ~ ConversationReader + ConversationWriter + ResultPublication, A ~ AttemptRepository, J ~ JobRepository + ArchivedJobCatalog + ArchivedJobParts, O ~ ProcessPreviewSink, Live, C ~ ProcessControl<Live>, R ~ OutputArchive>(history: H, attempts: A, control: C, jobs: J, archive: R, preview: O) -> ![ProcessOperations => Memory, Console, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<BudgetExceeded>] ![] {
    return handler {
        ProcessOperations.start(session, program, arguments) => start(control, jobs, preview, attempts, history, history, history, session, program, arguments);
        ProcessOperations.read(session, job, max_bytes) => read(control, jobs, archive, preview, attempts, history, history, history, session, job, max_bytes);
        ProcessOperations.write(session, job, input) => write(control, jobs, preview, attempts, history, history, history, session, job, input);
        ProcessOperations.close_input(session, job) => close_input(control, jobs, preview, attempts, history, history, history, session, job);
        ProcessOperations.stop(session, job) => stop(control, jobs, archive, preview, attempts, history, history, history, session, job);
        ProcessOperations.list(session) => list(jobs, session);
        ProcessOperations.output(session, job) => output(jobs, archive, history, history, session, job);
        ProcessOperations.archived_jobs(session) => archived_jobs(jobs, history, session);
        ProcessOperations.archived_output(session, job, part) => archived_output(jobs, history, session, job, part);
    };
}

flow json<T>(value: T) -> string {
    return match encode(value, "process conversion failed", "process encoding failed") { Ok(text) => text, Err(error) => abort(error), };
}

flow history_text<T>(value: T) -> string {
    return match encode(value, "history conversion failed", "history encoding failed") { Ok(text) => text, Err(error) => abort(error), };
}

flow preview<V ~ ProcessPreviewSink, T>(sink: V, value: T) -> unit { sink.write("[PROCESS] " + json(value)); }

flow owned<J ~ JobRepository>(repository: J, session: string, id: string) -> Job {
    let value = match repository.load(id) { Some(value) => value, None() => abort("native job not found"), };
    if value.session != session { abort("job belongs to another conversation"); }
    return value;
}

flow prepare<A ~ AttemptRepository, W ~ ConversationWriter, T>(attempts: A, writer: W, session: string, operation: string, request: T) -> Attempt {
    let call = writer.append(session, "tool_call", "command", history_text(request), -1);
    let attempt = begin(attempts, session, "command", operation, call, call);
    dispatching(attempts, attempt.id);
    return attempt;
}

flow complete<A ~ AttemptRepository, P ~ ResultPublication, H ~ ConversationReader, T>(attempts: A, publication: P, history: H, attempt: Attempt, result: T) -> unit {
    returned(attempts, publication, attempt.id, "tool", "command", json(result), attempt.input_event);
    complete_attempt(attempts, publication, history, attempt.id);
}

flow attach<Live, C ~ ProcessControl<Live>, V ~ ProcessPreviewSink>(control: C, preview_sink: V, job: Job) -> Live {
    if job.handle == "" { abort("job has no recorded Host handle; inspect /runs before deciding recovery"); }
    preview(preview_sink, JobRequest { operation = "reconnect", job = job.id, handle = job.handle });
    return control.attach(job.handle);
}

flow event<J ~ JobRepository, O ~ OutputArchive>(jobs: J, archive: O, job: Job, call: i64, value: ProcessEvent) -> JobEvent {
    let result = observed(job.id, call, value);
    archive.insert(job.session, call, result);
    jobs.save(job { phase = recorded_phase(job.phase, result.phase) });
    return result;
}

public flow start<Live, C ~ ProcessControl<Live>, J ~ JobRepository, V ~ ProcessPreviewSink, A ~ AttemptRepository, W ~ ConversationWriter, P ~ ResultPublication, H ~ ConversationReader>(control: C, jobs: J, preview_sink: V, attempts: A, writer: W, publication: P, history: H, session: string, program: string, arguments: Array<string>) -> Job
    ![Memory, Console, Command.start<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<BudgetExceeded>] {
    let request = StartRequest { operation = "start", program, arguments };
    let attempt = prepare(attempts, writer, session, "start_job", request);
    let job = Job { id = attempt.session + "-job-" + from_i64(attempt.input_event), session = attempt.session,
        program, arguments, handle = "", phase = "starting" };
    jobs.insert(job);
    let root = control.root();
    preview(preview_sink, request);
    let process = control.start(root, program, arguments);
    let result = job { program, arguments, handle = control.reference(process), phase = "started" };
    jobs.save(result);
    complete(attempts, publication, history, attempt, result);
    return result;
}

public flow read<Live, C ~ ProcessControl<Live>, J ~ JobRepository, O ~ OutputArchive, V ~ ProcessPreviewSink, A ~ AttemptRepository, W ~ ConversationWriter, P ~ ResultPublication, H ~ ConversationReader>(control: C, jobs: J, archive: O, preview_sink: V, attempts: A, writer: W, publication: P, history: H, session: string, job: string, max_bytes: usize) -> JobEvent
    ![Memory, Console, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<BudgetExceeded>] {
    let selected = owned(jobs, session, job);
    let request = ReadRequest { operation = "read", job, handle = selected.handle, max_bytes };
    let attempt = prepare(attempts, writer, session, "read_job", request);
    let process = attach(control, preview_sink, selected);
    preview(preview_sink, request);
    let result = event(jobs, archive, selected, attempt.input_event, control.read(process, max_bytes));
    complete(attempts, publication, history, attempt, result);
    return result;
}

public flow write<Live, C ~ ProcessControl<Live>, J ~ JobRepository, V ~ ProcessPreviewSink, A ~ AttemptRepository, W ~ ConversationWriter, P ~ ResultPublication, H ~ ConversationReader>(control: C, jobs: J, preview_sink: V, attempts: A, writer: W, publication: P, history: H, session: string, job: string, input: string) -> InputResult
    ![Memory, Console, Command.reconnect<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<BudgetExceeded>] {
    let selected = owned(jobs, session, job);
    let request = WriteRequest { operation = "write", job, handle = selected.handle, input };
    let attempt = prepare(attempts, writer, session, "write_job", request);
    let process = attach(control, preview_sink, selected);
    preview(preview_sink, request);
    control.write(process, utf8_encode(input));
    let result = InputResult { job, operation = "write", status = "completed" };
    complete(attempts, publication, history, attempt, result);
    return result;
}

public flow close_input<Live, C ~ ProcessControl<Live>, J ~ JobRepository, V ~ ProcessPreviewSink, A ~ AttemptRepository, W ~ ConversationWriter, P ~ ResultPublication, H ~ ConversationReader>(control: C, jobs: J, preview_sink: V, attempts: A, writer: W, publication: P, history: H, session: string, job: string) -> InputResult
    ![Memory, Console, Command.reconnect<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<BudgetExceeded>] {
    let selected = owned(jobs, session, job);
    let request = JobRequest { operation = "close_stdin", job, handle = selected.handle };
    let attempt = prepare(attempts, writer, session, "close_job_input", request);
    let process = attach(control, preview_sink, selected);
    preview(preview_sink, request);
    control.close_input(process);
    let result = InputResult { job, operation = "close_stdin", status = "completed" };
    complete(attempts, publication, history, attempt, result);
    return result;
}

public flow stop<Live, C ~ ProcessControl<Live>, J ~ JobRepository, O ~ OutputArchive, V ~ ProcessPreviewSink, A ~ AttemptRepository, W ~ ConversationWriter, P ~ ResultPublication, H ~ ConversationReader>(control: C, jobs: J, archive: O, preview_sink: V, attempts: A, writer: W, publication: P, history: H, session: string, job: string) -> JobEvent
    ![Memory, Console, Command.reconnect<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<BudgetExceeded>] {
    let selected = owned(jobs, session, job);
    let request = JobRequest { operation = "stop", job, handle = selected.handle };
    let attempt = prepare(attempts, writer, session, "stop_job", request);
    let process = attach(control, preview_sink, selected);
    preview(preview_sink, request);
    let result = event(jobs, archive, selected, attempt.input_event, control.stop(process));
    complete(attempts, publication, history, attempt, result);
    return result;
}

public flow list<J ~ JobRepository>(jobs: J, session: string) -> Array<Job> ![Memory, Error<StorageError>, Error<BudgetExceeded>] { return jobs.list(session); }

public flow archived_jobs<J ~ ArchivedJobCatalog, H ~ ConversationReader>(jobs: J, history: H, session: string) -> Array<ArchivedJob>
    ![Memory, Error<StorageError>, Error<BudgetExceeded>] {
    return jobs.archived_jobs(history.load(session).workspace);
}

public flow archived_output<J ~ ArchivedJobCatalog + ArchivedJobParts, H ~ ConversationReader>(jobs: J, history: H, session: string, id: string, part: usize) -> ArchivedOutput
    ![Memory, Error<StorageError>] {
    let job = match jobs.archived_job(id) { Some(value) => value, None() => abort("archived project job not found"), };
    if job.workspace != history.load(session).workspace { abort("archived job belongs to another project"); }
    if part >= job.parts { return ArchivedOutput { job = id, part, next_part = None(), total_bytes = job.output_bytes, data = from_array([]) }; }
    let data = match jobs.archived_part(id, part) { Some(value) => value, None() => abort("archived job output part is missing"), };
    return ArchivedOutput { job = id, part, next_part = if part + 1 < job.parts { Some(part + 1) } else { None() },
        total_bytes = job.output_bytes, data };
}

public flow output<J ~ JobRepository, O ~ OutputArchive, W ~ ConversationWriter, H ~ ConversationReader>(jobs: J, archive: O, writer: W, history: H, session: string, job: string) -> Array<JobEvent>
    ![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
    let selected = owned(jobs, session, job);
    let call = writer.append(session, "observation_call", "job_output", history_text(job), -1);
    var result: Array<JobEvent> = [];
    for item in history.messages(selected.session, 0) {
        if item.role != "tool_call" || item.name != "command" { continue; }
        match archive.find(selected.session, item.id) {
            Some(value) => { if value.job == job { result = result.push(value); } },
            None() => (),
        }
    }
    writer.append(session, "tool", "job_output", history_text(result), call);
    return result;
}
