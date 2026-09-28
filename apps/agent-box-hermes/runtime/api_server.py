"""Start the pinned Hermes gateway with runtime-only API/callback credentials."""
import os
from urllib.parse import urlsplit


def environment(source):
    env = dict(source)
    for name in ('API_SERVER_KEY', 'PAPERCLIP_CALLBACK_KEY'):
        value = env.get(name, '')
        if len(value.strip()) < 16 or len(value) > 8192 or any(c in value for c in '\r\n\0'):
            raise ValueError('api-server: missing or invalid ' + name + ' (value redacted)')
    try:
        url = urlsplit(env.get('PAPERCLIP_API_URL', ''))
        valid = url.scheme in ('http', 'https') and url.hostname and not url.username and not url.password and not url.query and not url.fragment
        url.port  # Reject malformed ports before starting the gateway.
    except ValueError:
        valid = False
    if not valid:
        raise ValueError('api-server: missing or invalid PAPERCLIP_API_URL (value redacted)')
    # Prevent the CLI from asking upstream s6 profile reconciliation to spawn another service.
    env.update(API_SERVER_ENABLED='true', API_SERVER_HOST='127.0.0.1', API_SERVER_PORT='8643',
               HERMES_S6_SUPERVISED_CHILD='1')
    return env


def main():
    env = environment(os.environ)
    # Foreground process: s6 owns lifecycle and signals. Never put keys in argv.
    os.execve('/opt/hermes/.venv/bin/hermes', ['hermes', 'gateway', 'run'], env)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        message = str(error)
        raise SystemExit(message if message.startswith('api-server:') else 'api-server: launch failed (details redacted)')
