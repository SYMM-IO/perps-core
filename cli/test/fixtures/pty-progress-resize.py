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


def resize(fd, columns):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, columns, 0, 0))


root, node, app = sys.argv[1:4]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root)
    os.environ["NO_COLOR"] = "1"
    os.environ["TERM"] = "xterm-256color"
    os.environ["SYMMIO_PTY_HOLD_MS"] = "6000"
    os.execv(node, [node, app])

resize(fd, 80)
captured = bytearray()
state = "home"
capture_at = None
deadline = time.time() + 10
while True:
    now = time.time()
    if now > deadline:
        os.kill(pid, signal.SIGKILL)
        raise SystemExit("timed out during progress resize test: " + state)
    if capture_at is not None and now >= capture_at:
        os.kill(pid, signal.SIGKILL)
        break
    ready, _, _ = select.select([fd], [], [], 0.02)
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
    elif state == "catalog" and b"Synthetic PTY task" in view:
        os.write(fd, b"\r")
        state = "keystore"
    elif state == "keystore" and b"Use Hardhat keystore?" in view:
        os.write(fd, b"\r")
        state = "progress"
    elif state == "progress" and b"Transactions 1 confirmed" in view:
        resize(fd, 120)
        os.kill(pid, signal.SIGWINCH)
        capture_at = time.time() + 0.15
        state = "capture"

os.waitpid(pid, 0)
sys.stdout.buffer.write(captured)
if state != "capture":
    raise SystemExit("did not reach resized progress state: " + state)
