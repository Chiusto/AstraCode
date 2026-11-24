"""终端沙箱。

``run_terminal(cmd)`` 运行一条由模型编写的 shell 命令，并返回一个
``TerminalResult``。它应用四层防护。下面列出每一层，以及在每层中它能阻止
什么、不能阻止什么。

1. 允许列表检查（``check_command``）。命令会在未加引号的 ``|``、``&``、``;``、
   括号和换行处被拆分为简单命令。每条简单命令都必须以
   ``ALLOWED_PROGRAMS`` 或 ``SHELL_BUILTINS`` 中的名称开头。
   会被拒绝的写法：以路径形式给出的程序（``/bin/rm``、``./x.py``）、变量赋值
   （``X=1 cmd``）、命令替换（``$(...)``、反引号）、
   ``$'...'`` 字符串和 here-document（``<<``）。被拒绝的命令
   永远不会被启动。
   不覆盖：参数。``python3``、``awk``（``system()``）、
   ``find -exec`` 和 ``xargs`` 可以启动其他程序或打开任意路径，
   而诸如 ``> ~/notes.txt`` 的重定向也能通过检查。

2. 受限环境。命令在工作区内的 bash 下运行，
   不带有你进程的任何环境变量（因此没有 API 密钥），
   并且 PATH 被设为一个只包含指向允许程序的链接的目录。
   ``python3`` 是基础解释器，不包含本项目的
   包。
   不覆盖：以其绝对路径启动的程序。

3. 超时与输出上限。命令在自己的进程组中运行。当
   超时到期，或命令退出时，进程组中仍然存在的每个进程
   都会被杀死。stdout 和 stderr 各自最多保留 ``MAX_OUTPUT_BYTES`` 字节；
   更短的输出会完整返回。
   不覆盖：离开进程组的进程（``os.setsid()``）；内存、
   CPU 和磁盘用量。

4. 操作系统级隔离环境（jail），如果可用的话（``jail()`` 会说明是哪一种）。
   只有这一层也会约束 ``python3`` 和绝对路径。
   * macOS，``sandbox-exec``：无网络；不能在工作区之外写入；
     不能读取你的主目录或本仓库（因此也读不到 ``.env``），
     但工作区和 Python 安装除外。机器上的其他文件
     仍可读取。
   * Linux，``bwrap``（bubblewrap），如果已安装且被允许：相同的
     规则，并且命令看不到其他进程。
   * 其他情况为 "none"：第 1 至 3 层仍然生效，但运行 ``python3`` 的命令
     可以使用网络，并能读写你有权限读写的任何文件。

工作区是命令的当前目录和 ``$HOME``；默认是本进程的临时目录，
进程退出时删除。

在 Windows 上（不带 WSL），第 1 至 3 层生效但有以下差异，
并且没有第 4 层：``jail()`` 为 "none"，因此运行
``python3`` 的命令可以使用网络，并能读写你有权限读写的任何文件。
* shell 是 Git for Windows 的 ``bash.exe``，允许的程序是它
  ``usr/bin`` 中的那些。如果没有安装 Git for Windows，
  每条命令都会被拒绝，并给出说明这一点的消息。
* PATH 目录中每个允许的程序对应一个小脚本，而不是
  链接（普通 Windows 用户无法创建符号链接）。
* 命令在作业对象（job object）中运行，超时时被杀死的正是它。
* 输出中的 Windows 换行符（``\\r\\n``）会被转换为 ``\\n``。
细节见 ``sandbox_windows.py``。
"""

from __future__ import annotations

import atexit
import functools
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

from harness import sandbox_windows

ALLOWED_PROGRAMS = (
    "python3", "python", "cat", "head", "tail", "grep", "wc", "sort", "uniq", "cut",
    "sed", "awk", "tr", "ls", "find", "jq", "diff", "comm", "paste", "join", "nl",
    "tee", "xargs", "basename", "dirname", "date", "seq", "mkdir",
)  # fmt: skip
SHELL_BUILTINS = ("cd", "echo", "printf", "pwd", "read", "test", "[", "true", "false")
MAX_OUTPUT_BYTES = 4_000_000  # 每个流

_KEYWORDS = {"if", "then", "elif", "else", "fi", "while", "until", "do", "done", "!", "{", "}"}
_WINDOWS = sys.platform == "win32"
if _WINDOWS:  # 程序与 shell 来自 Git for Windows；若未安装则为 None
    _SYSTEM_PATH = str(sandbox_windows.git_usr_bin() or "")
    _SHELL = os.path.join(_SYSTEM_PATH, "bash.exe") if _SYSTEM_PATH else None
else:
    _SYSTEM_PATH = "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
    _SHELL = "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"


