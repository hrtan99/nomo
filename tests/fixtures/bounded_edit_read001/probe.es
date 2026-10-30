module app.bounded_edit_probe;
import std.io.println;
import std.text.len;
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.runtime.error.IndexError;
import std.io.IOError as ConsoleError;
import nomo.tools.edit_file.{EditableRoot, read_original, prepare, apply};
import nomo.tools.edit_contract.prepare_original;

flow read_count(name: string, expected: usize) -> bool {
    return match read_original(name) { Ok(value) => len(value) == expected, Err(_) => false };
}
public flow bounded_edit_probe_empty(args: Array<string>) -> i32 { if !read_count("empty.txt",0) { abort("empty mismatch"); } println("PASS empty"); return 0; }
public flow bounded_edit_probe_exact(args: Array<string>) -> i32 { if !read_count("exact.txt",2048) { abort("exact mismatch"); } println("PASS exact"); return 0; }
public flow bounded_edit_probe_unicode(args: Array<string>) -> i32 { if !read_count("unicode.txt",684) { abort("unicode mismatch"); } println("PASS unicode"); return 0; }
public flow bounded_edit_probe_over(args: Array<string>) -> i32 {
    let result=read_original("over.txt");
    if result != Err("edit file exceeds 2048 bytes") { abort("over mismatch"); } println("PASS over"); return 0;
}
public flow bounded_edit_probe_invalid_utf8(args: Array<string>) -> i32 {
    let result=read_original("invalid.txt");
    if result != Err("edit file is not UTF-8") { abort("UTF8 mismatch"); } println("PASS invalid_utf8"); return 0;
}
public flow bounded_edit_probe_missing(args: Array<string>) -> i32 {
    return handle { let result=read_original("missing.txt"); println("UNEXPECTED"); 1 } with {
        Error<FileError>.raise(_) => { println("PASS missing IOError"); finish 0; }
    };
}
public flow bounded_edit_probe_invalid_path(args: Array<string>) -> i32 {
    let result=read_original("../outside.txt");
    if result != Err("invalid relative path") { abort("path mismatch"); } println("PASS invalid_path"); return 0;
}
public flow bounded_edit_probe_prepare_consumer(args: Array<string>) -> i32 {
    let result=match prepare("small.txt","old","new") { Ok(value)=>value, Err(_) => { abort("prepare refused"); } };
    if result.proposal.before != "old\n" || result.proposal.after != "new\n" { abort("proposal mismatch"); }
    println("PASS prepare_consumer"); return 0;
}
public flow bounded_edit_probe_apply_changed(args: Array<string>) -> i32 ![Console, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<FileError>, Error<IndexError>, Error<ConsoleError>] {
    let proposed=match prepare_original("changed.txt","old\n","old","new") { Ok(value)=>value, Err(_) => { abort("setup refused"); } };
    if apply(proposed) != Err("edit original changed; intent retained, no write") { abort("changed original not refused"); }
    println("PASS apply_changed"); return 0;
}
public flow bounded_edit_probe_apply_success(args: Array<string>) -> i32 ![Console, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<FileError>, Error<IndexError>, Error<ConsoleError>] {
    let proposed=match prepare_original("small.txt","old\n","old","new") { Ok(value)=>value, Err(_) => { abort("setup refused"); } };
    if apply(proposed) != Ok(true) { abort("apply refused"); }
    println("PASS apply_success"); return 0;
}
