module nomo.adapters.cli.projects;

import std.io.{println, print, read_line, IOError};
import std.text.from_usize;
import nomo.domain.serialization.json.encode;
import nomo.application.projects.ports.ProjectRenderer;

public type TerminalProjects = {};
impl TerminalProjects ~ ProjectRenderer {
    flow item(self, index: usize, path: string) -> unit ![Console, Error<IOError>] { println("[PROJECT] " + from_usize(index) + " " + path); }
    flow choose(self) -> string ![Console, Error<IOError>] { print("project> folder path or saved number (blank cancels): "); return read_line(); }
    flow preview(self, path: string) -> unit ![Console, Error<IOError>] {
        let value = match encode(path, "project path conversion failed", "project path encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
        println("[OPEN   ] " + value);
    }
}
