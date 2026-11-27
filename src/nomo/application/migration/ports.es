module nomo.application.migration.ports;

import std.fs.{Region, IOError as FileError, ReadLimitError};
import std.effects.Fs;
import nomo.domain.migration.native_state.{NativeRecord, NativeImage};
import nomo.domain.migration.project_state.ProjectImage;

public type MigrationRoot;
impl MigrationRoot ~ Region;

public spec NativeStateSource {
    flow load(self) -> NativeImage ![Fs.read<MigrationRoot>, Error<FileError>, Error<ReadLimitError>, Error<IndexError>];
}
public spec NativeStateDestination {
    flow insert(self, record: NativeRecord) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
}

public spec ProjectStateSource {
    flow load(self) -> ProjectImage ![Fs.read<MigrationRoot>, Error<FileError>, Error<ReadLimitError>, Error<IndexError>];
}
public spec HistoricalEvents {
    flow append(self, session: string, role: string, name: string, text: string) -> i64
        ![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>];
}
