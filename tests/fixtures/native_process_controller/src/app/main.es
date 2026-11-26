module app.main;

import std.io.{println, IOError};
import std.codec.text.utf8_encode;
import std.fs.{WorkspacePath, path};
import std.text.from_i64;
import nomo.native.workspace.ProjectRoot;
import nomo.domain.process.jobs.{Job, JobEvent};
import nomo.domain.process.observations.ProcessEvent;
import nomo.application.processes.ports.{ProcessControl, JobRepository, OutputArchive, ProcessPreviewSink};
import nomo.application.processes.service;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.adapters.storage.attempts.NativeAttempts;
import nomo.application.conversation.ports.{ConversationCatalog, ConversationReader};
import nomo.application.execution.ports.AttemptRepository;

alias Schema = MemoryRegion<{ Jobs: Store<string, Job>, Outputs: Store<string, JobEvent> }>;
let Data = std.memory.region<Schema>(stable_id = "nomo-process-controller-fixture-v1", store = "process-controller-fixture");

type Token = { reference: string };
type ControlledProcess = {};
impl ControlledProcess ~ ProcessControl<Token> {
    flow root(self) -> WorkspacePath<ProjectRoot> ![] { return match path<ProjectRoot>(".") { Ok(value) => value, Err(_) => abort("fixture path failed"), }; }
    flow start(self, root: WorkspacePath<ProjectRoot>, program: string, arguments: Array<string>) -> string ![Command.start<DefaultCommandSandbox>] {
        if program != "controlled" || arguments != ["utf8"] { abort("start arguments changed"); }
        return "fixture-handle";
    }
    flow attach(self, reference: string) -> Token ![Command.reconnect<DefaultCommandSandbox>] {
        if reference != "fixture-handle" { abort("saved reference changed"); }
        return Token { reference = reference };
    }
    flow read(self, process: Token, max_bytes: usize) -> ProcessEvent ![Command.read<DefaultCommandSandbox>] {
        if process.reference != "fixture-handle" || max_bytes != 4096 { abort("read contract changed"); }
        return ProcessEvent.Output(utf8_encode("鹈鹕 café\n"), utf8_encode("stderr\n"));
    }
    flow write(self, process: Token, input: bytes) -> unit ![Command.write<DefaultCommandSandbox>] {
        if process.reference != "fixture-handle" || input != utf8_encode("鹈鹕 café\n") { abort("exact input changed"); }
    }
    flow close_input(self, process: Token) -> unit ![Command.write<DefaultCommandSandbox>] {
        if process.reference != "fixture-handle" { abort("EOF capability changed"); }
    }
    flow stop(self, process: Token) -> ProcessEvent ![Command.stop<DefaultCommandSandbox>] {
        if process.reference != "fixture-handle" { abort("stop capability changed"); }
        return ProcessEvent.Stopped(utf8_encode("stopped\n"), utf8_encode(""));
    }
}

type Jobs = {};
impl Jobs ~ JobRepository {
    flow load(self, id: string) -> Option<Job> ![Memory, Error<StorageError>] { return Data.Jobs.get(id); }
    flow insert(self, value: Job) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Jobs.insert(value.id, value); }
    flow save(self, value: Job) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Jobs.put(value.id, value); }
    flow list(self, session: string) -> Array<Job> ![Memory, Error<StorageError>] {
        let page = Data.Jobs.page(None(), 100);
        var result: Array<Job> = [];
        @limits([Iterations(100)]) for entry in page.entries   { if entry.value.session == session { result = result.push(entry.value); } }
        return result;
    }
}

type Outputs = {};
impl Outputs ~ OutputArchive {
    flow insert(self, session: string, call: i64, value: JobEvent) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Outputs.insert(session + ":" + from_i64(call), value); }
    flow find(self, session: string, event: string) -> Option<JobEvent> ![Memory, Error<StorageError>] { return Data.Outputs.get(session + ":" + event); }
}

type Preview = {};
impl Preview ~ ProcessPreviewSink {
    flow write(self, line: string) -> unit ![Console, Error<IOError>] { println(line); }
}

public flow main(args: Array<string>) -> i32 ![Memory, Console, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<IndexError>] {
    let history = NativeHistory {}; let attempts = NativeAttempts {};
    let jobs = Jobs {}; let archive = Outputs {}; let control = ControlledProcess {}; let preview = Preview {};
    let session = history.create("process-controller", "Controlled process observations");
    let job = service.start(control, jobs, preview, attempts, history, history, history, session.id, "controlled", ["utf8"]);
    if job.phase != "started" || job.handle != "fixture-handle" { abort("start observation changed"); }
    let output = service.read(control, jobs, archive, preview, attempts, history, history, history, session.id, job.id, 4096);
    if output.phase != "output" || output.stdout != "鹈鹕 café\n" || output.stdout_bytes != utf8_encode(output.stdout) || output.stderr_bytes != utf8_encode("stderr\n") { abort("observed bytes changed"); }
    let still_started = match jobs.load(job.id) { Some(value) => value, None() => abort("saved job missing"), };
    if still_started.phase != "started" { abort("output invented a terminal phase"); }
    let written = service.write(control, jobs, preview, attempts, history, history, history, session.id, job.id, "鹈鹕 café\n");
    let closed = service.close_input(control, jobs, preview, attempts, history, history, history, session.id, job.id);
    let stopped = service.stop(control, jobs, archive, preview, attempts, history, history, history, session.id, job.id);
    if written.status != "completed" || closed.status != "completed" || stopped.phase != "stopped" { abort("process completion changed"); }
    println("PASS process controller exact input and observed bytes");
    let saved = service.output(jobs, archive, history, history, session.id, job.id);
    if saved.len() != 2 || saved[0] != output || saved[1] != stopped { abort("saved output order changed"); }
    let listed = service.list(jobs, session.id);
    if listed.len() != 1 || listed[0].phase != "stopped" { abort("saved job phase changed"); }
    let final = history.load(session.id);
    if final.pending != "" || final.ledger.tools != 5 || attempts.list(session.id, true).len() != 0 { abort("durable completion changed"); }
    println("PASS process controller durable output ordering");
    return 0;
}
