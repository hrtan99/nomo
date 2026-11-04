module nomo.harness.edit_original;

import std.fs.Region;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.edit_contract.Prepared;

// The application requests the original text once. Native file exceptions
// escape unchanged; a returned refusal never implies a file was modified.
public spec OriginalReadFunction<R ~ Region>: callable string => Result<string, string> ![Fs.stat<R>, Fs.read<R>, Error<FileError>, Error<IndexError>];
public spec OriginalReader<R ~ Region> {
    flow read_original(self, path: string) -> Result<string, string> ![Fs.stat<R>, Fs.read<R>, Error<FileError>, Error<IndexError>];
}
public spec EditApplier<R ~ Region> {
    flow apply(self, prepared: Prepared) -> Result<bool, string> ![Fs.stat<R>, Fs.read<R>, Fs.atomic_replace<R>, Error<FileError>, Error<IndexError>];
}
public effect EditOriginal { action read(path: string) -> Result<string, string>; }
