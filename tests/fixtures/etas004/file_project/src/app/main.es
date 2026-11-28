module app.main;

import std.fs.IOError;
import std.fs.Region;
import std.fs.WorkspacePath;
import std.fs.atomic_replace;
import std.fs.read_bytes;
import std.fs.write_bytes;

public flow read_path<R ~ Region>(path: WorkspacePath<R>) -> bytes ![Error<IOError>]
{
    return read_bytes(path);
}

public flow write_path<R ~ Region>(path: WorkspacePath<R>, body: bytes) -> unit ![Error<IOError>]
{
    write_bytes(path, body);
}

public flow replace_path<R ~ Region>(path: WorkspacePath<R>, body: bytes) -> unit ![Error<IOError>]
{
    atomic_replace(path, body);
}

flow main(args: Array<string>) -> i32
{
    return 0;
}
