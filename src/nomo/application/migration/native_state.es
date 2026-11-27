module nomo.application.migration.native_state;

import std.effects.Fs;
import std.fs.{IOError as FileError, ReadLimitError};
import nomo.application.migration.ports.{NativeStateSource, NativeStateDestination, MigrationRoot};
import nomo.domain.migration.native_state.MigrationReport;

// The composition root supplies an unpublished, fresh destination database.
// A failure leaves that destination incomplete; nothing switches the live state.
public flow migrate<S ~ NativeStateSource, D ~ NativeStateDestination>(source: S, destination: D) -> MigrationReport
    ![Fs.read<MigrationRoot>, Memory, Error<FileError>, Error<ReadLimitError>, Error<IndexError>, Error<StorageError>, Error<MemoryConflict>] {
    let image = source.load();
    for record in image.records { destination.insert(record); }
    return MigrationReport { source_sha256 = image.source_sha256, rows = image.records.len() };
}
