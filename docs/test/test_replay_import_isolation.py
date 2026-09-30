"""Import-isolation regression for the Phase-0 replay harness (subprocess).

Runs in a FRESH interpreter so the result cannot depend on pytest
collection order. Before importing the replay module the probe installs a
fail-fast trap on ``dotenv.load_dotenv``:

  - if the module's own import-time stub regresses, ``app.py``'s
    ``from dotenv import load_dotenv`` binds the trap instead of the real
    loader — the trap raises before the repo's real ``.env`` is ever read
    (app.py:27 passes an explicit path, so a cwd-based sentinel cannot
    catch this);
  - after import, identity (``is``) of all four globals must equal the
    pre-import snapshot — the module may stub them only inside its import
    block and must restore them.

Inside test_legacy_turn_incident_replay.py the autouse _offline_guard
re-patches the same names during every test, which would mask a leak —
that is why this check lives in a separate file and fresh subprocess.
"""
import subprocess
import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

_PROBE = textwrap.dedent(
    """
    import socket, sys, urllib.request
    sys.path.insert(0, {testdir!r})
    import dotenv, pymongo

    def _load_dotenv_trap(*a, **k):
        raise AssertionError(
            f"dotenv.load_dotenv(*{{a}}, **{{k}}) reached during replay-module "
            "import — module stub regressed; trap fired before real .env read")
    dotenv.load_dotenv = _load_dotenv_trap  # fail-fast BEFORE target import

    names = ("dotenv.load_dotenv", "socket.socket.connect",
             "urllib.request.urlopen", "pymongo.MongoClient.__init__")
    before = (dotenv.load_dotenv, socket.socket.connect,
              urllib.request.urlopen, pymongo.MongoClient.__init__)

    import test_legacy_turn_incident_replay as replay  # module under test

    after = (dotenv.load_dotenv, socket.socket.connect,
             urllib.request.urlopen, pymongo.MongoClient.__init__)
    leaked = [n for n, a, b in zip(names, before, after) if a is not b]
    assert not leaked, f"replay module left global stubs installed: {{leaked}}"

    # bound-alias leak: production modules use `from dotenv import
    # load_dotenv`, so while the import-time stub was active they bound the
    # lambda — restoring dotenv.load_dotenv alone does NOT fix these.
    alias_leaked = [n for n, obj in (
        ("app.load_dotenv", replay.app.load_dotenv),
        ("knowledge_base.load_dotenv", replay.knowledge_base.load_dotenv),
    ) if obj is not before[0]]
    assert not alias_leaked, (
        f"replay module left bound dotenv aliases installed: "
        f"{{', '.join(alias_leaked)}}")
    print("IMPORT-ISOLATION-OK")
    """
)


def test_replay_module_leaves_no_global_patches():
    probe = _PROBE.format(testdir=str(ROOT / "docs" / "test"))
    out = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=str(ROOT),
        capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, f"probe failed:\n{out.stdout}\n{out.stderr}"
    assert "IMPORT-ISOLATION-OK" in out.stdout
