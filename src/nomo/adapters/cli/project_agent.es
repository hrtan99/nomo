module nomo.adapters.cli.project_agent;

import std.io.println;
import std.fs.{path, read_bytes_limited};
import std.codec.text.{utf8_decode, Strict};
import std.json.parse;
import std.agent.message.Message;
import nomo.domain.serialization.json.encode;
import nomo.domain.projects.contracts.{Context, CodingTools, WindowPolicy};
import nomo.adapters.model.project_planner.CodingModel;
import nomo.project.entry.RequestRoot;

flow load() -> Context {
    let location = match path<RequestRoot>("input.json") { Ok(value) => value, Err(_) => abort("project input path unavailable"), };
    let raw = match utf8_decode(read_bytes_limited(location, 33554432), Strict) { Ok(value) => value, Err(_) => abort("project input must be UTF-8"), };
    let json = match parse(raw) { Ok(value) => value, Err(_) => abort("project input must be JSON"), };
    let converted: Option<Message<Context>> = Message.new(json).cast<Context>();
    return match converted { Some(value) => value.body, None() => abort("project input has invalid shape"), };
}

// One immutable request per native invocation. The caller waits for completion
// before publishing another input; no Console/model replay can race a rewrite.
public flow run(args: Array<string>) -> i32 {
    let model = CodingModel {}; let tools = CodingTools {}; let window = WindowPolicy {};
    if args.len() != 1 { abort("expected next or compact"); }
    let context = load();
    if args[0] == "compact" {
        let summary = model.summarize(context);
        let raw = match encode(summary, "summary conversion failed", "summary encoding failed") { Ok(value) => value, Err(error) => abort(error), };
        println("PROJECT SUMMARY " + raw);
    } else {
        if window.available(context) < 0 { println("PROJECT COMPACT_REQUIRED"); return 1; }
        let action = model.next(context, tools.entries());
        if !tools.contains(action.tool) { abort("unknown project tool"); }
        let raw = match encode(action, "action conversion failed", "action encoding failed") { Ok(value) => value, Err(error) => abort(error), };
        println("PROJECT ACTION " + raw);
    }
    return 0;
}
