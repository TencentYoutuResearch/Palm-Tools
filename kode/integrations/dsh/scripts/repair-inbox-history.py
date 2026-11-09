"""Repair legacy queue transfers and optional Kode records under the session writer's flock. Default: report only."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--home", required=True)
parser.add_argument("--session-id", required=True)
parser.add_argument("--runtime-modules", required=True)
parser.add_argument("--node", default="node")
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()
if Path(args.session_id).name != args.session_id:
    parser.error("session-id must be a single path component")
home = Path(args.home).resolve()
matches = list((home / "sessions").glob("*/" + args.session_id))
if len(matches) != 1:
    raise SystemExit("Expected exactly one session directory")
directory = matches[0].resolve()
if not directory.is_relative_to(home / "sessions"):
    raise SystemExit("Session directory escaped the home")
path = directory / "session.v4.jsonl.zstd"
worker = Path(__file__).with_suffix(".js")
# A reader/projection error does not authorize bypassing a live session writer.
with (directory / "session.lock").open("r+") as lease:
    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    original = path.read_bytes()
    with tempfile.TemporaryDirectory(prefix="kode-inbox-repair-", dir=directory) as staging:
        output = Path(staging) / "session.v4.jsonl.zstd"
        command = [args.node, str(worker), str(path), str(Path(args.runtime_modules).resolve())]
        if args.apply:
            command.append(str(output))
        report = json.loads(subprocess.check_output(command, text=True))
        if report["sessionId"] != args.session_id:
            raise SystemExit("Session header identity mismatch; repair aborted")
        report["applied"] = False
        if args.apply and report["changes"]:
            if path.read_bytes() != original:
                raise SystemExit("Session changed during validation; repair aborted")
            backup = home / "backups" / ("inbox-repair-" + str(time.time_ns())) / args.session_id
            backup.mkdir(parents=True, mode=0o700)
            shutil.copy2(path, backup / path.name)
            cache = home / "storages/session_projcache/sessions" / (args.session_id + ".json")
            if cache.exists():
                shutil.copy2(cache, backup / "projection-cache.json")
            # Make the rollback copy durable before publishing the replacement.
            for saved in backup.iterdir():
                with saved.open("rb") as stream:
                    os.fsync(stream.fileno())
            for folder in (backup, backup.parent, backup.parent.parent):
                backup_fd = os.open(folder, os.O_RDONLY)
                try:
                    os.fsync(backup_fd)
                finally:
                    os.close(backup_fd)
            os.chmod(output, path.stat().st_mode & 0o777)
            os.replace(output, path)
            if cache.exists():
                cache.unlink()
            directory_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            report.update(applied=True, backup=str(backup))
        print(json.dumps(report, indent=2))
