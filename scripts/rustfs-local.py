# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3>=1.40,<2"]
# ///
"""Local RustFS lifecycle. Run with: uv run scripts/rustfs-local.py start|status|stop."""
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

ROOT = Path.home() / ".local/share/filo-rustfs"
CONFIG = Path.home() / ".config/filo/rustfs.json"


def client(config):
    return boto3.client(
        "s3", endpoint_url=config["endpoint"], region_name=config["region"],
        aws_access_key_id=config["access_key_id"],
        aws_secret_access_key=config["secret_access_key"],
        config=Config(connect_timeout=2, read_timeout=3, retries={"max_attempts": 0}),
    )


def main():
    action = sys.argv[1] if len(sys.argv) == 2 else "status"
    if action not in {"start", "status", "stop"}:
        raise SystemExit("Usage: uv run scripts/rustfs-local.py start|status|stop")
    if action == "start":
        ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        (ROOT / "data").mkdir(exist_ok=True)
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        if not CONFIG.exists():
            with os.fdopen(os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
                json.dump({"endpoint": "http://127.0.0.1:9000", "region": "us-east-1", "bucket": "filo-demo", "access_key_id": "filo-local", "secret_access_key": secrets.token_urlsafe(32)}, file)
    if not CONFIG.exists():
        raise SystemExit("RustFS is not configured. Run start first.")
    config = json.loads(CONFIG.read_text())
    if action == "stop":
        if not (ROOT / "server.pid").exists():
            raise SystemExit("No managed RustFS PID found.")
        pid = int((ROOT / "server.pid").read_text())
        command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout
        if "rustfs server" not in command or str(ROOT / "data") not in command:
            raise SystemExit("PID no longer belongs to this RustFS instance; no process stopped.")
        os.kill(pid, signal.SIGTERM)
        (ROOT / "server.pid").unlink()
        print("RustFS stop requested; data retained.")
        return
    s3 = client(config)
    if action == "status":
        s3.head_bucket(Bucket=config["bucket"])
        print(f"RustFS ready: {config['endpoint']} / {config['bucket']}")
        return
    # Reuse a healthy instance. Never take over occupied ports.
    try:
        s3.head_bucket(Bucket=config["bucket"])
        print("RustFS is already running.")
        return
    except Exception:
        pass
    for port in (9000, 9001):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", port))
    binary = shutil.which("rustfs") or str(Path.home() / ".local/bin/rustfs")
    env = os.environ.copy()
    env.update(RUSTFS_ACCESS_KEY=config["access_key_id"], RUSTFS_SECRET_KEY=config["secret_access_key"], RUSTFS_OBS_LOGGER_LEVEL="warn", RUSTFS_OBS_LOG_DIRECTORY=str(ROOT / "logs"))
    with (ROOT / "server.log").open("ab") as log:
        process = subprocess.Popen([binary, "server", "--address", "127.0.0.1:9000", "--console-enable", "--console-address", "127.0.0.1:9001", "--region", config["region"], str(ROOT / "data")], env=env, stdout=log, stderr=log, start_new_session=True)
    (ROOT / "server.pid").write_text(str(process.pid))
    for _ in range(60):
        if process.poll() is not None:
            raise SystemExit(f"RustFS exited; inspect {ROOT / 'server.log'} locally.")
        try:
            s3.head_bucket(Bucket=config["bucket"])
            break
        except ClientError as error:
            if error.response["ResponseMetadata"]["HTTPStatusCode"] == 404:
                s3.create_bucket(Bucket=config["bucket"])
                break
            raise
        except Exception:
            time.sleep(0.25)
    else:
        raise SystemExit("RustFS startup timed out; inspect the local log.")
    print(f"RustFS ready: {config['endpoint']} / {config['bucket']}")
    print("Console: http://127.0.0.1:9001/rustfs/console/")
    print(f"Credentials: {CONFIG} (not printed)")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Avoid emitting request objects or credential-bearing SDK diagnostics.
        raise SystemExit(f"RustFS operation failed ({type(error).__name__}); check ports, service status and the protected local configuration.") from None
