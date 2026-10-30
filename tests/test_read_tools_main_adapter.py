"""Check D2 main-closure and strict action guards without invoking Etas."""
import ast
from pathlib import Path
import sys
import unittest

TESTS=Path(__file__).resolve().parent
sys.path.insert(0,str(TESTS))
import read_tools_contract_probe as driver

class MainAdapterTests(unittest.TestCase):
    def test_current_main_import_closure_is_explicit(self):
        extra={'agent/console_events.es','agent/conversation_events.es','agent/stub_loop_controller.es','model/conversation_output.es'}
        self.assertEqual(len(driver.POSITIVE_MODULES),24)
        self.assertEqual(len(set(driver.POSITIVE_MODULES)),24)
        self.assertTrue(extra<=set(driver.POSITIVE_MODULES))
        for item in extra:self.assertTrue((driver.ROOT/'src/nomo'/item).is_file(),item)
        loop=(driver.ROOT/'src/nomo/agent/loop.es').read_text()
        for module in ('nomo.agent.console_events','nomo.agent.conversation_events','nomo.agent.stub_loop_controller','nomo.model.conversation_output'):
            self.assertIn('import '+module,loop)
    def test_fixture_requested_and_default_guards_remain_strict(self):
        tree=ast.parse(Path(driver.__file__).read_text());fn=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='run')
        assertions=[x for x in ast.walk(fn) if isinstance(x,ast.Assert)]
        selects=[x for x in assertions if "rows['support'] == 'requires-orchestration[host=Console; features=EffectHandler]'" in ast.unparse(x.test) or "rows['default actions'] == {'Console.stdout_write'}" in ast.unparse(x.test) or "rows['requested actions'] <= {'Console.stdout_write', 'LegacyChildModel.infer', 'ReadTools.read', 'ReadTools.search', 'ConversationOutput.publish'}" in ast.unparse(x.test)]
        self.assertEqual(len(selects),3)
        code=compile(ast.fix_missing_locations(ast.Module(body=selects,type_ignores=[])),'<fixture-action-guards>','exec')
        good={'support':'requires-orchestration[host=Console; features=EffectHandler]','default actions':{'Console.stdout_write'},'requested actions':{'Console.stdout_write','ConversationOutput.publish','ReadTools.read','ReadTools.search','LegacyChildModel.infer'}}
        def verify(row):exec(code,{'rows':row,'item':{},'diagnostic':lambda _: 'synthetic guard failure'})
        verify(good)
        for key,bad in [('support','local'),('default actions',{'Console.stdout_write','Unexpected.default'}),('requested actions',good['requested actions']|{'Unexpected.action'})]:
            row=dict(good);row[key]=bad
            with self.assertRaises(AssertionError):verify(row)
    def test_production_requested_bound_remains_specific(self):
        tree=ast.parse(Path(driver.__file__).read_text());fn=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='run')
        matches=[x for x in ast.walk(fn) if isinstance(x,ast.Assert) and "rows['requested actions'] <= allowed |" in ast.unparse(x.test)]
        self.assertEqual(len(matches),1)
        test=ast.unparse(matches[0].test)
        for name in ('LegacyChildModel.infer','ReadTools.read','ReadTools.search','ConversationOutput.publish'):self.assertIn(name,test)
        code=compile(ast.fix_missing_locations(ast.Module(body=matches,type_ignores=[])),'<production-action-guard>','exec')
        required={'Fs.read[nomo.tools.workspace.ReadOnlyRoot]','Console.stdout_write','Agentic.infer[nomo.agent.model_tool.ToolModel.run, string]'}
        allowed=required|{'Agentic.infer[nomo.agent.model_tool.ReadFirst.run, string]','Agentic.infer[nomo.agent.model_tool.ReadFinal.run, string]'}
        def verify(actions):exec(code,{'rows':{'requested actions':actions},'required':required,'allowed':allowed,'item':{},'diagnostic':lambda _: 'synthetic guard failure'})
        verify(required|{'ConversationOutput.publish'})
        with self.assertRaises(AssertionError):verify(required|{'Unexpected.action'})
        with self.assertRaises(AssertionError):verify({'ConversationOutput.publish'})

if __name__=='__main__':unittest.main()
