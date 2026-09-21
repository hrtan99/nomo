module app.main;
import std.io.println;
import std.memory.{prepare_put, operation_ref, Missing};
import std.memory.WriteOutcome as Write;
import std.memory.ReconcileResult as Lookup;
import std.memory.ConfirmedOutcome as Confirmation;

alias Schema = MemoryRegion<{ Items: Store<string, string> }>;
let Region = std.memory.region<Schema>(stable_id = "etas013-policy", store = "test");

flow permitted(outcome: Write<string, string>) -> bool {
    return match outcome {
        Write.Committed(receipt) => true,
        Write.NotCommitted(operation, reason) => false,
        Write.Unknown(operation) => false,
    };
}

flow reconciled(outcome: Lookup<string, string>) -> bool {
    return match outcome {
        Lookup.Found(Confirmation.Committed(receipt)) => true,
        Lookup.Found(Confirmation.NotCommitted(operation, reason)) => false,
        Lookup.Unresolved => false,
        Lookup.Expired => false,
    };
}

// Inject typed outcomes only. Actual acknowledgement loss is a separate Host test.
flow main(args: Array<string>) -> i32 ![Console, Error<StorageError>, Error<IOError>] {
    let op = operation_ref(prepare_put(Region.Items, "key", "synthetic", Missing));
    if permitted(Write.Unknown(op)) { println("UNSAFE_UNKNOWN"); }
    if permitted(Write.NotCommitted(op, "denied")) { println("UNSAFE_DENIED"); }
    if reconciled(Lookup.Unresolved) { println("UNSAFE_UNRESOLVED"); }
    if reconciled(Lookup.Expired) { println("UNSAFE_EXPIRED"); }
    if reconciled(Lookup.Found(Confirmation.NotCommitted(op, "denied"))) { println("UNSAFE_FOUND"); }
    if permitted(Write.Committed("test receipt")) { println("COMMITTED_MARKER"); }
    if reconciled(Lookup.Found(Confirmation.Committed("test receipt"))) { println("RECONCILED_MARKER"); }
    return 0;
}
