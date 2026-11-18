"""CorrDiff 環境安裝(只有要跑 CorrDiff 的電腦需要;排程電腦、樹莓派不用):
  python -m pipeline.corrdiff_setup            建 .venv-corrdiff(沿用系統已裝的套件)、裝 CUDA 版 PyTorch 與 earth2studio
  python -m pipeline.corrdiff_setup --cuda cu130   驅動較舊時指定 CUDA 版本;--cpu 裝 CPU 版
pygrib 在 Windows 編不了,CorrDiff 也用不到 → earth2studio 不裝相依,其餘相依另外裝。"""
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENV = ROOT / ".venv-corrdiff"
PY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
LIST_DEPS = r"""
import re
from importlib.metadata import requires
for r in requires('earth2studio'):
    name = re.split(r'[ ;<>=!~\[(]', r)[0].lower()
    if name == 'pygrib':
        continue
    if 'extra' not in r:
        print(r)
    elif re.search(r'extra\s*==\s*.corrdiff.', r):
        print(r.split(';')[0])
"""


def run(*cmd, **kw):
    print(">", " ".join(map(str, cmd)), flush=True)
    return subprocess.run(list(map(str, cmd)), check=True, **kw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cuda", default="cu132", help="PyTorch 的 CUDA 版本")
    ap.add_argument("--cpu", action="store_true", help="裝 CPU 版")
    a = ap.parse_args()
    if not PY.exists():
        run(sys.executable, "-m", "venv", "--system-site-packages", VENV)
    pip = [PY, "-m", "pip", "install"]
    run(*pip, "torch", "--index-url", f"https://download.pytorch.org/whl/{'cpu' if a.cpu else a.cuda}")
    run(*pip, "--no-deps", "earth2studio")
    deps = run(PY, "-c", LIST_DEPS, capture_output=True, text=True).stdout.split("\n")
    deps = [d.strip() for d in deps if d.strip() and not re.match(r"torch\b", d.strip())]
    run(*pip, *deps, "psutil")
    run(PY, "-c", "import torch; print('torch', torch.__version__, 'GPU', torch.cuda.is_available(), "
                  "torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')")
    print(f"\n完成。量速度:\n  {PY} -m pipeline.fetch_corrdiff --bench\n持續跑:\n  {PY} -m pipeline.fetch_corrdiff --loop")


if __name__ == "__main__":
    main()
