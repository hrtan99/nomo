module nomo.harness.edit_original;

import std.fs.Region;
import std.fs.IOError as FileError;
import std.effects.Fs;

// The application requests the original text once. Native file exceptions
// escape unchanged; a returned refusal never implies a file was modified.
public spec OriginalReader<R ~ Region>: callable string => Result<string, string> ![Fs.stat<R>, Fs.read<R>, Error<FileError>, Error<IndexError>];
public effect EditOriginal { action read(path: string) -> Result<string, string>; }
