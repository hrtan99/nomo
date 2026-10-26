module app.contract_probe;

import std.io.println;
import std.text.split;
import std.json.parse as parse_json;
import std.agent.message.Message;
import nomo.cli.edit_args.{Options, parse};
import nomo.tools.edit_encoding.{json, object, digest};
import nomo.session.edit_operation.{Binding, Record, binding_error, record_error, same_binding, same_record};

type Check = { label: string, passed: bool };
flow slash() -> string { return split("\\/", "")[1]; }
flow checks() -> Array<Check> { return __CHECKS__; }

flow arguments(input: Array<string>, applying: bool, expected: Options, error: string) -> bool {
    return match parse(input, applying) {
        Ok(value) => error == "" && value == expected,
        Err(value) => error != "" && value == error
    };
}

flow encoded(values: Array<string>, expected: string, error: string) -> bool {
    return match json(values) {
        Ok(value) => {
            if error != "" || value != expected { return false; }
            let parsed = match parse_json(value) { Ok(item) => item, Err(_) => { return false; } };
            let message = Message.new(parsed);
            let converted: Option<Message<Array<string>>> = message.cast<Array<string>>();
            return match converted { Some(item) => item.body == values, None() => false };
        }
        Err(value) => error != "" && value == error
    };
}

flow named(keys: Array<string>, values: Array<string>, expected: string, error: string) -> bool {
    return match object(keys, values) {
        Ok(value) => error == "" && value == expected,
        Err(value) => error != "" && value == error
    };
}

flow hashed(text: string, expected: string) -> bool {
    return match digest(text) { Ok(value) => value == expected, Err(_) => false };
}

flow different_bindings(original: Binding, changed: Array<Binding>) -> bool {
    if !same_binding(original, original) { return false; }
    let record = Record { format = 1, phase = "intent", binding = original };
    for value in changed limit Iterations(9) {
        let changed_record = Record { format = 1, phase = "intent", binding = value };
        if same_binding(original, value) || same_binding(value, original) ||
            same_record(record, changed_record) { return false; }
    }
    return true;
}

public flow pure_probe() -> bool {
    for item in checks() limit Iterations(20) { if !item.passed { return false; } }
    return true;
}

public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(20) {
        if !item.passed { println("FAIL " + item.label); abort("edit pure contract failed"); }
        println("PASS " + item.label);
    }
    return 0;
}
