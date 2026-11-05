module nomo.entry.session_cli;

import std.io.println;
import std.text.from_i32;
import nomo.cli.session_cli_args.parse;
import nomo.core.conversation.fresh;
import nomo.agent.loop.turn;
import nomo.session.stub_snapshot.{snapshot, caps};
import nomo.session.session_state.Request;
import nomo.session.session_store.{save, reload};
import nomo.session.session_display.display;

// Opt-in entry only. Initialize the fresh project-owned demo store explicitly.
// show is a data projection, never resume, dispatch, repair or ID-only discovery.
public flow run_session(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>] {
    let options = match parse(args) {
        Ok(value) => value, Err(error) => { println("REFUSED " + error); return 2; }
    };
    if options.verb == "help" {
        println("Opt-in stub session storage; initialize a fresh project-owned demo store first.");
        println("save --session ID --save SAVE_ID --binding EXPECTED --input TEXT [--steps 1..16] [--budget 1..16]");
        println("show --session ID --save SAVE_ID --binding EXPECTED [--steps 1..16] [--budget 1..16]");
        println("Defaults: steps 3, budget 16. Show is read-only data, not resumed execution or trusted workspace ownership.");
        return 0;
    }
    let requested = Request { session_id = options.session_id, mode = "stub", binding = options.binding,
        caps = caps(options.maximum, options.budget) };
    var turn_status: i32 = 0;
    let result = if options.verb == "show" { reload(requested, options.save_id) } else {
        let completed = turn(options.input, options.maximum, options.budget, fresh());
        turn_status = completed.status;
        let saved = match snapshot(completed.state, options.session_id, options.binding, options.maximum, options.budget) {
            Ok(value) => value, Err(error) => { println("REFUSED " + error); return 3; }
        };
        save(saved, requested, options.save_id)
    };
    let projection = match result {
        Ok(value) => value, Err(error) => { println("REFUSED " + error); return 3; }
    };
    let output = match display(projection) {
        Ok(value) => value, Err(error) => {
            if options.verb == "save" { println("STORED_DISPLAY_FAILED; do not retry: " + error); }
            else { println("REFUSED " + error); }
            return 3;
        }
    };
    // This confirms storage/data validation, not successful work or effect authority.
    if options.verb == "save" { println("SAVED turn_status=" + from_i32(turn_status) + " " + output); }
    else { println("SHOW " + output); }
    return 0;
}
