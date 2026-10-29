module nomo.entry.edit_context;

import std.io.println;
import nomo.tools.edit_encoding.json;
import nomo.tools.edit_contract.Selector;
public import nomo.harness.edit_context.{context, completed_context};

public flow recorded(selector: Selector) -> unit {
    println("EDIT completed " + selector.id + "; aggregation cannot change the recorded outcome; do not replay.");
    match json(["edit_status", "--id", selector.id, "--workspace", selector.workspace, "--path", selector.path]) {
        Ok(value) => { println("NEXT " + value); }
        Err(_) => { println("Recorded operation is available through edit_status with the same selectors."); }
    }
}
public flow display(prefix: string, text: string) -> unit {
    match json([text]) { Ok(value) => { println(prefix + value); } Err(error) => { abort(error); } }
}
