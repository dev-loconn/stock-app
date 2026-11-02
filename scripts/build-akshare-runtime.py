"""Build a relocatable, isolated AKShare runtime from the prepared project venv."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def build(output):
    expected = Path(__file__).resolve().parents[1] / ".cache" / "akshare-runtime"
    if output != expected.resolve():
        raise ValueError("Runtime output must be the project's generated .cache/akshare-runtime directory")
    base = Path(sys.base_prefix)
    packages = Path(sys.prefix) / "Lib" / "site-packages"
    versions = sorted((item.metadata["Name"], item.version)
                      for item in importlib.metadata.distributions(path=[str(packages)]))
    if dict(versions).get("akshare") != "1.19.3":
        raise RuntimeError("Prepare the project AKShare 1.19.3 venv before packaging")
    fingerprint = hashlib.sha256(Path(__file__).read_bytes() + json.dumps([sys.version, versions]).encode()).hexdigest()
    manifest = output / "runtime-manifest.json"
    if manifest.exists() and json.loads(manifest.read_text(encoding="utf-8")).get("fingerprint") == fingerprint:
        return
    # The resolved target above is the single generated workspace cache, never a user install.
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)
    for pattern in ("python*.exe", "python*.dll", "vcruntime*.dll", "LICENSE*"):
        for source in base.glob(pattern):
            if source.is_file():
                shutil.copy2(source, output / source.name)
    skip = shutil.ignore_patterns("__pycache__", "*.pyc", "site-packages", "test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip")
    shutil.copytree(base / "Lib", output / "Lib", dirs_exist_ok=True, ignore=skip)
    shutil.copytree(base / "DLLs", output / "DLLs", dirs_exist_ok=True, ignore=shutil.ignore_patterns("*.pdb"))
    shutil.copytree(packages, output / "Lib" / "site-packages", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    # _pth isolation ignores the machine's Python installs, aliases and PYTHONPATH.
    tag = "python" + str(sys.version_info.major) + str(sys.version_info.minor)
    (output / (tag + "._pth")).write_text(".\nLib\nDLLs\nLib/site-packages\nimport site\n", encoding="utf-8")
    check = "import akshare,sys;assert sys.flags.isolated;assert akshare.__version__=='1.19.3';assert all(p.startswith(sys.prefix) for p in sys.path)"
    subprocess.run([str(output / "python.exe"), "-I", "-c", check], check=True,
                   env={key: value for key, value in os.environ.items() if key.upper() not in ("PYTHONHOME", "PYTHONPATH")})
    manifest.write_text(json.dumps({"python": sys.version.split()[0], "akshare": "1.19.3",
        "fingerprint": fingerprint, "packages": versions}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    build(parser.parse_args().output.resolve())
