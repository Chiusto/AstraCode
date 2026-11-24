"""``harness.sandbox`` 中属于 Windows 的部分。macOS 和 Linux 上不使用。

有三件事在 Windows 上不同，它们被放在这里，以便 ``sandbox.py`` 保持
简短：

* shell。Windows 没有 ``/bin/bash``。沙箱使用 Git for Windows
  随附的 ``bash.exe``，允许的程序也来自同一套安装（它的 ``usr/bin`` 目录，
  其中包含 ``grep``、``sort``、``awk`` 等）。``git_usr_bin()`` 会找到该目录。
* PATH 目录。普通 Windows 用户无法创建符号链接，而直接复制 ``grep.exe``
  也找不到它依赖的 DLL，因此 PATH 目录为每个允许的程序放一个
  小 shell 脚本，由它按完整路径启动真正的程序（``write_shim``）。
* 杀死命令。Windows 没有 ``kill`` 可以针对的进程组，
  因此每条命令都在作业对象（job object）中启动；终止
  该作业会杀死命令启动的所有进程（``Job``）。
"""

from __future__ import annotations

import ctypes
import os
import shutil
from pathlib import Path

INSTALL_HINT = (
    "Command rejected: no shell was found. The terminal sandbox needs the bash.exe that "
    "ships with Git for Windows. Install it from https://git-scm.com/download/win "
    "(the default options are fine) and start a new terminal."
)


def git_usr_bin() -> Path | None:
    """Git for Windows 的 ``usr/bin`` 目录；若未安装则为 None。"""
    roots = []
    for name in ("git", "bash"):
        found = shutil.which(name)
        if found:
            roots += Path(found).resolve().parents[:3]  # Git/cmd/git.exe、Git/usr/bin/bash.exe 等
    for var in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "LOCALAPPDATA"):
        if os.environ.get(var):
            roots.append(Path(os.environ[var]) / "Git")
            roots.append(Path(os.environ[var]) / "Programs" / "Git")
    for root in roots:
        if (root / "usr" / "bin" / "bash.exe").exists() and (root / "usr" / "bin" / "msys-2.0.dll").exists():
            return root / "usr" / "bin"
    return None


def posix_path(path: str | Path) -> str:
    """``C:\\Users\\x`` 在 bash 眼中的样子：``/c/Users/x``。"""
    drive, rest = os.path.splitdrive(str(path))
    return "/" + drive.rstrip(":").lower() + rest.replace("\\", "/")


def write_shim(shim: Path, target: str) -> None:
    """写出脚本 ``shim``，它以相同的参数运行 ``target``。"""
    shim.write_text(f'#!/bin/sh\nexec "{posix_path(target)}" "$@"\n', newline="\n")


def child_env(workspace: Path) -> dict[str, str]:
    """Windows 进程在沙箱自身变量之外还需要的环境变量。"""
    return {
        "SYSTEMROOT": os.environ.get("SYSTEMROOT", r"C:\Windows"),  # 没有它，Python 无法启动
        "TEMP": str(workspace), "TMP": str(workspace), "USERPROFILE": str(workspace),
    }  # fmt: skip


# ----------------------------------------------------------- 作业对象 ---

_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
_JobObjectExtendedLimitInformation = 9


class _BasicLimits(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.c_uint32), ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t), ("PriorityClass", ctypes.c_uint32), ("SchedulingClass", ctypes.c_uint32),
    ]  # fmt: skip


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimits), ("IoInfo", ctypes.c_uint64 * 6),
        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]  # fmt: skip


class Job:
    """一个 Windows 作业对象。``add(proc)`` 把一个进程及其将要
    启动的一切放入该作业；``kill()`` 终止它们全部。该作业
    还被设置为：如果本进程未调用 ``kill`` 就退出，则杀死其进程。"""

    def __init__(self) -> None:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)  # 仅存在于 Windows 上
        k32.CreateJobObjectW.restype = ctypes.c_void_p
        k32.SetInformationJobObject.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        k32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        k32.TerminateJobObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        k32.CloseHandle.argtypes = [ctypes.c_void_p]
        self._k32 = k32
        self._handle = k32.CreateJobObjectW(None, None)
        if not self._handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = _ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(
            self._handle, _JobObjectExtendedLimitInformation, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            raise ctypes.WinError(ctypes.get_last_error())

    def add(self, proc) -> None:
        """把一个 ``subprocess.Popen`` 进程放入该作业。"""
        if not self._k32.AssignProcessToJobObject(self._handle, int(proc._handle)):
            raise ctypes.WinError(ctypes.get_last_error())

    def kill(self) -> None:
        """终止作业中的每个进程并释放该作业。"""
        self._k32.TerminateJobObject(self._handle, 1)
        self._k32.CloseHandle(self._handle)
