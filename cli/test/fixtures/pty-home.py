import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def resize(fd, columns):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, columns, 0, 0))


root, node, cli = sys.argv[1:4]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root)
    os.environ["NO_COLOR"] = "1"
    os.environ["TERM"] = "xterm-256color"
    os.execv(node, [node, cli])

resize(fd, 80)
captured = bytearray()
navigated = False
while True:
    ready, _, _ = select.select([fd], [], [], 5)
    if not ready:
        os.kill(pid, signal.SIGKILL)
        raise SystemExit("timed out waiting for operator menu")
    try:
        chunk = os.read(fd, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            break
        raise
    if not chunk:
        break
    captured.extend(chunk)
    if not navigated and b"to navigate" in captured:
        navigated = True
        resize(fd, 120)
        os.kill(pid, signal.SIGWINCH)
        os.write(fd, b"\x1b[A\r")

_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(captured)
if not navigated:
    raise SystemExit("home menu navigation instructions were not rendered")
raise SystemExit(os.waitstatus_to_exitcode(status))
