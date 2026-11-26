module nomo.bootstrap.mutations;

import nomo.application.mutations.service;
import nomo.application.commands.effects.CommandOperations;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;
import nomo.native.workspace.ProjectRoot;
import nomo.application.conversation.session_context.SessionContext;
import nomo.domain.mutations.models.{Change, ChangeOutcome, Journal, FileChange, FileOutcome};
import nomo.application.mutations.ports.{MutationFiles, ChangeJournal, MutationHistory, MutationOutput, MutationFileAccess, ChangeJournalStore, MutationHistoryStore, MutationOutputSink};

flow bindings<F ~ MutationFileAccess, J ~ ChangeJournalStore, H ~ MutationHistoryStore, O ~ MutationOutputSink>(files: F, journals: J, history: H, output: O, session: string) -> ![SessionContext, MutationFiles, ChangeJournal, MutationHistory, MutationOutput => CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] ![] {
    return handler {
        SessionContext.current() => { resume session; }
        MutationFiles.normalize(path) => { resume files.normalize(path); }
        MutationFiles.exists(path) => { resume files.exists(path); }
        MutationFiles.read(path) => { resume files.read(path); }
        MutationFiles.replace(path, text) => { files.replace(path, text); resume; }
        MutationFiles.command(program, arguments, call) => {
            let result = handle { files.command(program, arguments, call) } with { SessionContext.current() => { resume session; } };
            resume result;
        }
        ChangeJournal.lookup(id) => { resume journals.lookup(id); }
        ChangeJournal.insert(value) => { journals.insert(value); resume; }
        ChangeJournal.save(value) => { journals.save(value); resume; }
        ChangeJournal.step(key) => { resume journals.step(key); }
        ChangeJournal.save_step(key, value) => { journals.save_step(key, value); resume; }
        ChangeJournal.list(selected) => { resume journals.list(selected); }
        MutationHistory.record(role, name, value, call) => {
            let result = handle { history.record(role, name, value, call) } with { SessionContext.current() => { resume session; } };
            resume result;
        }
        MutationHistory.finish(name, call, value) => {
            handle { history.finish(name, call, value) } with { SessionContext.current() => { resume session; } };
            resume;
        }
        MutationHistory.session(id) => { resume history.session(id); }
        MutationHistory.pending(id) => { resume history.pending(id); }
        MutationHistory.message(id, index) => { resume history.message(id, index); }
        MutationHistory.published(id, call, name) => { resume history.published(id, call, name); }
        MutationOutput.write(line) => { output.write(line); resume; }
    };
}

public flow execute<F ~ MutationFileAccess, J ~ ChangeJournalStore, H ~ MutationHistoryStore, O ~ MutationOutputSink>(files: F, journals: J, history: H, output: O, session: string, operation: string, name: string, changes: Array<Change>, edit: string) -> ChangeOutcome
    ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] {
    return handle { service.execute(operation, name, changes, edit) } with bindings(files, journals, history, output, session);
}

public flow replace<F ~ MutationFileAccess, J ~ ChangeJournalStore, H ~ MutationHistoryStore, O ~ MutationOutputSink>(files: F, journals: J, history: H, output: O, session: string, change: FileChange) -> FileOutcome
    ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] {
    return handle { service.replace_file(change) } with bindings(files, journals, history, output, session);
}

public flow list<F ~ MutationFileAccess, J ~ ChangeJournalStore, H ~ MutationHistoryStore, O ~ MutationOutputSink>(files: F, journals: J, history: H, output: O, session: string, observing: bool) -> Array<Journal>
    ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] {
    return handle { service.list(observing) } with bindings(files, journals, history, output, session);
}
