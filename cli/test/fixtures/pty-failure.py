#!/usr/bin/env python3
"""Drive a deterministic subprocess failure through the real operator terminal."""

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
    environment = os.environ.copy()
    environment["NO_COLOR"] = "1"
    environment["TERM"] = "xterm-256color"
    environment["SYMMIO_PTY_FAIL"] = "true"
    os.execve(node, [node, app], environment)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 120, 0, 0))
captured = bytearray()
state = "home"
deadline = time.time() + 12

while True:
    if time.time() > deadline:
        os.kill(pid, signal.SIGKILL)
        raise SystemExit("timed out during failure-reporting PTY test: " + state)
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
        state = "failure"
    elif state == "failure" and b"simulated operator failure" in view:
        state = "reported"
    elif state == "reported" and view.count(b"What do you want to do?") >= 3:
        os.write(fd, b"\x03")
        state = "closed"

_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(captured)
if state != "closed":
    raise SystemExit("did not complete failure-reporting interaction: " + state)
raise SystemExit(os.waitstatus_to_exitcode(status))
