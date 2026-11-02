module app.read_unicode_text_probe;

import std.io.println;
import std.text.split;
import std.codec.text.utf8_encode;
import std.bytes.len as bytes_len;
import std.json.{parse, JsonValue};
import std.agent.message.Message;
import nomo.core.read_text.{safe, bounded};
import nomo.cli.read_cli.{parse_args, parse_line};
import nomo.model.read_protocol.{decode_plan, decode_child, answer};
import nomo.tools.read_contract.outcome;
import nomo.tools.read_display.display;
import nomo.tools.read_contract.ReadTools;
import nomo.model.model_tool_contract.{Session, default_limits};
import nomo.agent.read_tool_controller.run_loop_controller;
import nomo.harness.read_tool_contract.fresh;
import nomo.harness.read_model_tools.run_context;
import nomo.harness.legacy_string_stages.{LegacyStringStages, LegacyChildModel};

flow integration() -> bool {
    let result = run_context("请总结文件", ["sample.txt"], fresh(), "fixture-", true, false, false, false) with {
        LegacyStringStages.main(context) => {
            if context.request != "请总结文件" { abort("parent request changed"); }
            if context.phase == "plan" { resume "[\"delegate\",\"读取文件\"]"; }
            if context.task != "读取文件" || context.result != "内容是蓝色" ||
                context.tool != "read" || context.outcome != "complete: 蓝色<LF>" { abort("parent evidence changed"); }
            resume "文件内容是蓝色";
        }
        LegacyStringStages.child(task, allowed, selected) => {
            if task != "读取文件" || allowed != ["sample.txt"] { abort("child dispatch changed"); }
            let initial = Session { history = selected, calls = 0, tokens = 0, tools = 0, scan = 0 };
            let child = run_loop_controller(task, allowed, default_limits(), initial, false, false) with {
                LegacyChildModel.infer(context) => {
                    if context.final_only {
                        if context.history[4].text != "complete: 蓝色<LF>" { abort("child evidence changed"); }
                        resume "[\"final\",\"内容是蓝色\"]";
                    }
                    resume "[\"read\",\"sample.txt\"]";
                }
                ReadTools.read(name) => {
                    if name != "sample.txt" { abort("unexpected read"); }
                    resume outcome("complete", "蓝色" + decoded("u000a"), 7);
                }
                ReadTools.search(_, _) => { abort("unexpected search"); }
            };
            resume child;
        }
    };
    return match result {
        Ok(value) => value.answer == "文件内容是蓝色" && value.ledger.calls == 4 && value.ledger.tools == 1,
        Err(_) => false,
    };
}

flow decoded(code: string) -> string {
    let raw = "\"" + split("\\/", "")[1] + code + "\"";
    let data = match parse(raw) { Ok(value) => value, Err(_) => { abort("bad synthetic JSON"); } };
    let converted: Option<Message<string>> = Message.new(data).cast<string>();
    return match converted { Some(value) => value.body, None() => { abort("bad synthetic string"); } };
}

