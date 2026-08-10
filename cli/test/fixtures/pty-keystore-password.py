import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


root, node, app = sys.argv[1:4]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root)
    os.environ["NO_COLOR"] = "1"
    os.environ["TERM"] = "xterm-256color"
    os.execv(node, [node, app])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
captured = bytearray()
state = "home"
deadline = time.time() + 4
snapshot_at = None
while True:
    if time.time() > deadline:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        sys.stdout.buffer.write(captured)
        sys.stdout.buffer.flush()
        raise SystemExit("timed out during keystore password PTY test: " + state)
    if state == "snapshot" and snapshot_at is not None and time.time() >= snapshot_at:
        snapshot_path = os.path.join(os.environ["SYMMIO_PTY_STATE_ROOT"], "keystore-progress.snapshot")
        with open(snapshot_path, "wb") as snapshot:
            snapshot.write(captured)
        state = "completion"
    ready, _, _ = select.select([fd], [], [], 0.1)
    if not ready:
        continue
    try:
        chunk = os.read(fd, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            break
        raise
    if not chunk:
        break
    captured.extend(chunk)
    view = bytes(captured)
    if state == "home" and b"to navigate" in view:
        os.write(fd, b"\r")
        state = "catalog"
    elif state == "catalog" and b"Keystore PTY task" in view:
        os.write(fd, b"\r")
        state = "keystore"
    elif state == "keystore" and b"Use Hardhat keystore?" in view:
        os.write(fd, b"\r")
        state = "password"
    elif state == "password" and b"Enter the password:" in view:
        os.write(fd, b"test-password\r")
        state = "plan"
    elif state == "plan" and (b"Plan complete." in view or b"Plan prepared; waiting" in view):
        snapshot_at = time.time() + 0.6
        state = "snapshot"
    elif state == "completion" and b"Keystore PTY task completed" in view:
        state = "wait-home"
    elif state == "wait-home" and view.count(b"What do you want to do?") >= 3:
        os.write(fd, b"\x03")
        state = "closed"

_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(captured)
if state != "closed":
    raise SystemExit("did not complete the keystore password interaction: " + state)
raise SystemExit(os.waitstatus_to_exitcode(status))
