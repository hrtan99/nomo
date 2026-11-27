module nomo.application.migration.ports;

import std.fs.{Region, IOError as FileError, ReadLimitError};
import std.effects.Fs;
import nomo.domain.migration.native_state.{NativeRecord, NativeImage};

public type MigrationRoot;
impl MigrationRoot ~ Region;

public spec NativeStateSource {
    flow load(self) -> NativeImage ![Fs.read<MigrationRoot>, Error<FileError>, Error<ReadLimitError>, Error<IndexError>];
}
public spec NativeStateDestination {
    flow insert(self, record: NativeRecord) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
}
