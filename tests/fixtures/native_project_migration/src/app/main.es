module app.main;

import std.io.println;
import std.io.IOError;
import std.effects.Fs;
import std.fs.IOError as FileError;
import std.fs.ReadLimitError;
import app.source.FixtureSource;
import nomo.application.resources.MigrationRoot;
import nomo.application.transfer.migration.project_state_migrate as migrate;
import nomo.adapters.storage.migration.NativeStateWriter;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.domain.wire.encode;

public flow main(args: Array<string>) -> i32
    ![Fs.read<MigrationRoot>, Memory, Console, Error<FileError>, Error<ReadLimitError>, Error<IndexError>, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>, Error<IOError>] {
    let destination = NativeStateWriter {};
    let report = migrate(FixtureSource {}, destination, destination, NativeHistory {});
    println(match encode(report, "migration report conversion failed", "migration report encoding failed") {
        Ok(value) => value, Err(error) => abort(error),
    });
    return 0;
}
