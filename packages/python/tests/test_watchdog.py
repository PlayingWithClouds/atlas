import threading

from atlas_ml import watchdog
from atlas_ml.watchdog import RequestWatchdog


def test_reports_quick_methods_running_too_long(monkeypatch):
    monkeypatch.setattr(watchdog, "STUCK_SECONDS", 0.0)
    dog = RequestWatchdog("/dev/null", {"embed"})
    dog.begin("status")
    dog.begin("embed")
    assert dog.stuck_methods() == ["status"]


def test_finished_requests_are_not_reported(monkeypatch):
    monkeypatch.setattr(watchdog, "STUCK_SECONDS", 0.0)
    dog = RequestWatchdog("/dev/null", set())
    dog.end(dog.begin("status"))
    assert dog.stuck_methods() == []


def test_dump_names_every_thread_and_writes_the_file(tmp_path):
    blocker = threading.Event()
    waiting = threading.Thread(target=blocker.wait, name="blocked-thread", daemon=True)
    waiting.start()
    path = tmp_path / "stacks.log"
    RequestWatchdog(str(path), set()).dump(["status"])
    blocker.set()
    text = path.read_text()
    assert "stuck status" in text
    assert "blocked-thread" in text
