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
        raise SystemExit("timed out during double-interrupt PTY test")
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
    elif state == "progress" and b"1 confirmed" in view:
        os.write(fd, b"\x03\x03")
        state = "interrupted"

_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(captured)
exit_code = os.waitstatus_to_exitcode(status)
if state != "interrupted" or exit_code != 130:
    raise SystemExit("expected immediate exit 130, got state=%s code=%s" % (state, exit_code))