@dataclass
class TerminalResult:
    stdout: str = ""
    stderr: str = ""
    exit_code: int | None = None  # 如果命令被拒绝或超时则为 None
    timed_out: bool = False
    rejected: bool = False  # 若允许列表检查拒绝了命令，或没有 shell，则为 True
    reason: str = ""  # 被拒绝或被杀的原因；其他情况为 ""


def _simple_commands(cmd: str) -> list[str]:
    """在未加引号的 | & ; ( ) 和换行处拆分 ``cmd``，并丢弃注释。"""
    parts, cur, quote, i = [], [], "", 0
    while i < len(cmd):
        c = cmd[i]
        if quote == "'":  # 单引号内没有任何特殊字符
            quote = "" if c == "'" else quote
        elif c == "\\":  # 把反斜杠与它所转义的字符一起保留
            c = cmd[i : i + 2]
        elif c == "`" or cmd.startswith(("$(", "$'"), i):
            raise ValueError("command substitution ($(...) or backticks) and $'...' are not supported")
        elif quote == '"':
            quote = "" if c == '"' else quote
        elif c in "'\"":
            quote = c
        elif cmd.startswith("<<", i):
            raise ValueError("here-documents (<<) are not supported; use python3 -c '...' instead")
        elif c == "#" and (i == 0 or cmd[i - 1] in " \t\n;|&()"):  # 注释：跳到行尾
            i = cmd.find("\n", i) if "\n" in cmd[i:] else len(cmd)
            continue
        elif c in "|;()\n" or (c == "&" and cmd[i - 1 : i] not in ("<", ">") and cmd[i + 1 : i + 2] != ">"):
            parts.append("".join(cur))  # 2>&1 和 &> 中的 "&" 是重定向，不是分隔符
            cur, c = [], " "
        cur.append(c)
        i += len(c)
    if quote:
        raise ValueError("unbalanced quote")
    return parts + ["".join(cur)]


def _program(simple_command: str) -> str | None:
    """shell 会作为程序运行的那个词；若没有则为 None。"""
    words = shlex.split(simple_command)
    while words:
        word = words.pop(0)
        if word == "for":  # "for x in a b c"：剩余的词不是命令
            return None
        if re.match(r"\d*[<>]|&>", word):  # 一个重定向
            if word[-1] in "<>&":  # 操作符与目标分为两个词
                words = words[1:]
        elif word not in _KEYWORDS:
            return word
    return None


def check_command(cmd: str) -> str:
    """若 ``cmd`` 通过允许列表检查则返回 ""，否则返回它未通过的原因。"""
    allowed = ALLOWED_PROGRAMS + SHELL_BUILTINS
    try:
        programs = [_program(part) for part in _simple_commands(cmd)]
    except ValueError as e:
        return f"Command rejected: {e}."
    for program in programs:
        if program is not None and program not in allowed:
            return f"Command rejected: {program!r} is not an allowed program. Allowed: {', '.join(allowed)}."
    if not any(programs):
        return "Command rejected: it contains no program to run."
    return ""


@functools.cache
def _state_dir() -> Path:
    """本进程使用的临时目录，在进程退出时删除。"""
    path = Path(tempfile.mkdtemp(prefix="harness_sandbox_")).resolve()
    atexit.register(_remove_tree, path)
    return path


def _remove_tree(path: Path) -> None:
    if _WINDOWS:  # 只读文件无法按原样删除
        for file in path.rglob("*"):
            file.chmod(0o666)
    shutil.rmtree(path, ignore_errors=True)


@functools.cache
def _bin_dir() -> Path:
    """用作 PATH 的目录：本机上找到的每个允许程序对应一个符号链接
    （在 Windows 上是一个运行该程序的脚本）。"""
    bin_dir = _state_dir() / "bin"
    bin_dir.mkdir()
    python = os.path.realpath(getattr(sys, "_base_executable", "") or sys.executable)
    for name in ALLOWED_PROGRAMS:
        target = python if name.startswith("python") else shutil.which(name, path=_SYSTEM_PATH)
        if target and _WINDOWS:
            sandbox_windows.write_shim(bin_dir / name, target)
        elif target:
            (bin_dir / name).symlink_to(target)
    return bin_dir


def make_workspace(path: str | Path | None = None) -> Path:
    """创建目录 ``path``（若为 None 则新建一个临时目录）并返回该目录。"""
    ws = Path(path).resolve() if path is not None else Path(tempfile.mkdtemp(prefix="harness_ws_"))
    ws.mkdir(parents=True, exist_ok=True)
    return ws


def default_workspace() -> Path:
    """``run_terminal`` 在未给定工作区时使用的工作区：为本进程创建的
    临时目录，并在进程退出时删除。"""
    return make_workspace(_state_dir() / "workspace")


