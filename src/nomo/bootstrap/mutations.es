module nomo.bootstrap.mutations;

import nomo.application.mutations.ports.ChangeOperations;
import nomo.adapters.filesystem.mutation_files.ProjectMutationFiles;
import nomo.adapters.storage.change_journals.NativeChangeJournals;
import nomo.adapters.storage.mutation_history.NativeMutationHistory;
import nomo.adapters.cli.mutations.TerminalMutationOutput;

import nomo.application.mutations.service;
import nomo.application.commands.effects.CommandOperations;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;
import nomo.native.workspace.ProjectRoot;
import nomo.application.conversation.session_context.SessionContext;
import nomo.domain.mutations.models.{Change, ChangeOutcome, Journal, FileChange, FileOutcome};
import nomo.application.mutations.ports.{MutationFiles, ChangeJournal, MutationHistory, MutationOutput, MutationFileAccess, ChangeJournalStore, MutationHistoryStore, MutationOutputSink};

flow bindings<F ~ MutationFileAccess, J ~ ChangeJournalStore, H ~ MutationHistoryStore, O ~ MutationOutputSink>(files: F, journals: J, history: H, output: O) -> ![MutationFiles, ChangeJournal, MutationHistory, MutationOutput => SessionContext.current, CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>, Error<BudgetExceeded>] ![] {
    return handler {
        MutationFiles.normalize(path) => files.normalize(path);
        MutationFiles.exists(path) => files.exists(path);
        MutationFiles.read(path) => files.read(path);
        MutationFiles.replace(path, text) => files.replace(path, text);
        MutationFiles.command(program, arguments, call) => files.command(program, arguments, call);
        ChangeJournal.lookup(id) => journals.lookup(id);
        ChangeJournal.insert(value) => journals.insert(value);
        ChangeJournal.save(value) => journals.save(value);
        ChangeJournal.step(key) => journals.step(key);
        ChangeJournal.save_step(key, value) => journals.save_step(key, value);
        ChangeJournal.list(selected) => journals.list(selected);
        MutationHistory.record(role, name, value, call) => history.record(role, name, value, call);
        MutationHistory.finish(name, call, value) => history.finish(name, call, value);
        MutationHistory.session(id) => history.session(id);
        MutationHistory.pending(id) => history.pending(id);
        MutationHistory.message(id, index) => history.message(id, index);
        MutationHistory.published(id, call, name) => history.published(id, call, name);
        MutationOutput.write(line) => output.write(line);
    };
}

public flow execute<F ~ MutationFileAccess, J ~ ChangeJournalStore, H ~ MutationHistoryStore, O ~ MutationOutputSink>(files: F, journals: J, history: H, output: O, session: string, operation: string, name: string, changes: Array<Change>, edit: string) -> ChangeOutcome
    ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>, Error<BudgetExceeded>] {
    return handle (service.execute(operation, name, changes, edit) with bindings(files, journals, history, output)) with { SessionContext.current() => session; };
}

public flow replace<F ~ MutationFileAccess, J ~ ChangeJournalStore, H ~ MutationHistoryStore, O ~ MutationOutputSink>(files: F, journals: J, history: H, output: O, session: string, change: FileChange) -> FileOutcome
    ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>, Error<BudgetExceeded>] {
    return handle (service.replace_file(change) with bindings(files, journals, history, output)) with { SessionContext.current() => session; };
}

public flow list<F ~ MutationFileAccess, J ~ ChangeJournalStore, H ~ MutationHistoryStore, O ~ MutationOutputSink>(files: F, journals: J, history: H, output: O, session: string, observing: bool) -> Array<Journal>
    ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>, Error<BudgetExceeded>] {
    return handle (service.list(observing) with bindings(files, journals, history, output)) with { SessionContext.current() => session; };
}

public flow operations() -> ![ChangeOperations => CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>, Error<BudgetExceeded>] ![] {
    let files = ProjectMutationFiles {};
    let journals = NativeChangeJournals {};
    let history = NativeMutationHistory {};
    let output = TerminalMutationOutput {};
    return handler {
        ChangeOperations.apply(session, name, changes) => execute(files, journals, history, output, session, "apply", name, changes, "");
        ChangeOperations.undo(session, edit) => execute(files, journals, history, output, session, "undo", "", [], edit);
        ChangeOperations.rollback(session, edit) => execute(files, journals, history, output, session, "rollback", "", [], edit);
        ChangeOperations.reconcile(session, edit) => execute(files, journals, history, output, session, "reconcile", "", [], edit);
        ChangeOperations.replace(session, change) => replace(files, journals, history, output, session, change);
        ChangeOperations.list(session) => list(files, journals, history, output, session, false);
        ChangeOperations.inspect(session) => list(files, journals, history, output, session, true);
    };
}
