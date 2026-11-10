module nomo.project.contracts;

public type Change = { operation: string, path: string, target: string, text: string };
public type Action = { tool: string, path: string, target: string, text: string, arguments: Array<string>, changes: Array<Change>, start: string, end: string };
public type Message = { id: i32, role: string, name: string, content: string };
public type Instruction = { scope: string, text: string };
public type Context = { root: string, initial_request: string, request: string, instructions: Array<Instruction>, history: Array<Message>, context_window: i32, output_allowance: i32, estimated_tokens: i32 };
public type Tool = { name: string, description: string, mutates: bool };

public spec ProjectToolCatalog {
    flow entries(self) -> Array<Tool> ![];
    flow contains(self, name: string) -> bool ![];
}
public spec ProjectModel {
    flow next(self, context: Context, tools: Array<Tool>) -> Action ![];
    flow summarize(self, context: Context) -> string ![];
}
public spec ContextPolicy {
    flow available(self, context: Context) -> i32 ![];
}
public type WindowPolicy = {};
impl WindowPolicy ~ ContextPolicy {
    flow available(self, context: Context) -> i32 {
        return context.context_window - context.output_allowance - context.estimated_tokens;
    }
}

public type CodingTools = {};
impl CodingTools ~ ProjectToolCatalog {
    flow entries(self) -> Array<Tool> {
        return [
            Tool { name = "answer", description = "Finish by answering the user in text. Do not claim unobserved changes or checks.", mutates = false },
            Tool { name = "tree", description = "Directory tree: path defaults to project root; end is depth (default 3). Honors .gitignore.", mutates = false },
            Tool { name = "glob", description = "Find project files with glob pattern in text, including **; honors .gitignore.", mutates = false },
            Tool { name = "read", description = "Read UTF-8 path with line numbers, from start to end inclusive; zero end means EOF.", mutates = false },
            Tool { name = "search", description = "Search literal text under path; returns matching file, line and body. Honors .gitignore.", mutates = false },
            Tool { name = "regex", description = "Search regex text under path; returns matching file, line and body. Honors .gitignore.", mutates = false },
            Tool { name = "create", description = "Create a new file at path with complete content in text; parent directories are created.", mutates = true },
            Tool { name = "write", description = "Write complete UTF-8 file content in text, creating path if needed.", mutates = true },
            Tool { name = "edit", description = "Replace the unique literal target in path with text; read the original first.", mutates = true },
            Tool { name = "mkdir", description = "Create directory path and parents.", mutates = true },
            Tool { name = "delete", description = "Delete file or directory path; recoverable through undo.", mutates = true },
            Tool { name = "move", description = "Move or rename path to target; destination must not exist.", mutates = true },
            Tool { name = "batch", description = "Preview and apply changes together. Each Change has operation=create/write/edit/mkdir/delete/move, path, target and text; unused strings are empty. Prefer one batch for related multi-file edits. A failed application rolls back the batch.", mutates = true },
            Tool { name = "undo", description = "Undo the latest batch, or edit ID in target; requires current files to match recorded results.", mutates = true },
            Tool { name = "exec", description = "Run arguments as an argv array in the project with a PTY. Long processes return a retained job ID. Shell syntax requires explicit /bin/sh -c.", mutates = true },
            Tool { name = "spawn", description = "Start persistent background/interactive process from arguments argv. Returns job ID; use poll/write_stdin/stop.", mutates = true },
            Tool { name = "poll", description = "Read job target from byte offset start; returns next offset, output and exit status. Output is also saved in full.", mutates = false },
            Tool { name = "jobs", description = "List retained process jobs for this project.", mutates = false },
            Tool { name = "write_stdin", description = "Send text to the PTY of job target. Include newline to submit interactive input.", mutates = true },
            Tool { name = "stop", description = "Terminate process group of job target.", mutates = true }
        ];
    }
    flow contains(self, name: string) -> bool {
        for tool in self.entries() limit Iterations(64) { if tool.name == name { return true; } }
        return false;
    }
}
