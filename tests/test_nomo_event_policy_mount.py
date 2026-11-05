import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('event_mount', ROOT / 'scripts/nomo-event-policy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MountPolicyTests(unittest.TestCase):
    def test_exact_binding_copies_private_policy_without_copying_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'source';source.mkdir(mode=0o700)
            value=b'{"format":1,"literals":["sensitive-synthetic"]}'
            (source/'policy.json').write_bytes(value);(source/'policy.json').chmod(0o600)
            (source/'binding.key').write_bytes(b'K'*32);(source/'binding.key').chmod(0o600)
            _,_,binding=module.read_private(source)
            target=root/'target';module.prepare(source,target,binding)
            self.assertEqual((target/'policy.json').read_bytes(),value)
            self.assertEqual((target/'policy.json').stat().st_mode & 0o777,0o600)
            self.assertFalse((target/'binding.key').exists())
            (source/'policy.json').write_bytes(value+b' ')
            with self.assertRaises(ValueError):module.prepare(source,root/'wrong',binding)
            self.assertFalse((root/'wrong').exists())
            with self.assertRaises(ValueError):module.prepare(source,root/'bad','not-a-binding')


if __name__=='__main__':unittest.main()
