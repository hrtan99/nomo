module app.main;
import std.agent.message.Message;
import std.agent.schema.ModelResponse;
import std.json.{JsonValue,stringify};
import std.io.println;
public tool ping(value:i32)->i32 ![] { return value+1; }
@tools([ping])
@limits([Tokens(4096),ContextTokens(1048576)])
agent Worker(input:string)->ModelResponse { return perform infer<ModelResponse>(Prompt.new().system(Trusted(input))); }
flow main(args:Array<string>)->i32 ![Agentic,Console,Error<IOError>] {
 let response=Worker.run("Call ping with value 7.");
 let converted:Option<Message<JsonValue>> = Message.new(response).cast<JsonValue>();
 match converted {
  Some(value)=> { println(match stringify(value.body) { Ok(text)=>text,Err(_)=>"ENCODING_UNAVAILABLE" }); }
  None()=> { println("RAW_RESPONSE_NOT_JSON_PROJECTABLE"); }
 }
 return 0;
}
