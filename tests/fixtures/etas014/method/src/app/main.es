module app.main;

flow main(args: Array<string>) -> i32 {
    let values: Array<i32> = [1];
    let appended = values.push(2);
    return appended[1];
}
