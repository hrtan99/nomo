module app.contract_probe;

import std.io.println;
import nomo.domain.editing.Prepared;
import nomo.domain.editing.Selector;
import nomo.domain.editing.Confirmed;
import nomo.domain.editing.prepare_original;
import nomo.domain.editing.Prepared as AdapterPrepared;
import nomo.domain.editing.prepare_original as adapter_prepare_original;
import nomo.domain.editing.Selector as CoordinatorSelector;
import nomo.domain.editing.Confirmed as CoordinatorConfirmed;
import nomo.domain.editing.Binding;

flow adapter_value(value: AdapterPrepared) -> Prepared { return value; }
flow selector_value(value: CoordinatorSelector) -> Selector { return value; }
flow confirmed_value(value: CoordinatorConfirmed) -> Confirmed { return value; }
public flow pure_probe() -> bool {
    let direct = match prepare_original("note.txt", "old", "old", "new") { Ok(value) => value, Err(_) => { return false; } };
    let facade = match adapter_prepare_original("note.txt", "old", "old", "new") { Ok(value) => value, Err(_) => { return false; } };
    let selector = Selector { id = "op", workspace = "owned", path = "note.txt" };
    let binding = Binding { id = "op", workspace = "owned", region = "nomo.application.resources.EditableRoot", path = "note.txt",
        request_digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        before_digest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        after_digest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", before_bytes = 3, after_bytes = 3 };
    let confirmed = Confirmed { binding = binding, after = "new" };
    return adapter_value(facade) == direct && selector_value(selector) == selector && confirmed_value(confirmed) == confirmed;
}
public flow observe(args: Array<string>) -> i32 {
    if !pure_probe() { abort("edit contract compatibility identity differs"); }
    println("PASS facade_reexports_preserve_nominal_identity");
    return 0;
}
