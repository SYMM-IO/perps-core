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
deadline = time.time() + 12
while True:
    if time.time() > deadline:
        os.kill(pid, signal.SIGKILL)
        raise SystemExit("timed out during progress PTY test")
    ready, _, _ = select.select([fd], [], [], 0.2)
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
    elif state == "progress" and b"press d to show" in view:
        os.write(fd, b"d")
        state = "details"
    elif state == "details" and b"gas 42000" in view:
        os.write(fd, b"\x03")
        state = "pausing"
    elif state == "pausing" and b"is paused" in view:
        state = "wait-home"
    elif state == "wait-home" and view.count(b"What do you want to do?") >= 3:
        os.write(fd, b"\x03")
        state = "closed"

_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(captured)
if state != "closed":
    raise SystemExit("did not complete the PTY progress interaction: " + state)
raise SystemExit(os.waitstatus_to_exitcode(status))
