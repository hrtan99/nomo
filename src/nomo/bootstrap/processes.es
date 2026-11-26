module nomo.bootstrap.processes;

import nomo.application.processes.service;
import std.io.IOError;
import nomo.application.processes.ports.ProcessOperations;
import nomo.adapters.process.processes.HostProcessControl;
import nomo.adapters.storage.processes.{NativeJobs, NativeOutputArchive};
import nomo.adapters.cli.processes.TerminalProcessPreview;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.adapters.storage.attempts.NativeAttempts;

public flow bindings() -> ![ProcessOperations => Memory, Console, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] ![] {
    let control = HostProcessControl {};
    let jobs = NativeJobs {}; let archive = NativeOutputArchive {};
    let preview = TerminalProcessPreview {}; let history = NativeHistory {}; let attempts = NativeAttempts {};
    return handler {
        ProcessOperations.start(session, program, arguments) => service.start(control, jobs, preview, attempts, history, history, history, session, program, arguments);
        ProcessOperations.read(session, job, max_bytes) => service.read(control, jobs, archive, preview, attempts, history, history, history, session, job, max_bytes);
        ProcessOperations.write(session, job, input) => service.write(control, jobs, preview, attempts, history, history, history, session, job, input);
        ProcessOperations.close_input(session, job) => service.close_input(control, jobs, preview, attempts, history, history, history, session, job);
        ProcessOperations.stop(session, job) => service.stop(control, jobs, archive, preview, attempts, history, history, history, session, job);
        ProcessOperations.list(session) => service.list(jobs, session);
        ProcessOperations.output(session, job) => service.output(jobs, archive, history, history, session, job);
    };
}
