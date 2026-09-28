"""Repair Hindsight 0.6.1 concurrent-index migrations for psycopg 3.

Raw SQL COMMIT does not enable driver autocommit. Use Alembic's public
transaction API, keeping the surrounding migrations transactional. Fingerprints
make dependency upgrades fail closed until this workaround is reviewed.
"""
import ast
import hashlib
from pathlib import Path

FINGERPRINTS = {
    'a2b3c4d5e6f8_add_gin_index_source_memory_ids.py': '70204507a81f3005305aeccae9e7df071eabd5824b3b6c6f260682991885d565',
    'd4e5f6g7h8i9_gin_source_memory_ids_fastupdate_off.py': '399598f14dd5f0c78cd779bae980f694cce8990ab90620de82a6d5749108673f',
    'b3c4d5e6f7g8_add_temporal_date_indexes.py': 'c06abd88c22f813c491ef2288414ce55bfb3b092c533e9471bd3d6fbdc0293c4',
    'd2e3f4a5b6c7_add_memory_links_expansion_indexes.py': 'ac3ec244cf3806a342713917375fa98814affbf6239ead4a8878d811dd842854',
    'c1a2b3d4e5f6_enable_pg_trgm_and_entities_trgm_index.py': 'd21791e5f9bfdd792d1805a340151f4354e62d944a8717adcb4a43e6772c4f06',
}


def transform(source):
    lines = source.splitlines(keepends=True)
    edits = []
    for node in ast.walk(ast.parse(source)):
        if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                and ast.unparse(node.value.func) == 'op.execute' and node.value.args):
            continue
        argument = node.value.args[0]
        if isinstance(argument, ast.Constant) and argument.value == 'COMMIT':
            edits.append((node.lineno - 1, node.end_lineno, []))
        elif any(sql in ast.unparse(argument) for sql in
                 ('CREATE INDEX CONCURRENTLY', 'DROP INDEX CONCURRENTLY')):
            block = [' ' * node.col_offset + 'with op.get_context().autocommit_block():\n']
            block += ['    ' + line for line in lines[node.lineno - 1:node.end_lineno]]
            edits.append((node.lineno - 1, node.end_lineno, block))
    for start, end, replacement in sorted(edits, reverse=True):
        lines[start:end] = replacement
    result = ''.join(lines)
    compile(result, '<patched migration>', 'exec')
    return result


def patch(versions):
    changes = []
    for name, expected in FINGERPRINTS.items():
        path = versions / name
        source = path.read_bytes()
        if hashlib.sha256(source).hexdigest() != expected:
            raise ValueError(f'Hindsight migration changed: {name}; review compatibility patch')
        changes.append((path, transform(source.decode())))
    for path, source in changes:
        path.write_text(source)


if __name__ == '__main__':
    from importlib.metadata import distribution
    package = distribution('hindsight-api-slim')
    if package.version != '0.6.1':
        raise SystemExit('Review migration compatibility patch for new Hindsight version')
    patch(Path(package.locate_file('hindsight_api/alembic/versions')))
