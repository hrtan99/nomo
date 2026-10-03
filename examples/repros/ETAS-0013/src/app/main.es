module app.main;
import std.io.println;
import std.memory.{version, Match};

public flow main(args: Array<string>) -> i32 {
    // Synthetic constructor input only, never backend-issued commit evidence.
    let observed = version("synthetic-version-only-not-backend-evidence");
    let condition = Match(observed);
    println("PUBLIC_CONSTRUCTOR_OK");
    return 0;
}
