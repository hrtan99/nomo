module app.main;

import std.io.{println, IOError};
import std.effects.Fs;
import std.fs.{IOError as FileError, ReadLimitError};
import app.source.FixtureSource;
import nomo.application.migration.ports.MigrationRoot;
import nomo.application.migration.project_state.migrate;
import nomo.adapters.storage.native_migration.NativeStateWriter;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.domain.serialization.json.encode;

public flow main(args: Array<string>) -> i32
    ![Fs.read<MigrationRoot>, Memory, Console, Error<FileError>, Error<ReadLimitError>, Error<IndexError>, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>, Error<IOError>] {
    let destination = NativeStateWriter {};
    let report = migrate(FixtureSource {}, destination, destination, NativeHistory {});
    println(match encode(report, "migration report conversion failed", "migration report encoding failed") {
        Ok(value) => value, Err(error) => abort(error),
    });
    return 0;
}
