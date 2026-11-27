module nomo.bootstrap.main;

import nomo.adapters.cli.conversation as entry;
import nomo.bootstrap.conversation;
import nomo.bootstrap.conversation.ConfiguredConversation;
import nomo.application.commands.handlers as command;
import nomo.application.workspace.handlers as workspace;
import nomo.adapters.filesystem.project_files.ProjectFiles;
import nomo.application.processes.handlers as processes;
import nomo.application.transfer.handlers as transfer;
import nomo.application.projects.handlers as projects;
import nomo.application.mutations.handlers as mutations;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.adapters.storage.attempts.NativeAttempts;
import nomo.adapters.storage.processes.NativeJobs;
import nomo.adapters.filesystem.instructions.ProjectInstructionFiles;
import nomo.adapters.cli.output.ConsoleLines;
import nomo.adapters.process.foreground.HostCommandRunner;
import nomo.adapters.cli.command_preview.ConsoleCommandPreview;
import nomo.adapters.process.processes.HostProcessControl;
import nomo.adapters.storage.processes.NativeOutputArchive;
import nomo.adapters.storage.projects.NativeRecentProjects;
import nomo.adapters.filesystem.launch_control.NativeProjectLaunch;
import nomo.adapters.cli.projects.TerminalProjects;
import nomo.adapters.filesystem.mutation_files.ProjectMutationFiles;
import nomo.adapters.storage.change_journals.NativeChangeJournals;
import nomo.adapters.filesystem.archives.ProjectArchives;
import nomo.adapters.storage.codec.archive_role.JsonArchiveEncoding;
import nomo.adapters.cli.transfer.TerminalTransfer;
import nomo.adapters.cli.conversation_picker.ConsoleConversationPicker;
import nomo.native.projects.LaunchRoot;
import nomo.native.workspace.ProjectRoot;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError;

public flow run(args: Array<string>) -> i32
    ![Agentic, Memory, Console, Command.run<DefaultCommandSandbox>, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Fs.atomic_replace<LaunchRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<IOError>, Error<IndexError>, Error<BudgetExceeded>] {
    let history = NativeHistory {};
    let attempts = NativeAttempts {};
    let jobs = NativeJobs {};
    let guidance = ProjectInstructionFiles {};
    let output = ConsoleLines {};
    let application = entry.application<NativeHistory, NativeAttempts, ConsoleConversationPicker, ConfiguredConversation<NativeHistory, NativeAttempts>>() with {
        history: NativeHistory => history;
        attempts: NativeAttempts => attempts;
        picker: ConsoleConversationPicker => ConsoleConversationPicker {};
        conversation: ConfiguredConversation<NativeHistory, NativeAttempts> => conversation.create(history, attempts, guidance, jobs, output);
    };
    // Runtime handlers interpret requests using the same selected dependencies.
    return handle (
        handle (
            handle (
                handle (
                    handle (
                        handle application.run(args) with processes.bindings(history, attempts, HostProcessControl {}, jobs, NativeOutputArchive {}, output)
                    ) with transfer.operations(history, attempts, ProjectArchives {}, JsonArchiveEncoding {}, TerminalTransfer {})
                ) with projects.operations(NativeRecentProjects {}, NativeProjectLaunch {}, TerminalProjects {})
            ) with mutations.operations(ProjectMutationFiles {}, NativeChangeJournals {}, history, output)
        ) with workspace.bindings(history, ProjectFiles {}, guidance)
    ) with command.bindings(history, attempts, HostCommandRunner {}, ConsoleCommandPreview {});
}
