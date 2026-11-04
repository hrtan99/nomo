module nomo.session.check_output_display;

import nomo.core.json.encode as encode_json;



import nomo.session.check_output.{Record, load};
import std.io.println;
import std.io.IOError as ConsoleError;
import nomo.session.session_display.ascii_json;

// JSON string escapes make line controls and invisible Unicode safe to print,
// and let a reader reconstruct the stored streams without guessing markers.
public flow render(value: Record) -> Result<string, string> {
    let json = match encode_json(value, "check output conversion refused", "check output encoding refused") { Ok(value) => value, Err(error) => { return Err(error); } };
    return ascii_json(json, 262144, "check output encoding exceeds bound", "check output display exceeds bound");
}

public type Selection = { phase: string, id: string, digest: string };
public flow show(slot: string, selected: Option<Selection>) -> Result<bool, string> ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<ConsoleError>] {
    let check = match selected { Some(value) => value, None() => { println("CHECK OUTPUT " + slot + " unavailable: no check"); return Ok(true); } };
    if check.phase != "complete" { println("CHECK OUTPUT " + slot + " unavailable: check unresolved"); return Ok(true); }
    let saved = match load(slot, check.id, check.digest) { Ok(value) => value, Err(error) => { return Err(error); } };
    match saved {
        None() => { println("CHECK OUTPUT " + slot + " unavailable: no recorded output"); }
        Some(value) => {
            let json = match render(value) { Ok(text) => text, Err(error) => { return Err(error); } };
            println("CHECK OUTPUT " + json);
        }
    }
    return Ok(true);
}
