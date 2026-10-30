"""Exercise 010 entry adaptation and once action oracle without Etas calls."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

TESTS=Path(__file__).resolve().parent
MANIFEST=TESTS/'fixtures/work_chain_usecase001/entry_manifest.toml'
sys.path.insert(0,str(TESTS))
spec=importlib.util.spec_from_file_location('formal_d4',Path(__file__).with_name('work_chain_usecase_probe.py'))
driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)

def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def blocks(text):
    parts=re.split(r'(?=^\[\[bin\]\]\s*$)',text,flags=re.M)
    return parts[0],parts[1:]

def name(block):return re.search(r'^name\s*=\s*"([^"]+)"\s*$',block,re.M).group(1)

class SelectedBinTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.project=self.root/'project';(self.project/'src/app').mkdir(parents=True)
        shutil.copyfile(MANIFEST,self.project/'etas.toml')
        (self.project/'src/app/fixture.es').write_bytes(b'module app.fixture;\n// synthetic source bytes\n')
        (self.project/'etas.lock').write_bytes(b'synthetic lock bytes\n')
        self.calls=[]
        def fake(folder,label,argv,*,data=b''):
            self.calls.append(list(argv));return {'exit':0,'stdout':'','stderr':''}
        p=patch.object(driver.transport,'invoke',side_effect=fake);p.start();self.addCleanup(p.stop)
    def invoke(self,label,flow):
        return driver.command(self.root,label,['/fake/etas','effects',self.project,'--flow',flow])
    def test_two_independent_entries_preserve_inputs_and_record_commands(self):
        before={str(p.relative_to(self.project)):digest(p) for p in self.project.rglob('*') if p.is_file()}
        header,original=blocks((self.project/'etas.toml').read_text());self.assertEqual(len(original),13)
        for label,flow in [('first','usecase_values'),('second','mapping_values')]:
            self.invoke(label,flow)
            target=self.root/(label+'-entry-project');h,selected=blocks((target/'etas.toml').read_text())
            index=[name(x) for x in original].index(flow)
            self.assertEqual(h,header);self.assertEqual(selected,[original[index]]+[x for i,x in enumerate(original) if i!=index])
            after={str(p.relative_to(target)):digest(p) for p in target.rglob('*') if p.is_file() and p.relative_to(target)!=Path('etas.toml')}
            self.assertEqual(after,{k:v for k,v in before.items() if k!='etas.toml'})
            receipt=json.loads((self.root/(label+'-entry-inputs.json')).read_text())
            self.assertEqual(receipt['input_sha256'],after);self.assertEqual(receipt['manifest_sha256'],digest(target/'etas.toml'))
            self.assertEqual(receipt['original_manifest_sha256'],before['etas.toml']);self.assertEqual(receipt['command'],self.calls[-1])
            self.assertEqual(self.calls[-1][2],str(target));self.assertEqual(self.calls[-1][-1],flow)
        self.assertNotEqual(self.calls[0][2],self.calls[1][2]);self.assertEqual(before,{str(p.relative_to(self.project)):digest(p) for p in self.project.rglob('*') if p.is_file()})
    def test_missing_or_duplicate_bin_refused_before_invocation(self):
        with self.assertRaisesRegex(AssertionError,'Ambiguous or missing'):self.invoke('missing','not_a_flow')
        manifest=self.project/'etas.toml';text=manifest.read_text();_,items=blocks(text);manifest.write_text(text+'\n'+items[0])
        with self.assertRaisesRegex(AssertionError,'Ambiguous or missing'):self.invoke('duplicate',name(items[0]))
        self.assertEqual(self.calls,[])

class OnceOracleTests(unittest.TestCase):
    def test_exact_once_actions_and_no_extra_or_missing_actions(self):
        source=Path(driver.__file__).read_text();tree=ast.parse(source)
        controls=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='controls')
        condition=next(x for x in ast.walk(controls) if isinstance(x,ast.If) and ast.unparse(x.test)=="flow == 'unbound_once'")
        body=ast.fix_missing_locations(ast.Module(body=condition.body,type_ignores=[]))
        custom={'TerminalWork.execute','TerminalRead.latest'};error={'Error<std.runtime.error.IndexError>','Error<std.io.IOError>'}
        good=[custom|{'Console.stdout_write'},{'Console.stdout_write'},custom|error]
        def check(values):
            env={'transport':driver.transport,'requested':values[0],'defaults':values[1],'escaping':values[2]}
            exec(compile(body,'<once-oracle>','exec'),env)
        check(good)
        for i in range(3):
            for change in ('extra','missing'):
                values=[set(x) for x in good]
                if change=='extra':values[i].add('unexpected.action')
                else:values[i].remove(sorted(values[i])[0])
                with self.assertRaises(AssertionError):check(values)

if __name__=='__main__':unittest.main()
