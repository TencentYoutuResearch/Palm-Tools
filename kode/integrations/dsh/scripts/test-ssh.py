#!/usr/bin/env python3
"""Verify real OpenSSH forwarding with disposable keys/config; never change ~/.ssh."""
import os
import pathlib
import pwd
import shutil
import socket
import subprocess
import tempfile
import time

project = pathlib.Path(__file__).resolve().parents[3]
sshd = shutil.which('sshd') or '/usr/sbin/sshd'
with tempfile.TemporaryDirectory(prefix='kode-ssh-test-') as temporary:
    root = pathlib.Path(temporary)
    for name in ('host', 'client'):
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(root / name)], check=True)
    (root / 'authorized_keys').write_text((root / 'client.pub').read_text())
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    (root / 'sshd.conf').write_text(f'''Port {port}
ListenAddress 127.0.0.1
HostKey {root}/host
PidFile {root}/pid
AuthorizedKeysFile {root}/authorized_keys
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
AllowTcpForwarding yes
LogLevel ERROR
''')
    (root / 'ssh.conf').write_text(f'''Host messaging.example
 HostName 127.0.0.1
 User {pwd.getpwuid(os.geteuid()).pw_name}
 IdentityFile {root}/client
 IdentitiesOnly yes
 StrictHostKeyChecking yes
 UserKnownHostsFile {root}/known_hosts
''')
    (root / 'known_hosts').write_text(f'[127.0.0.1]:{port} ' + (root / 'host.pub').read_text())
    with (root / 'sshd.log').open('w+') as log:
        daemon = subprocess.Popen([sshd, '-D', '-e', '-f', str(root / 'sshd.conf')], stdout=log, stderr=log)
        try:
            for _ in range(100):
                if daemon.poll() is not None:
                    log.seek(0)
                    raise RuntimeError('disposable sshd failed: ' + log.read())
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=.1):
                        break
                except OSError:
                    time.sleep(.05)
            env = dict(os.environ, KODE_TEST_SSH_CONFIG=str(root / 'ssh.conf'), KODE_TEST_SSH_PORT=str(port))
            subprocess.run(['cargo', 'test', '-p', 'kode-bridge', 'messaging::tests::ssh_link', '--', '--ignored', '--test-threads=1'], cwd=project, env=env, check=True)
        finally:
            daemon.terminate()
            daemon.wait(timeout=10)
