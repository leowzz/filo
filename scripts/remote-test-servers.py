# /// script
# requires-python = ">=3.11"
# dependencies = ["pyftpdlib>=2,<3", "asyncssh>=2,<3", "impacket>=0.13,<1"]
# ///
"""Disposable loopback FTP/FTPS, SFTP and SMB2 servers for provider acceptance.

Run: uv run scripts/remote-test-servers.py /tmp/filo-remote-fixture.json
The private manifest contains endpoints and generated credentials. Servers use
temporary directories only; SIGINT/SIGTERM stops them and removes the fixture.
These small test servers do not stand in for all production server variants.
"""

import asyncio
import datetime
import ipaddress
import json
import logging
import os
from pathlib import Path
import secrets
import signal
import sys
import tempfile
import threading

import asyncssh
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from impacket.ntlm import compute_lmhash, compute_nthash
from impacket.smbserver import SimpleSMBServer
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler, TLS_FTPHandler
from pyftpdlib.ioloop import IOLoop
from pyftpdlib.servers import FTPServer


async def main(manifest_path: Path):
    # Never overwrite an existing manifest from another running fixture.
    manifest_fd = os.open(manifest_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    username = "filo-test"
    password = secrets.token_urlsafe(24)
    logging.basicConfig(level=logging.ERROR)
    stop = asyncio.Event()
    def serve_ftp(server):
        try:
            server.serve_forever(timeout=0.2, handle_exit=False)
        except OSError:
            if not stop.is_set():
                raise

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    ftp = ftps = smb = ssh = None
    try:
        with tempfile.TemporaryDirectory(prefix="filo-remote-test-") as temporary:
            outside = Path(temporary) / "outside.txt"
            outside.write_text("Outside configured root\n", encoding="utf-8")
            roots = {}
            for protocol in ("ftp", "ftps", "sftp", "smb"):
                root = Path(temporary) / protocol
                root.mkdir()
                (root / "seed.txt").write_text("Filo remote fixture\n", encoding="utf-8")
                (root / "folder").mkdir()
                if protocol != "smb":
                    (root / "outside-link").symlink_to(outside)
                roots[protocol] = root

            authorizer = DummyAuthorizer()
            authorizer.add_user(username, password, str(roots["ftp"]), perm="elradfmwMT")

            class Handler(FTPHandler):
                pass

            Handler.authorizer = authorizer
            ftp = FTPServer(("127.0.0.1", 0), Handler, ioloop=IOLoop())
            ftp_port = ftp.socket.getsockname()[1]
            threading.Thread(target=serve_ftp, args=(ftp,), daemon=True).start()

            ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            tls_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Filo fixture CA")])
            now = datetime.datetime.now(datetime.timezone.utc)
            certificate = (
                x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
                .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - datetime.timedelta(minutes=1))
                .not_valid_after(now + datetime.timedelta(days=1))
                .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
                .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, None, None), critical=True)
                .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
                .sign(ca_key, hashes.SHA256())
            )
            server_certificate = (
                x509.CertificateBuilder()
                .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]))
                .issuer_name(subject).public_key(tls_key.public_key())
                .serial_number(x509.random_serial_number())
                .not_valid_before(now - datetime.timedelta(minutes=1))
                .not_valid_after(now + datetime.timedelta(days=1))
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
                .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                .add_extension(x509.SubjectAlternativeName([
                    x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))
                ]), critical=False).sign(ca_key, hashes.SHA256())
            )
            ca_path = Path(temporary) / "ca.pem"
            cert_path = Path(temporary) / "server.pem"
            key_path = Path(temporary) / "server.key"
            ca_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
            cert_path.write_bytes(server_certificate.public_bytes(serialization.Encoding.PEM))
            key_path.write_bytes(tls_key.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ))
            key_path.chmod(0o600)
            tls_authorizer = DummyAuthorizer()
            tls_authorizer.add_user(username, password, str(roots["ftps"]), perm="elradfmwMT")

            class TLSHandler(TLS_FTPHandler):
                pass

            TLSHandler.authorizer = tls_authorizer
            TLSHandler.certfile = str(cert_path)
            TLSHandler.keyfile = str(key_path)
            TLSHandler.tls_control_required = True
            TLSHandler.tls_data_required = True
            ftps = FTPServer(("127.0.0.1", 0), TLSHandler, ioloop=IOLoop())
            ftps_port = ftps.socket.getsockname()[1]
            threading.Thread(target=serve_ftp, args=(ftps,), daemon=True).start()

            class SSHServer(asyncssh.SSHServer):
                def begin_auth(self, user):
                    return True

                def password_auth_supported(self):
                    return True

                def validate_password(self, user, candidate):
                    return user == username and secrets.compare_digest(candidate, password)

            key = asyncssh.generate_private_key("ssh-ed25519")
            ssh = await asyncssh.create_server(
                SSHServer,
                "127.0.0.1",
                0,
                server_host_keys=[key],
                sftp_factory=lambda channel: asyncssh.SFTPServer(channel, chroot=str(roots["sftp"])),
            )
            ssh_port = ssh.get_port()
            known_hosts = f"[127.0.0.1]:{ssh_port} {key.export_public_key().decode().strip()}\n"

            smb = SimpleSMBServer(listenAddress="127.0.0.1", listenPort=0)
            smb.setSMB2Support(True)
            smb.addShare("files", str(roots["smb"]), "Filo disposable test files")
            smb.addCredential(username, 0, compute_lmhash(password), compute_nthash(password))
            smb_port = smb.getServer().server_address[1]
            threading.Thread(target=smb.start, daemon=True).start()

            manifest = {
                "username": username,
                "password": password,
                "host": "127.0.0.1",
                "ftp_port": ftp_port,
                "ftps_port": ftps_port,
                "tls_ca": str(ca_path),
                "sftp_port": ssh_port,
                "smb_port": smb_port,
                "share": "files",
                "known_hosts": known_hosts,
                "roots": {protocol: str(root) for protocol, root in roots.items()},
            }
            with os.fdopen(manifest_fd, "w") as output:
                manifest_fd = None
                json.dump(manifest, output)
            print(f"FTP/FTPS/SFTP/SMB2 ready; private fixture manifest: {manifest_path}", flush=True)
            await stop.wait()
            ssh.close()
            await ssh.wait_closed()
            ftp.close_all()
            ftps.close_all()
            smb.getServer().shutdown()
            smb.getServer().server_close()
    finally:
        if manifest_fd is not None:
            os.close(manifest_fd)
        if ssh:
            ssh.close()
        if ftp:
            ftp.close_all()
        if ftps:
            ftps.close_all()
        if smb:
            smb.getServer().server_close()
        manifest_path.unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: uv run scripts/remote-test-servers.py /absolute/private-manifest.json")
    asyncio.run(main(Path(sys.argv[1]).resolve()))
