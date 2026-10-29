module app.contract_probe;

import std.io.println;
import nomo.tools.edit_contract.{Prepared, Selector, Confirmed, prepare_original};
import nomo.tools.edit_file.Prepared as AdapterPrepared;
import nomo.tools.edit_file.prepare_original as adapter_prepare_original;
import nomo.entry.edit_coordinator.Selector as CoordinatorSelector;
import nomo.entry.edit_coordinator.Confirmed as CoordinatorConfirmed;
import nomo.session.edit_operation.Binding;

flow adapter_value(value: AdapterPrepared) -> Prepared { return value; }
flow selector_value(value: CoordinatorSelector) -> Selector { return value; }
flow confirmed_value(value: CoordinatorConfirmed) -> Confirmed { return value; }
public flow pure_probe() -> bool {
    let direct = match prepare_original("note.txt", "old", "old", "new") { Ok(value) => value, Err(_) => { return false; } };
    let facade = match adapter_prepare_original("note.txt", "old", "old", "new") { Ok(value) => value, Err(_) => { return false; } };
    let selector = Selector { id = "op", workspace = "owned", path = "note.txt" };
    let binding = Binding { id = "op", workspace = "owned", region = "nomo.tools.edit_file.EditableRoot", path = "note.txt",
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
