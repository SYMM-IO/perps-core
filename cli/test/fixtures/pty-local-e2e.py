#!/usr/bin/env python3
"""Drive one full menu-only deployment against a separately running hardhat node."""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


root, node, entrypoint = sys.argv[1:4]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root)
    os.execve(node, [node, entrypoint], os.environ.copy())

fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) | os.O_NONBLOCK)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 120, 0, 0))

output = bytearray()
view_start = 0
state = "home"
deadline = time.time() + 900
exit_code = None


def send(data):
    global view_start
    os.write(fd, data)
    view_start = len(output)


while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except BlockingIOError:
            chunk = b""
        except OSError:
            chunk = b""
        output.extend(chunk)

    view = bytes(output[view_start:])
    if state == "home" and b"What do you want to do?" in view:
        send(b"\r")
        state = "catalog"
    elif state == "catalog" and b"Full SYMMIO system" in view:
        send(b"\r")
        state = "network"
    elif state == "network" and b"Where do you want to deploy?" in view:
        send(b"\r")
        state = "existing-or-overrides"
    elif state == "existing-or-overrides" and b"A reviewed recipe already exists" in view:
        # For a deliberate rerun, start again from reviewed defaults (third row).
        send(b"\x1b[B\x1b[B\r")
        state = "overrides"
    elif state in ("existing-or-overrides", "overrides") and b"Anything you want to override before the final review?" in view:
        send(b"\r")
        state = "review"
    elif state == "review" and b"Create the task with this exact reviewed intent?" in view:
        send(b"\r")
        state = "running"
    elif state == "running" and b"Full SYMMIO system completed" in view:
        state = "return-home"
    elif state == "running" and (b"failed and cannot be resumed" in view or b"is paused" in view or b"is waiting_external" in view):
        exit_code = 4
        break
    elif state == "return-home" and b"What do you want to do?" in view:
        send(b"\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\r")
        state = "exit"
    elif state == "exit" and b"Operator session closed" in view:
        break

    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        exit_code = os.waitstatus_to_exitcode(status)
        break

if exit_code is None:
    if state != "exit" or b"Operator session closed" not in output:
        exit_code = 5
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    else:
        _, status = os.waitpid(pid, 0)
        exit_code = os.waitstatus_to_exitcode(status)

sys.stdout.buffer.write(output)
sys.exit(exit_code)
