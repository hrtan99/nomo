module app.main;
import std.runtime.time.{now, TimeError};
import std.io.{println, IOError};
import std.text.from_i128;
public flow main(args: Array<string>) -> i32 ![Console, Error<IOError>, Error<TimeError>] {
    println(from_i128(now().unix_millis));
    return 0;
}
