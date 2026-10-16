"""Exercise the pinned Hermes memory store, with no model or embedding call."""
import sys
sys.path.insert(0, '/opt/hermes')
from tools.memory_tool import MemoryStore

store = MemoryStore()
store.load_from_disk()
marker = 'Hermes release file-memory persistence probe.'
if sys.argv[1] == 'write':
    result = store.add('memory', marker)
    assert result.get('success'), 'Built-in memory write failed'
else:
    assert marker in store.memory_entries, 'Built-in memory did not persist'
