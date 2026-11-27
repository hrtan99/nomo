module nomo.application.processes.handlers;

import nomo.application.processes.service;
import std.io.IOError;
import nomo.application.processes.ports.{ProcessOperations, ProcessControl, JobRepository, OutputArchive, ProcessPreviewSink, ArchivedJobCatalog, ArchivedJobParts};
import nomo.application.conversation.ports.{ConversationReader, ConversationWriter, ResultPublication};
import nomo.application.execution.ports.AttemptRepository;

public flow bindings<H ~ ConversationReader + ConversationWriter + ResultPublication, A ~ AttemptRepository, J ~ JobRepository + ArchivedJobCatalog + ArchivedJobParts, O ~ ProcessPreviewSink, Live, C ~ ProcessControl<Live>, R ~ OutputArchive>(history: H, attempts: A, control: C, jobs: J, archive: R, preview: O) -> ![ProcessOperations => Memory, Console, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<BudgetExceeded>] ![] {
    return handler {
        ProcessOperations.start(session, program, arguments) => service.start(control, jobs, preview, attempts, history, history, history, session, program, arguments);
        ProcessOperations.read(session, job, max_bytes) => service.read(control, jobs, archive, preview, attempts, history, history, history, session, job, max_bytes);
        ProcessOperations.write(session, job, input) => service.write(control, jobs, preview, attempts, history, history, history, session, job, input);
        ProcessOperations.close_input(session, job) => service.close_input(control, jobs, preview, attempts, history, history, history, session, job);
        ProcessOperations.stop(session, job) => service.stop(control, jobs, archive, preview, attempts, history, history, history, session, job);
        ProcessOperations.list(session) => service.list(jobs, session);
        ProcessOperations.output(session, job) => service.output(jobs, archive, history, history, session, job);
        ProcessOperations.archived_jobs(session) => service.archived_jobs(jobs, history, session);
        ProcessOperations.archived_output(session, job, part) => service.archived_output(jobs, history, session, job, part);
    };
}
