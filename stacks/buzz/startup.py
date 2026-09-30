"""Bound pinned Buzz startup (including A3), then supervise without a time limit."""

import math
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from contextlib import suppress
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    timeout: float = 300
    attempts: int = 3
    backoff: float = 5
    grace: float = 10
    port: int = 8080

    @classmethod
    def from_env(cls):
        settings = cls(
            timeout=float(os.getenv("BUZZ_STARTUP_TIMEOUT_SECONDS", "300")),
            attempts=int(os.getenv("BUZZ_STARTUP_ATTEMPTS", "3")),
            backoff=float(os.getenv("BUZZ_STARTUP_BACKOFF_SECONDS", "5")),
            grace=float(os.getenv("BUZZ_STARTUP_STOP_GRACE_SECONDS", "10")),
            port=int(os.getenv("BUZZ_HEALTH_PORT", "8080")),
        )
        for name in ("timeout", "backoff", "grace"):
            value = getattr(settings, name)
            if not math.isfinite(value) or value <= 0:
                raise ValueError(f"{name} must be finite and positive")
        if not 1 <= settings.attempts <= 10:
            raise ValueError("attempts must be between 1 and 10")
        if not 1 <= settings.port <= 65535:
            raise ValueError("health port must be between 1 and 65535")
        return settings


def log(message):
    print(f"buzz-startup: {message}", file=sys.stderr, flush=True)


def ready(port, timeout):
    # Fixed loopback endpoint, no proxy environment or redirects. In 82f7ed1
    # this listener is opened only AFTER run_conformance_probe returns success.
    deadline = time.monotonic() + timeout
    try:
        with socket.create_connection(
            ("127.0.0.1", port), timeout=timeout
        ) as connection:
            connection.settimeout(max(0.001, deadline - time.monotonic()))
            connection.sendall(
                b"GET /_readiness HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
            )
            status = b""
            # Bound the complete status read, including a peer trickling bytes.
            while b"\r\n" not in status and len(status) < 4096:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                connection.settimeout(remaining)
                chunk = connection.recv(1)
                if not chunk:
                    return False
                status += chunk
            parts = status.split(b"\r\n", 1)[0].split(b" ")
            return (
                b"\r\n" in status
                and len(parts) >= 2
                and parts[0] in (b"HTTP/1.0", b"HTTP/1.1")
                and parts[1] == b"200"
            )
    except OSError:
        return False


def send_group(child, sig):
    with suppress(ProcessLookupError):
        os.killpg(child.pid, sig)


def stop_child(child, grace, sig=signal.SIGTERM):
    send_group(child, sig)
    with suppress(subprocess.TimeoutExpired):
        child.wait(timeout=grace)
    # Also remove descendants if the leader has already exited. No new
    # attempt starts while the previous relay leader remains alive.
    send_group(child, signal.SIGKILL)
    try:
        child.wait(timeout=1)
        return True
    except subprocess.TimeoutExpired:
        log("child did not exit after SIGKILL; refusing overlapping retry")
        return False


def run(command, settings):
    stopped = threading.Event()
    received_signal = signal.SIGTERM

    def on_signal(sig, _frame):
        nonlocal received_signal
        received_signal = sig
        stopped.set()

    previous = {
        sig: signal.signal(sig, on_signal) for sig in (signal.SIGTERM, signal.SIGINT)
    }
    child = None
    try:
        for attempt in range(1, settings.attempts + 1):
            if stopped.is_set():
                return 128 + received_signal
            log(
                f"attempt {attempt}/{settings.attempts}; startup deadline {settings.timeout:g}s"
            )
            # Keep logs and arguments unchanged; never print environment values.
            child = subprocess.Popen(command, start_new_session=True)
            deadline = time.monotonic() + settings.timeout
            admitted = False
            while True:
                if stopped.is_set():
                    stop_child(child, settings.grace, received_signal)
                    return 128 + received_signal
                code = child.poll()
                if code is not None:
                    send_group(child, signal.SIGKILL)
                    # Never turn an early clean exit into successful admission.
                    if admitted:
                        return code if code >= 0 else 128 - code
                    return code if code > 0 else 1
                remaining = deadline - time.monotonic()
                if not admitted:
                    if remaining <= 0:
                        break
                    # A late response cannot extend the startup budget.
                    if (
                        ready(settings.port, min(0.5, remaining))
                        and time.monotonic() < deadline
                    ):
                        admitted = True
                        log("readiness passed; startup deadline disarmed")
                stopped.wait(0.1)
            log(f"startup timed out on attempt {attempt}; stopping relay")
            if not stop_child(child, settings.grace):
                return 1
            child = None
            if stopped.is_set():
                return 128 + received_signal
            if attempt < settings.attempts:
                delay = min(settings.backoff * 2 ** (attempt - 1), 60)
                log(f"retrying startup in {delay:g}s")
                stopped.wait(delay)
        log("startup attempts exhausted; exiting non-zero for container restart")
        return 1
    finally:
        if child is not None and child.poll() is None:
            stop_child(child, settings.grace)
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def main():
    try:
        settings = Settings.from_env()
    except (ValueError, OverflowError):
        log("invalid startup settings; refusing to launch")
        return 2
    try:
        return run(sys.argv[1:] or ["/usr/local/bin/buzz-relay"], settings)
    except OSError:
        log("could not launch relay")
        return 1


if __name__ == "__main__":
    sys.exit(main())
