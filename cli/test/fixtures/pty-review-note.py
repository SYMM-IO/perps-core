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


root, node, app, columns = sys.argv[1:5]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root)
    os.environ["NO_COLOR"] = "1"
    os.environ["TERM"] = "xterm-256color"
    os.execv(node, [node, app])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, int(columns), 0, 0))
captured = bytearray()
state = "home"
capture_at = None
deadline = time.monotonic() + 10
try:
    while True:
        now = time.monotonic()
        if now > deadline:
            raise SystemExit("timed out during CSV review: " + state)
        if capture_at is not None and now >= capture_at:
            break
        ready, _, _ = select.select([fd], [], [], 0.05)
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
            state = "review"
        elif state == "review" and b"After reviewing the CSV" in view:
            # Exercise prompt redraw and multiple progress heartbeats without authorizing.
            os.write(fd, b"4")
            capture_at = time.monotonic() + 1.2
            state = "capture"
finally:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    os.close(fd)

sys.stdout.buffer.write(captured)
if state != "capture":
    raise SystemExit("did not reach the CSV authorization prompt: " + state)