public flow read_unicode_text_probe(args: Array<string>) -> i32 {
    if !bounded("读取中文", 12) || bounded("读取中文", 11) || !bounded("A🙂", 5) || bounded("A🙂", 4) { abort("UTF-8 byte limit failed"); }
    if !bounded("hello world", 11) || bounded("   ", 3) { abort("basic text validation failed"); }
    let esc = decoded("u001b");
    if bytes_len(utf8_encode(esc)) != 1 { abort("ESC decode length wrong"); }
    if utf8_encode(esc)[0] != 27 { abort("ESC decode byte wrong"); }
    if safe(decoded("u001b"), 8) { abort("ESC accepted"); }
    if safe(decoded("u0085"), 8) { abort("C1 accepted"); }
    if safe(decoded("u202e"), 8) { abort("bidi accepted"); }
    if safe(decoded("u2028"), 8) { abort("separator accepted"); }
    if safe(decoded("ufeff"), 8) { abort("BOM accepted"); }
    match parse_args(["new", "--once", "请总结这份文件"]) {
        Ok(value) => { if value.once != "请总结这份文件" { abort("argument changed"); } }
        Err(_) => { abort("Unicode argument refused"); }
    }
    match parse_line("请总结这份文件" + decoded("u000d") + decoded("u000a")) {
        Ok(value) => { if value.kind != "prompt" || value.text != "请总结这份文件" { abort("line changed"); } }
        Err(_) => { abort("Unicode line refused"); }
    }
    match parse_line("abc" + decoded("u000a") + "extra") { Ok(_) => { abort("embedded line break accepted"); } Err(_) => {} }
    match decode_plan("[\"delegate\",\"请读取文件\"]") {
        Ok(value) => { if value != "请读取文件" { abort("delegation changed"); } }
        Err(_) => { abort("Unicode delegation refused"); }
    }
    match decode_child("[\"read\",\"sample.txt\"]", ["sample.txt"], false) {
        Ok(value) => { if value.operation != "read" { abort("read selection changed"); } }
        Err(_) => { abort("allowed read refused"); }
    }
    match decode_child("[\n \"read\",\n \"sample.txt\"\n]", ["sample.txt"], false) {
        Ok(value) => { if value.operation != "read" { abort("formatted read changed"); } }
        Err(_) => { abort("formatted read refused"); }
    }
    match decode_child("[\"read\",\"sample" + split("\\/", "")[1] + "n.txt\"]", ["sample.txt"], false) {
        Ok(_) => { abort("escaped newline in path accepted"); } Err(_) => {}
    }
    match decode_child("[\"final\",\"内容是蓝色\"]", ["sample.txt"], true) {
        Ok(value) => { if value.text != "内容是蓝色" { abort("child answer changed"); } }
        Err(_) => { abort("Unicode child answer refused"); }
    }
    match decode_child("[\n \"final\",\n \"内容是蓝色\"\n]", ["sample.txt"], true) {
        Ok(value) => { if value.text != "内容是蓝色" { abort("formatted child answer changed"); } }
        Err(_) => { abort("formatted child answer refused"); }
    }
    match decode_plan("[\n \"delegate\",\t \"请读取文件\"\r\n]") {
        Ok(value) => { if value != "请读取文件" { abort("formatted delegation changed"); } }
        Err(_) => { abort("formatted delegation refused"); }
    }
    match decode_child("[\"final\",\"one\nline\"]", ["sample.txt"], true) {
        Ok(_) => { abort("literal newline inside string accepted"); } Err(_) => {}
    }
    match decode_child("[\"final\",\"one" + split("\\/", "")[1] + "nline\"]", ["sample.txt"], true) {
        Ok(_) => { abort("escaped newline in answer accepted"); } Err(_) => {}
    }
    match decode_child("[\"read\",\"other.txt\"]", ["sample.txt"], false) {
        Ok(_) => { abort("unallowed path accepted"); } Err(_) => {}
    }
    match decode_child("[\"read\",\"sample.txt\"]", ["sample.txt"], true) {
        Ok(_) => { abort("read accepted after tool completion"); } Err(_) => {}
    }
    match decode_plan("[\"delegate\",[\"nested\"]]") { Ok(_) => { abort("nested plan accepted"); } Err(_) => {} }
    match decode_plan("[\"delegate\",\"" + split("\\/", "")[1] + "u001b\"]") {
        Ok(_) => { abort("escaped control accepted"); } Err(_) => {}
    }
    match answer("最终答案") { Ok(_) => {} Err(_) => { abort("Unicode answer refused"); } }
    let displayed = display(outcome("complete", "中文<LF>" + decoded("u000a") + "结束", 20));
    if displayed.status != "complete" || displayed.text != "中文<LT>LF><LF>结束" { abort("Unicode display changed"); }
    if display(outcome("complete", "中文" + esc, 7)).status != "unsupported" { abort("unsafe file content accepted"); }
    if !integration() { abort("Unicode parent-child integration failed"); }
    println("PASS bounded UTF-8 text and terminal controls");
    return 0;
}
