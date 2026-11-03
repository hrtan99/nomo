module app.main;
import std.host.command.{command, run};
import std.codec.text.utf8_encode;
import std.io.println;

flow main(args: Array<string>) -> i32 {
    let result = run(command("/bin/sh", ["-c", "printf result-out; printf result-err >&2; exit 7"]), DefaultCommandSandbox);
    if result.exit_code != 7 { println("FAIL exit"); return 1; }
    if result.stdout != utf8_encode("result-out") { println("FAIL stdout"); return 1; }
    if result.stderr != utf8_encode("result-err") { println("FAIL stderr"); return 1; }
    println("PASS command-result");
    return 0;
}
