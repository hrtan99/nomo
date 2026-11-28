module nomo.bootstrap.main;

import nomo.adapters.cli.console.{
    ConsoleCommandPreview,
    ConsoleConversationPicker,
    ConsoleLines,
    ConsoleTerminalDisplay,
    ConsoleTerminalInput,
    TerminalProjects,
    TerminalTransfer
};
import nomo.adapters.cli.input.options_parse;
import nomo.adapters.codec.{JsonArchiveEncoding, JsonConfigurationCodec, RollingContext};
import nomo.adapters.filesystem.editing.ProjectMutationFiles;
import nomo.adapters.filesystem.migration.{LegacyNativePacket, ProjectStatePacket};
import nomo.adapters.filesystem.workspace.{
    NativeProjectLaunch,
    ProjectArchives,
    ProjectConfigurationFile,
    ProjectFiles,
    ProjectInstructionFiles
};
import nomo.adapters.model.coding.NativeCodingModel;
import nomo.adapters.model.summary.NativeSummaryModel;
import nomo.adapters.process.commands.HostCommandRunner;
import nomo.adapters.process.configuration.TaploConfigurationConverter;
import nomo.adapters.process.jobs.HostProcessControl;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.adapters.storage.jobs.{NativeJobs, NativeOutputArchive};
import nomo.adapters.storage.journals.{NativeAttempts, NativeChangeJournals};
import nomo.adapters.storage.migration.NativeStateWriter;
import nomo.adapters.storage.workspace.{NativeConfigurationCache, NativeRecentProjects};
import nomo.application.conversation.interactive.{TerminalApplication, output as interactive_output};
import nomo.application.conversation.ports.{
    ConversationReader,
    ConversationWriter,
    GenerationReservation,
    ResultPublication
};
import nomo.application.conversation.session.Conversation;
import nomo.application.editing.changes.operations;
import nomo.application.execution.commands.bindings;
import nomo.application.execution.jobs.bindings as jobs_bindings;
import nomo.application.execution.ports.AttemptRepository;
import nomo.application.migration.ports.MigrationRoot;
import nomo.application.transfer.migration.{native_state_migrate, project_state_migrate};
import nomo.application.transfer.service.operations as service_operations_2;
import nomo.application.workspace.service.{
    ConfigurationLoader,
    bindings as service_bindings,
    operations as service_operations
};
import nomo.domain.archives.MigrationReport;
import nomo.domain.conversation.EntryMode;
import nomo.domain.wire.encode;
import nomo.native.projects.LaunchRoot;
import nomo.native.workspace.ProjectRoot;
import std.effects.Fs;
import std.fs.{IOError as fs_IOError, ReadLimitError};
import std.io.{IOError, println};

public alias ConfiguredConfiguration<H ~ ConversationReader> = ConfigurationLoader<H, ProjectConfigurationFile, JsonConfigurationCodec, TaploConfigurationConverter, NativeConfigurationCache>;

public flow configuration_create<H ~ ConversationReader>(history: H) -> ConfiguredConfiguration<H> {
    return ConfiguredConfiguration<H> {
        history,
        source = ProjectConfigurationFile {},
        codec = JsonConfigurationCodec {},
        converter = TaploConfigurationConverter {},
        cache = NativeConfigurationCache {},
    };
}

public alias ConfiguredConversation<H ~ ConversationReader + ConversationWriter + GenerationReservation + ResultPublication, A ~ AttemptRepository> = Conversation<H, A, ProjectInstructionFiles, NativeJobs, NativeCodingModel, NativeSummaryModel, RollingContext, ConfiguredConfiguration<H>, ConsoleLines>;

public flow conversation_create<H ~ ConversationReader + ConversationWriter + GenerationReservation + ResultPublication, A ~ AttemptRepository>(history: H, attempts: A, instructions: ProjectInstructionFiles, jobs: NativeJobs, output: ConsoleLines) -> ConfiguredConversation<H, A> {
    return ConfiguredConversation<H, A> {
        history,
        attempts,
        instructions,
        jobs,
        coding = NativeCodingModel {},
        summary = NativeSummaryModel {},
        projection = RollingContext {},
        configuration = configuration_create(history),
        output,
    };
}

public flow main_run(args: Array<string>, mode: EntryMode) -> i32
    ![Agentic, Memory, Console, Command.run<DefaultCommandSandbox>, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Fs.atomic_replace<LaunchRoot>, Error<StorageError>, Error<MemoryConflict>, Error<fs_IOError>, Error<ReadLimitError>, Error<IOError>, Error<IndexError>, Error<BudgetExceeded>] {
    let history = NativeHistory {};
    let attempts = NativeAttempts {};
    let jobs = NativeJobs {};
    let guidance = ProjectInstructionFiles {};
    let output = ConsoleLines {};
    let application = TerminalApplication<NativeHistory, NativeAttempts, ConsoleConversationPicker, ConfiguredConversation<NativeHistory, NativeAttempts>, ConsoleTerminalInput> {
        history,
        attempts,
        picker = ConsoleConversationPicker {},
        input = ConsoleTerminalInput {},
        conversation = conversation_create(history, attempts, guidance, jobs, output),
    };
    // Bind factories in their original outer-to-inner order before composing.
    let terminal = interactive_output(ConsoleTerminalDisplay {});
    let commands = bindings(history, attempts, HostCommandRunner {}, ConsoleCommandPreview {});
    let observations = service_bindings(history, ProjectFiles {}, guidance);
    let changes = operations(ProjectMutationFiles {}, NativeChangeJournals {}, history, output);
    let folders = service_operations(NativeRecentProjects {}, NativeProjectLaunch {}, TerminalProjects {});
    let archives = service_operations_2(history, attempts, ProjectArchives {}, JsonArchiveEncoding {}, TerminalTransfer {});
    let jobs_handler = jobs_bindings(history, attempts, HostProcessControl {}, jobs, NativeOutputArchive {}, output);
    return ((((((application.run(options_parse(args), mode) with jobs_handler)
        with archives) with folders) with changes)
        with observations) with commands) with terminal;
}

public flow native_migration_run(args: Array<string>) -> i32
    ![Fs.read<MigrationRoot>, Memory, Console, Error<fs_IOError>, Error<ReadLimitError>, Error<IndexError>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    let report = native_state_migrate(LegacyNativePacket {}, NativeStateWriter {});
    return output(report);
}

public flow project(args: Array<string>) -> i32
    ![Fs.read<MigrationRoot>, Memory, Console, Error<fs_IOError>, Error<ReadLimitError>, Error<IndexError>, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>, Error<IOError>] {
    let destination = NativeStateWriter {};
    return output(project_state_migrate(ProjectStatePacket {}, destination, destination, NativeHistory {}));
}

flow output(report: MigrationReport) -> i32 ![Console, Error<IOError>] {
    println("[MIGRATE] " + match encode(report, "migration report conversion failed", "migration report encoding failed") {
        Ok(value) => value, Err(error) => abort(error),
    });
    return 0;
}
