module nomo.adapters.cli.native.git;

import std.text.{trim, split_once, strip_prefix, parse_i32};
import std.json.parse as parse_json;
import std.agent.message.Message;
import nomo.domain.execution.git.GitRequest;

type CommitRequest = { message: string, paths: Array<string> };

flow json_paths(raw: string) -> Array<string> {
    if trim(raw) == "" { return []; }
    let parsed = match parse_json(raw) { Ok(value) => value, Err(_) => abort("provide paths as a JSON string array"), };
    let converted: Option<Message<Array<string>>> = Message.new(parsed).cast<Array<string>>();
    return match converted { Some(value) => value.body, None() => abort("paths must be a JSON string array"), };
}

/// Parse native Git input into the same application requests used by model tools.
public flow parse(raw: string) -> GitRequest {
    let (operation, rest) = match split_once(trim(raw), " ") { Some(parts) => parts, None() => (trim(raw), "") };
    let argument = trim(rest);
    if operation == "status" { return GitRequest.Status; }
    if operation == "branches" { return GitRequest.Branches; }
    if operation == "init" { return GitRequest.Init; }
    if operation == "branch" { return GitRequest.Branch(argument); }
    if operation == "switch" { return GitRequest.Switch(argument); }
    if operation == "log" {
        let count = if argument == "" { 20 } else { match parse_i32(argument) { Ok(value) => value, Err(_) => abort("expected a Git log count"), } };
        return GitRequest.Log(count);
    }
    if operation == "diff" {
        var staged = false;
        var selected = argument;
        if argument == "--staged" { staged = true; selected = ""; }
        else { match strip_prefix(argument, "--staged ") { Some(value) => { staged = true; selected = value; } None() => (), } }
        return GitRequest.Diff(staged, json_paths(selected));
    }
    if operation == "commit" {
        let parsed = match parse_json(argument) { Ok(value) => value, Err(_) => abort("use /git commit with JSON containing message and paths"), };
        let converted: Option<Message<CommitRequest>> = Message.new(parsed).cast<CommitRequest>();
        let request = match converted { Some(value) => value.body, None() => abort("commit JSON requires message:string and paths:Array<string>"), };
        return GitRequest.Commit(request.message, request.paths);
    }
    abort("Git command: status, diff [--staged] [JSON_PATHS], log [COUNT], branches, init, branch NAME, switch NAME, commit JSON");
}
