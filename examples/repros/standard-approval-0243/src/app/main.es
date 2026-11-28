module app.main;

import std.io.{println, IOError};
import std.effects.Approval;
import std.runtime.approval.{approve, Risk};

public flow main(args: Array<string>) -> i32 ![Console, Approval, Error<IOError>] {
    println("BEFORE_APPROVAL");
    let accepted = approve("Synthetic SDK approval", "synthetic payload only", Risk.Low);
    println(if accepted { "ACCEPTED" } else { "REJECTED" });
    return 0;
}
