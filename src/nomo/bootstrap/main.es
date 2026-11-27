module nomo.bootstrap.main;

import nomo.application.conversation.terminal as entry;
import nomo.application.conversation.terminal_handlers;
import nomo.adapters.cli.conversation.{ConsoleTerminalInput, ConsoleTerminalDisplay};
import nomo.adapters.cli.native.options.parse;
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
    let application = entry.TerminalApplication<NativeHistory, NativeAttempts, ConsoleConversationPicker, ConfiguredConversation<NativeHistory, NativeAttempts>, ConsoleTerminalInput> {
        history,
        attempts,
        picker = ConsoleConversationPicker {},
        input = ConsoleTerminalInput {},
        conversation = conversation.create(history, attempts, guidance, jobs, output),
    };
    // Bind factories in their original outer-to-inner order before composing.
    let terminal = terminal_handlers.output(ConsoleTerminalDisplay {});
    let commands = command.bindings(history, attempts, HostCommandRunner {}, ConsoleCommandPreview {});
    let observations = workspace.bindings(history, ProjectFiles {}, guidance);
    let changes = mutations.operations(ProjectMutationFiles {}, NativeChangeJournals {}, history, output);
    let folders = projects.operations(NativeRecentProjects {}, NativeProjectLaunch {}, TerminalProjects {});
    let archives = transfer.operations(history, attempts, ProjectArchives {}, JsonArchiveEncoding {}, TerminalTransfer {});
    let jobs_handler = processes.bindings(history, attempts, HostProcessControl {}, jobs, NativeOutputArchive {}, output);
    return ((((((application.run(parse(args)) with jobs_handler)
        with archives) with folders) with changes)
        with observations) with commands) with terminal;
}
