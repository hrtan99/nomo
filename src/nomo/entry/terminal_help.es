module nomo.entry.terminal_help;

import std.io.println;
import std.collections.len as count;

// Console-only: this module imports no work, inference, approval or storage path.
public flow help(args: Array<string>) -> i32 {
    if count(args) > 1 || (count(args) == 1 && args[0] != "help" && args[0] != "--help") {
        println("REFUSED terminal_help accepts no arguments or one --help."); return 1;
    }
    println("Nomo terminal: line-oriented wrapper around the existing two-turn work chain.");
    println("terminal new --id ROOT --child-id CHILD --workspace BIND --path FILE --allow FILE[,FILE] [--cap CSV] [--once REQUEST]");
    println("terminal continue --parent ROOT --id CHILD --workspace BIND --path FILE --allow FILE[,FILE] [--cap CSV] [--once REQUEST]");
    println("terminal continue --latest --id CHILD --workspace BIND --path FILE --allow FILE[,FILE] [--cap CSV] [--once REQUEST]");
    println("terminal_once new|continue OPTIONS --once REQUEST (supported non-TTY entry, native Deny profile)");
    println("terminal_help [--help]");
    println("Use one privately prepared fixed fixture/store. Root and child IDs must differ; continuation names its parent explicitly.");
    println("--latest resolves only a confirmed first parent with no second slot; explicit --parent conflicts. Native continuation admission and both confirmations still apply.");
    println("Commands: /help, /show, /exit; EOF stops. Requests:1..128 printable ASCII characters before trimming; at most32 input lines.");
    println("--once runs only the selected request and never reads a second request. A blank line is invalid, not EOF.");
    println("Only a confirmed first-turn result offers the second request. Failed, denied or uncertain work stops; no retry, refund, replay or third turn.");
    println("TTY edits require fresh native and Nomo confirmation. The supported non-TTY launcher requires --once and selects native Deny.");
    println("Non-TTY mode never reads an outer request line. Native denial returns before Nomo y/yes, so piped text cannot approve an edit.");
    println("SESSION shows configured per-turn policy and remaining turn positions in this process; these values are not durable availability or Provider usage.");
    println("/show selects only the bound root/current child. Its captured records and remaining allocation are historical, not current File observations or a continuation grant.");
    println("Existing work events show main/child, tools, preview, approval, durable intent and completion in their original order.");
    println("--cap uses steps,calls,generation,native_tokens,read_tools,scan,edit_reads,edit_read_bytes,atomic,atomic_bytes; existing whole-turn admission remains authoritative.");
    println("Default per-turn cap:13,7,47104,196608,1,4096,3,6144,1,2048. Work-chain lifetime supports at most two turns.");
    println("After interruption inspect the existing work/journal state with the bound IDs. Do not replay or infer that no edit occurred.");
    println("Host: ./scripts/local-tryout.sh terminal-help; ./scripts/local-tryout.sh terminal PREPARED_DIRECTORY new|continue OPTIONS");
    return 0;
}
