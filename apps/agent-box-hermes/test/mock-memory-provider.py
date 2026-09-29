"""CI-only deterministic OpenAI protocol fixture. Never installed in the image."""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import struct

FACT = 'The persistent memory verification code is cobalt-orchid-742.'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path.endswith('/embeddings'):
            inputs = request['input']
            if isinstance(inputs, str):
                inputs = [inputs]
            vector = [1.0] + [0.0] * 1535
            embedding = (base64.b64encode(struct.pack('<1536f', *vector)).decode()
                         if request.get('encoding_format') == 'base64' else vector)
            response = {'object': 'list', 'model': 'fixture', 'data': [
                {'object': 'embedding', 'index': i, 'embedding': embedding} for i in range(len(inputs))
            ], 'usage': {'prompt_tokens': 1, 'total_tokens': 1}}
        elif self.path.endswith('/chat/completions'):
            fact = {'what': FACT, 'when': 'N/A', 'where': 'N/A', 'who': 'N/A', 'why': 'N/A',
                    'fact_type': 'world', 'entities': [], 'causal_relations': []}
            response = {'id': 'fixture', 'object': 'chat.completion', 'created': 1, 'model': 'fixture',
                        'choices': [{'index': 0, 'finish_reason': 'stop', 'message': {
                            'role': 'assistant', 'content': json.dumps({'facts': [fact]})}}],
                        'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}
        else:
            self.send_error(404)
            return
        body = json.dumps(response).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.2', 9999), Handler).serve_forever()
