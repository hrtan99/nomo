module nomo.bootstrap.main;

import nomo.adapters.cli.conversation as entry;
import nomo.bootstrap.conversation;
import nomo.bootstrap.command;
import nomo.bootstrap.instructions;
import nomo.bootstrap.processes;
import nomo.bootstrap.transfer;
import nomo.bootstrap.projects;
import nomo.bootstrap.mutations;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.adapters.storage.attempts.NativeAttempts;
import nomo.adapters.cli.conversation_picker.ConsoleConversationPicker;
import nomo.application.conversation.requests.ConversationRequests;
import nomo.native.projects.LaunchRoot;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError;
import nomo.native.workspace.ProjectRoot;
import nomo.application.mutations.ports.ChangeOperations;
import nomo.adapters.filesystem.mutation_files.ProjectMutationFiles;
import nomo.adapters.storage.change_journals.NativeChangeJournals;
import nomo.adapters.storage.mutation_history.NativeMutationHistory;
import nomo.adapters.cli.mutations.TerminalMutationOutput;

public flow run(args: Array<string>) -> i32
    ![Agentic, Memory, Console, Command.run<DefaultCommandSandbox>, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Fs.atomic_replace<LaunchRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<IOError>, Error<IndexError>] {
    let files = ProjectMutationFiles {};
    let journals = NativeChangeJournals {};
    let history = NativeMutationHistory {};
    let output = TerminalMutationOutput {};
    let history_store = NativeHistory {};
    let attempts = NativeAttempts {};
    return handle (handle (handle (handle (handle (handle (handle entry.run(history_store, history_store, history_store, attempts, history_store, ConsoleConversationPicker {}, args) with {
                                ConversationRequests.turn(session, request, check) => conversation.ask(session, request, check);
                                ConversationRequests.compact(session, settings) => conversation.compact(session, settings);
                                ConversationRequests.settings(session, check) => conversation.settings_for(session, check);
                            }) with processes.bindings()) with transfer.operations()) with projects.operations()) with {
                ChangeOperations.apply(session, name, changes) => mutations.execute(files, journals, history, output, session, "apply", name, changes, "");
                ChangeOperations.undo(session, edit) => mutations.execute(files, journals, history, output, session, "undo", "", [], edit);
                ChangeOperations.rollback(session, edit) => mutations.execute(files, journals, history, output, session, "rollback", "", [], edit);
                ChangeOperations.reconcile(session, edit) => mutations.execute(files, journals, history, output, session, "reconcile", "", [], edit);
                ChangeOperations.replace(session, change) => mutations.replace(files, journals, history, output, session, change);
                ChangeOperations.list(session) => mutations.list(files, journals, history, output, session, false);
                ChangeOperations.inspect(session) => mutations.list(files, journals, history, output, session, true);
            }) with instructions.bindings()) with command.bindings();
}
