module nomo.native.file_io;

import std.fs.{path, read_bytes_limited};
import std.codec.text.{utf8_decode, Strict};
import nomo.native.workspace.ProjectRoot;

public flow read_text(pathname: string) -> string {
    let location = match path<ProjectRoot>(pathname) {
        Ok(value) => value, Err(_) => { abort("invalid project file path"); }
    };
    return match utf8_decode(read_bytes_limited(location, 536870912), Strict) {
        Ok(value) => value, Err(_) => { abort("project file is not UTF-8"); }
    };
}
