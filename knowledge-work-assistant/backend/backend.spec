# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec：打包对话回声后端为 onedir。

产物 ``backend/dist/backend/``（含 ``backend.exe`` + ``_internal/``），由
electron-builder extraResources 带入安装包，launcher.ts 探测 ``backend.exe`` 启动。

设计要点：
- onedir（非 onefile）：启动快，适合常驻服务，避免每次启动解压临时目录。
- 入口 run_pyi.py：直接传 app 对象给 uvicorn.run，避免字符串导入在 frozen 环境失败。
- hiddenimports：app 包 + uvicorn/pydantic/fastapi/starlette 子模块（动态导入）。
- aiosqlite / greenlet / cryptography / pydantic_core / lxml：含编译型扩展或动态加载
  资源，collect_submodules 仅收 .py 模块名，不足以让 PyInstaller 把 .pyd/.dll 与数据
  文件打包进 PYZ；改用 collect_all 把它们作为 datas/binaries 显式打包到 _internal/，
  runtime 可直接定位。
  - aiosqlite / greenlet：sqlalchemy 通过 import_dbapi 动态加载
  - cryptography：42+ Rust binding（cryptography.hazmat.bindings._rust.*）经 cffi 动态加载
  - pydantic_core：pydantic v2 的 C 核心 _pydantic_core.cp312-win_amd64.pyd
  - lxml：python-docx / python-pptx 依赖，C 扩展 + schema 数据文件
  collect_all 的结果须作为 Analysis 的 datas/binaries 参数传入（让 Analysis 规范化
  2元组→3元组、展开目录），切勿在 Analysis 之后 a.datas += 绕过规范化。
- excludes：剔除测试/dev 依赖与无关标准库，减小体积。
- console：Windows 用 False（windowed 模式，不弹控制台黑窗）；macOS 用 True，
  产出普通 Unix 可执行文件 ``backend`` 而非 ``backend.app`` bundle——保持与
  Windows 相同的 onedir 目录结构（``backend`` + ``_internal/``），launcher 可
  统一以「目录 + 平台文件名」定位。macOS 下 Electron spawn 子进程不分配终端，
  console=True 不会弹出终端窗口。
"""
import sys

from PyInstaller.utils.hooks import collect_all, collect_submodules

# 含编译型扩展 / 动态加载资源的包：collect_submodules 只收 .py 模块名，必须再用
# collect_all 把 .pyd/.dll 与数据文件作为 datas/binaries 显式打包到 _internal/。
# collect_all 返回的 (datas, binaries, hiddenimports) 必须作为 Analysis 的对应参数传入，
# 由 Analysis 规范化（2元组补 typecode、展开目录条目）——切勿在 Analysis 之后用
# a.datas += 追加，那会绕过规范化，导致 COLLECT 的 normalize_toc 报
# "expected 3, got 2" 或 dist-info 目录 "is not a valid file"。
_extra_datas: list = []
_extra_binaries: list = []
_extra_hidden: list = []
for _pkg in ["aiosqlite", "greenlet", "cryptography", "pydantic_core", "lxml"]:
    _d, _b, _h = collect_all(_pkg)
    _extra_datas += _d
    _extra_binaries += _b
    _extra_hidden += _h

a = Analysis(
    ["run_pyi.py"],
    pathex=["."],
    binaries=_extra_binaries,
    datas=_extra_datas,
    hiddenimports=[
        "app",
        "app.main",
    ]
    + collect_submodules("app")
    + collect_submodules("uvicorn")
    + collect_submodules("pydantic")
    + collect_submodules("pydantic_core")
    + collect_submodules("pydantic_settings")
    + collect_submodules("fastapi")
    + collect_submodules("starlette")
    + _extra_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "pytest",
        "ruff",
        "tests",
        "tkinter",
        "unittest",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # Windows: windowed 模式不弹黑窗；macOS: True 产出普通可执行文件（非 .app）。
    console=(sys.platform == 'darwin'),
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="backend",
)
