module nomo.tools.read_capabilities;

import std.fs.Region;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.read_contract.Outcome;

public type SearchBounds = { files: usize, file_bytes: usize, total_bytes: usize, partial_results: bool };
public spec FileReader<R ~ Region> {
    flow maximum_bytes(self) -> usize ![];
    flow read(self, name: string) -> Outcome ![Fs.read<R>, Error<FileError>, Error<IndexError>];
}
public spec LiteralSearcher<R ~ Region> {
    flow bounds(self) -> SearchBounds ![];
    flow search(self, names: Array<string>, literal: string) -> Outcome ![Fs.read<R>, Error<FileError>, Error<IndexError>];
}
