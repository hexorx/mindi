import copy,json,pathlib,unittest
from verify import verify
ROOT=pathlib.Path(__file__).parent/'bundle'
class VerificationTests(unittest.TestCase):
 def test_bundle(self):self.assertEqual(verify(ROOT),(1161,4164))
 def test_incorrect_byte_count_fails(self):
  m=json.loads((ROOT/'manifest.json').read_text());m['notices'][0]['bytes']+=1
  with self.assertRaises(AssertionError):verify(ROOT,m)
 def test_false_completion_fails(self):
  m=json.loads((ROOT/'manifest.json').read_text());m['complete']=True
  with self.assertRaises(AssertionError):verify(ROOT,m)
if __name__=='__main__':unittest.main()
