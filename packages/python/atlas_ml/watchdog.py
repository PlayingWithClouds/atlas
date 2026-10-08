"""Dumps every thread's Python stack when a request has been running for too long.

A stuck worker answers nothing, so the host only sees timeouts. The dump shows which
lock or call each thread is waiting on. It goes to stderr (forwarded to the host log)
and to a file under the cache root, in case stderr itself is what blocks.
"""

import os
import sys
import threading
import time
import traceback

CHECK_SECONDS = 5.0
STUCK_SECONDS = 15.0
DUMP_INTERVAL_SECONDS = 60.0


class RequestWatchdog:
    def __init__(self, dump_path: str, slow_methods: set[str]):
        self.dump_path = dump_path
        self.slow_methods = slow_methods
        self.lock = threading.Lock()
        self.started: dict[int, tuple[str, float]] = {}
        self.next_key = 0
        self.last_dump = 0.0
        self.stopped = threading.Event()

    def start(self) -> None:
        threading.Thread(target=self.watch, name="atlas-watchdog", daemon=True).start()

    def stop(self) -> None:
        self.stopped.set()

    def begin(self, method: str) -> int:
        with self.lock:
            key = self.next_key
            self.next_key += 1
            self.started[key] = (method, time.monotonic())
            return key

    def end(self, key: int) -> None:
        with self.lock:
            self.started.pop(key, None)

    def watch(self) -> None:
        while not self.stopped.wait(CHECK_SECONDS):
            stuck = self.stuck_methods()
            if stuck and time.monotonic() - self.last_dump >= DUMP_INTERVAL_SECONDS:
                self.last_dump = time.monotonic()
                self.dump(stuck)

    def stuck_methods(self) -> list[str]:
        """Quick methods running past STUCK_SECONDS; slow ones (embed, insights) may legitimately run long."""
        now = time.monotonic()
        with self.lock:
            running = list(self.started.values())
        return [method for method, began in running
                if method not in self.slow_methods and now - began > STUCK_SECONDS]

    def dump(self, stuck: list[str]) -> None:
        text = format_report(stuck)
        try:
            with open(self.dump_path, "a") as handle:
                handle.write(text)
        except OSError:
            pass
        sys.stderr.write(text)
        sys.stderr.flush()


def format_report(stuck: list[str]) -> str:
    names = {thread.ident: thread.name for thread in threading.enumerate()}
    lines = [f"=== {time.strftime('%H:%M:%S')} pid {os.getpid()}: stuck {', '.join(stuck)} ===\n"]
    for ident, frame in sys._current_frames().items():
        lines.append(f"--- thread {names.get(ident, ident)} ---\n")
        lines.extend(traceback.format_stack(frame))
    return "".join(lines)
