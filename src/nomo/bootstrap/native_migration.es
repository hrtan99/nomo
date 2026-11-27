module nomo.bootstrap.native_migration;

import std.io.{println, IOError};
import std.effects.Fs;
import std.fs.{IOError as FileError, ReadLimitError};
import nomo.application.migration.native_state.migrate;
import nomo.application.migration.project_state.migrate as migrate_project;
import nomo.domain.migration.native_state.MigrationReport;
import nomo.application.migration.ports.MigrationRoot;
import nomo.adapters.filesystem.native_migration.LegacyNativePacket;
import nomo.adapters.filesystem.project_migration.ProjectStatePacket;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.adapters.storage.native_migration.NativeStateWriter;
import nomo.domain.serialization.json.encode;

public flow run(args: Array<string>) -> i32
    ![Fs.read<MigrationRoot>, Memory, Console, Error<FileError>, Error<ReadLimitError>, Error<IndexError>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    let report = migrate(LegacyNativePacket {}, NativeStateWriter {});
    return output(report);
}

public flow project(args: Array<string>) -> i32
    ![Fs.read<MigrationRoot>, Memory, Console, Error<FileError>, Error<ReadLimitError>, Error<IndexError>, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>, Error<IOError>] {
    let destination = NativeStateWriter {};
    return output(migrate_project(ProjectStatePacket {}, destination, destination, NativeHistory {}));
}

flow output(report: MigrationReport) -> i32 ![Console, Error<IOError>] {
    println("[MIGRATE] " + match encode(report, "migration report conversion failed", "migration report encoding failed") {
        Ok(value) => value, Err(error) => abort(error),
    });
    return 0;
}
