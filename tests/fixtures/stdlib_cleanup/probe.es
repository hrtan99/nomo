module app.main;

import std.io.println;
import nomo.domain.text.safe;
import nomo.domain.text.data_safe;
import nomo.domain.text.within;
import nomo.domain.text.hex_digest;
import nomo.domain.harness.loop.Context;
import nomo.domain.harness.loop.candidate_error;
import nomo.domain.context.EventPolicy;
import nomo.domain.context.select;
import nomo.domain.wire.json;
import nomo.domain.wire.digest;
import nomo.domain.wire.ascii_json_with;
import nomo.core.conversation.Event;

flow check(label: string, value: bool) -> unit {
    if !value { abort(label); }
    println("PASS " + label);
}

public flow run(args: Array<string>) -> i32 {
    let large = __LARGE_TEXT__;
    check("1 MiB text", within(large, 1048576) && safe(large, 1048576));
    check("Unicode text", safe("中文😀", 10));
    check("multiline data", data_safe("中文\n\r\t😀", 13));
    let hash = match digest("hello") { Ok(value) => value, Err(error) => abort(error), };
    check("standard SHA and byte mapping", hash == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" && hex_digest(hash));
    let encoded = match json(["前😀"]) { Ok(value) => value, Err(error) => abort(error), };
    check("Unicode JSON builder", encoded == "[\"\\u524d\\ud83d\\ude00\"]");
    let display = match ascii_json_with("\"前😀\"", 32, 32, "encoded", "display") { Ok(value) => value, Err(error) => abort(error), };
    check("display builder", display == "\"\\u524d\\ud83d\\ude00\"");
    check("standard unique paths", candidate_error(["a.txt", "b.txt"]) == "");
    let context = Context { history = [Event { role = "user", kind = "input", name = "", text = "read a.txt" }], allowed = ["a.txt"], final_only = false };
    let result = match select(context, [EventPolicy.Task], 1048576) { Ok(value) => value, Err(_) => abort("selection"), };
    check("ordered selection", result.context == context && result.selected == [0] && result.omitted == []);
    return 0;
}
