"""Bounded smoke diagnostics; never serialize tool content or input arguments."""
import json
import os
from pathlib import Path
import re


SECRET_NAME = re.compile(r"key|token|secret|password|credential|authorization", re.I)


def diagnostic(value, secret_dir=Path('/run/secrets'), *, secret_values=None):
    if not isinstance(value, str):
        return 'invalid_error'
    # Redact before truncation so a boundary cannot expose a partial secret.
    secrets = [v for k, v in os.environ.items() if v and SECRET_NAME.search(k)]
    if secret_values is not None:
        if not isinstance(secret_values, list) or not all(isinstance(v, str) for v in secret_values):
            return 'diagnostic_unavailable'
        secrets.extend(secret_values)
    else:
        try:
            for path in secret_dir.iterdir():
                if path.is_file():
                    secrets.append(path.read_text().strip())
        except FileNotFoundError:
            pass
        except (OSError, UnicodeError):
            return 'diagnostic_unavailable'
    for secret in sorted(filter(None, secrets), key=len, reverse=True):
        value = value.replace(secret, '[redacted]')
    value = re.sub(r'https?://\S+|data:\S+', '[redacted-url]', value)
    value = re.sub(r'(?i)\b(bearer|basic)\s+\S+', r'\1 [redacted]', value)
    value = re.sub(r'(?i)\b([\w-]*(?:key|token|secret|password|credential)[\w-]*)\s*[:=]\s*\S+',
                   r'\1=[redacted]', value)
    return ' '.join(''.join(c if c.isprintable() else ' ' for c in value).split())[:800]


def checked_result(result, action, *, secret_values=None):
    try:
        result = json.loads(result) if isinstance(result, str) else result
    except (ValueError, TypeError):
        raise RuntimeError('Hermes computer_use returned invalid JSON') from None
    if not isinstance(result, dict):
        raise RuntimeError('Hermes computer_use returned invalid_response')
    if result.get('error') or result.get('ok') is False:
        code = diagnostic(result.get('code', 'unspecified'), secret_values=secret_values)
        error = diagnostic(result.get('error', 'no error detail'), secret_values=secret_values)
        raise RuntimeError(f'Hermes computer_use failed for {action}: {code}: {error}')
    return result
