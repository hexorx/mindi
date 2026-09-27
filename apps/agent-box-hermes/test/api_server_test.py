import importlib.util
import os
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch, MagicMock

APP = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('api_server', APP / 'runtime/api_server.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
FIXTURE = {'API_SERVER_KEY': 'fixture-only-api-key',
           'PAPERCLIP_CALLBACK_KEY': 'fixture-only-callback-key',
           'PAPERCLIP_API_URL': 'https://paperclip.example/api'}


class APIServiceTest(unittest.TestCase):
    def test_runtime_credentials_reach_foreground_process_without_argv_leak(self):
        with patch.dict(os.environ, FIXTURE, clear=True), patch.object(api.os, 'execve') as execute:
            api.main()
        binary, argv, env = execute.call_args.args
        self.assertEqual(binary, '/opt/hermes/.venv/bin/hermes')
        self.assertEqual(argv, ['hermes', 'gateway', 'run'])
        for key, value in FIXTURE.items():
            self.assertEqual(env[key], value)
            self.assertNotIn(value, ' '.join(argv))

    def test_unusable_credentials_fail_closed_without_disclosing_values(self):
        for key in ('API_SERVER_KEY', 'PAPERCLIP_CALLBACK_KEY'):
            for value in ('', 'short', ' ' * 16, 'fixture-secret-value\n', 'x' * 8193):
                with self.subTest(key=key, size=len(value)):
                    with self.assertRaises(ValueError) as error:
                        api.environment({**FIXTURE, key: value})
                    self.assertIn(key, str(error.exception))
                    if value:
                        self.assertNotIn(value, str(error.exception))

    def test_url_validation_and_fixed_private_bind(self):
        for url in ('', 'file:///tmp/foo', 'https://secret@host', 'https://host:bad', 'https://host/?key=secret'):
            with self.assertRaises(ValueError):
                api.environment({**FIXTURE, 'PAPERCLIP_API_URL': url})
        env = api.environment({**FIXTURE, 'API_SERVER_HOST': '0.0.0.0', 'API_SERVER_PORT': '1234'})
        self.assertEqual(env['API_SERVER_HOST'], '127.0.0.1')
        self.assertEqual(env['API_SERVER_PORT'], '8642')
        self.assertEqual(env['HERMES_S6_SUPERVISED_CHILD'], '1')

    def test_api_failure_blocks_container_readiness(self):
        frame = MagicMock(stdout=b'\x89PNG\r\n\x1a\n' + b'x' * 100)
        with patch.dict(os.environ, FIXTURE), patch('subprocess.run', return_value=frame), \
             patch('urllib.request.urlopen'), patch('socket.create_connection'), \
             patch('json.load', side_effect=[{'status': 'healthy'}, {'status': 'failed'}]):
            with self.assertRaises(SystemExit) as error:
                runpy.run_path(str(APP / 'runtime/health.py'))
            self.assertEqual(error.exception.code, 1)

    def test_p7_compose_has_one_container_port_and_no_host_publish(self):
        import yaml
        compose = yaml.safe_load((APP.parents[1] / 'stacks/agent-box-hermes/compose.p7.yaml').read_text())
        service = compose['services']['hermes']
        self.assertNotIn('ports', service)
        self.assertEqual(service['expose'], ['8443'])
        self.assertEqual(set(service['environment']), set(FIXTURE))
        self.assertEqual(service['volumes'], ['box-home:/home/agent', 'box-memory:/var/lib/agent-box/hindsight'])


if __name__ == '__main__':
    unittest.main()
