"""Verify Hindsight 0.8.3's upstream fix; never nest autocommit blocks.

The five migrations formerly patched for 0.6.1 now use Alembic's transaction
API upstream. Keep fingerprints and structural checks so upgrades fail closed.
The historical filename is retained for build callers; this step writes nothing.
"""
import ast
import hashlib
from pathlib import Path

FINGERPRINTS = {
    'a2b3c4d5e6f8_add_gin_index_source_memory_ids.py': '249c9b41dfee84b39dfbdcad6711383224af9f7cbd4f214e57df5f1d5c657f90',
    'd4e5f6g7h8i9_gin_source_memory_ids_fastupdate_off.py': 'fc35c2b92bf38f75acd0966b132a9d852e222b9db7414cee8e5d9c86eb048dc8',
    'b3c4d5e6f7g8_add_temporal_date_indexes.py': '3398a72a3d7e9faf6c40443d99e06337c0795b0d80a420e5b8cb6fdcc2d326c3',
    'd2e3f4a5b6c7_add_memory_links_expansion_indexes.py': 'f0ab3dfc07090c142861b153d534add163b03ceea2fcfd42bca451e4f3391754',
    'c1a2b3d4e5f6_enable_pg_trgm_and_entities_trgm_index.py': 'db3d180ca8e66c235360347dc6d4fbf17d7328bb94041db1a24c6998628f0d98',
}


def verify_transactions(source):
    count = 0

    def walk(node, depth=0):
        nonlocal count
        if isinstance(node, ast.With):
            depth += sum(ast.unparse(item.context_expr) ==
                         'op.get_context().autocommit_block()' for item in node.items)
            if depth > 1:
                raise ValueError('nested autocommit block')
        if isinstance(node, ast.Call) and ast.unparse(node.func) == 'op.execute' and node.args:
            arg = node.args[0]
            if isinstance(arg, ast.Constant) and arg.value == 'COMMIT':
                raise ValueError('raw COMMIT does not enable driver autocommit')
            if any(sql in ast.unparse(arg) for sql in
                   ('CREATE INDEX CONCURRENTLY', 'DROP INDEX CONCURRENTLY')):
                if depth != 1:
                    raise ValueError('concurrent index outside autocommit block')
                count += 1
        for child in ast.iter_child_nodes(node):
            walk(child, depth)

    walk(ast.parse(source))
    if not count:
        raise ValueError('expected concurrent index statements')


def patch(versions):
    for name, expected in FINGERPRINTS.items():
        source = (versions / name).read_bytes()
        if hashlib.sha256(source).hexdigest() != expected:
            raise ValueError(f'Hindsight migration changed: {name}; review compatibility patch')
        verify_transactions(source.decode())


if __name__ == '__main__':
    from importlib.metadata import distribution
    package = distribution('hindsight-api-slim')
    if package.version != '0.8.3':
        raise SystemExit('Review migration compatibility patch for new Hindsight version')
    patch(Path(package.locate_file('hindsight_api/alembic/versions')))
