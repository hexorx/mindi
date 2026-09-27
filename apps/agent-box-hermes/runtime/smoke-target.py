"""Disposable GUI input sink; never executes typed text."""
from pathlib import Path
import time
Path("/run/user/1000/smoke-input").write_text(input("Hermes smoke input: "))
time.sleep(30)