def _jail_argv(workspace: Path) -> list[str]:
    """为 ``workspace`` 启动操作系统隔离环境（jail）的命令前缀（若没有则为 []）。"""
    repo_root = Path(__file__).resolve().parent.parent
    ws, home, repo, py, bin_dir = (
        str(Path(p).resolve())
        for p in (workspace, Path.home(), repo_root, sys.base_prefix, _bin_dir())
    )
    if sys.platform == "darwin" and os.path.exists("/usr/bin/sandbox-exec"):
        q = json.dumps  # 为配置（profile）中的路径加引号
        profile = (
            "(version 1)(allow default)(deny network*)"
            f'(deny file-write*)(allow file-write* (subpath {q(ws)}) (subpath "/dev/fd")'
            '(literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))'
            f"(deny file-read* (subpath {q(home)}) (subpath {q(repo)}))"
            f"(allow file-read* (subpath {q(ws)}) (subpath {q(py)}))"
        )
        return ["/usr/bin/sandbox-exec", "-p", profile]
    if sys.platform == "linux" and shutil.which("bwrap"):
        return [
            shutil.which("bwrap"), "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
            "--tmpfs", home, "--tmpfs", repo, "--ro-bind", py, py, "--ro-bind", bin_dir, bin_dir,
            "--bind", ws, ws,
            "--unshare-net", "--unshare-pid", "--die-with-parent",
        ]  # fmt: skip
    return []


@functools.cache
def jail() -> str:
    """当前使用的是哪种操作系统隔离环境（jail）："sandbox-exec"、"bwrap" 或 "none"。
    该隔离环境会先用一条简单命令试一次。如果失败（例如
    本进程本身就在沙箱中），则不使用隔离环境。Windows 没有。"""
    if _WINDOWS:
        return "none"
    argv = _jail_argv(_state_dir())
    try:
        if argv and subprocess.run([*argv, _SHELL, "-c", "true"], capture_output=True, timeout=10).returncode == 0:
            return Path(argv[0]).name
    except (OSError, subprocess.SubprocessError):
        pass
    return "none"


def _drain(pipe, buf: bytearray) -> None:
    """把 ``pipe`` 读到末尾，``buf`` 中最多保留 MAX_OUTPUT_BYTES 字节。"""
    while chunk := os.read(pipe.fileno(), 65536):
        buf += chunk[: MAX_OUTPUT_BYTES - len(buf)]


def _text(buf: bytearray) -> str:
    note = f"\n[sandbox: output cut off after {MAX_OUTPUT_BYTES} bytes]" if len(buf) >= MAX_OUTPUT_BYTES else ""
    text = bytes(buf).decode("utf-8", errors="replace")
    return (text.replace("\r\n", "\n") if _WINDOWS else text) + note


def run_terminal(cmd: str, *, workspace: str | Path | None = None, timeout: float = 10.0) -> TerminalResult:
    """在沙箱中运行 ``cmd`` 并返回实际发生的情况。

    ``workspace`` 是工作目录（不存在时会被创建）；``None`` 表示
    ``default_workspace()``。超时或允许列表拒绝都会在结果中
    报告，而不是抛出异常。
    """
    reason = check_command(cmd)
    if reason:
        return TerminalResult(rejected=True, reason=reason)
    if _SHELL is None:  # 没有 Git for Windows 的 Windows
        return TerminalResult(rejected=True, reason=sandbox_windows.INSTALL_HINT)
    ws = make_workspace(workspace) if workspace is not None else default_workspace()
    env = {
        "PATH": str(_bin_dir()), "HOME": str(ws), "TMPDIR": str(ws),
        "LC_ALL": "C", "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1",
        **(sandbox_windows.child_env(ws) if _WINDOWS else {}),
    }  # fmt: skip
    argv = (_jail_argv(ws) if jail() != "none" else []) + [_SHELL, "-c", cmd]
    job = sandbox_windows.Job() if _WINDOWS else None  # Windows：用作业对象代替进程组
    proc = subprocess.Popen(
        argv, cwd=ws, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=not _WINDOWS,  # 新会话 = 自己的进程组
        creationflags=subprocess.CREATE_NO_WINDOW if _WINDOWS else 0,
    )  # fmt: skip
    if job:
        job.add(proc)
    out, err = bytearray(), bytearray()
    readers = [
        threading.Thread(target=_drain, args=(pipe, buf), daemon=True)
        for pipe, buf in ((proc.stdout, out), (proc.stderr, err))
    ]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
    if job:  # 杀死组中剩下的一切：命令本身，或它留下的作业
        job.kill()
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    proc.wait()
    for reader in readers:
        reader.join(timeout=1.0)
    return TerminalResult(
        stdout=_text(out),
        stderr=_text(err),
        exit_code=None if timed_out else proc.returncode,
        timed_out=timed_out,
        reason=f"Timed out after {timeout:g} seconds; the command was killed." if timed_out else "",
    )
