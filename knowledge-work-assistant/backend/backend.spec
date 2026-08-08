# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec：打包对话回声后端为 onedir。

产物 ``backend/dist/backend/``（含 ``backend.exe`` + ``_internal/``），由
electron-builder extraResources 带入安装包，launcher.ts 探测 ``backend.exe`` 启动。

设计要点：
- onedir（非 onefile）：启动快，适合常驻服务，避免每次启动解压临时目录。
- 入口 run_pyi.py：直接传 app 对象给 uvicorn.run，避免字符串导入在 frozen 环境失败。
- hiddenimports：app 包 + uvicorn/pydantic/fastapi/starlette 子模块（动态导入）。
- aiosqlite/greenlet：sqlalchemy 通过 import_dbapi 动态加载，collect_submodules
  仅加模块名不足以让 PyInstaller 把文件打包进 PYZ；改用 collect_all 把 .py 文件
  作为 datas 显式打包到 _internal/，runtime 可直接定位。
  PyInstaller 6.22 的 collect_all 返回 2 元组 (src, dest)，需转 3 元组 (dest, src, typecode)
  以匹配 COLLECT 的 normalize_toc 期望。
- excludes：剔除测试/dev 依赖与无关标准库，减小体积。
- console=False：windowed 模式，不弹控制台黑窗；launcher 以 stdio pipe 捕获日志。
"""
from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None

a = Analysis(
    ["run_pyi.py"],
    pathex=["."],
    binaries=[],
    datas=[],
    hiddenimports=[
        "app",
        "app.main",
    ]
    + collect_submodules("app")
    + collect_submodules("uvicorn")
    + collect_submodules("pydantic")
    + collect_submodules("pydantic_core")
    + collect_submodules("fastapi")
    + collect_submodules("starlette"),
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

# aiosqlite / greenlet：sqlalchemy 动态导入（import_dbapi），必须作为 datas 显式打包。
# collect_all 在 PyInstaller 6.22 返回 2 元组 (src, dest)，转 3 元组 (dest, src, typecode)。
for _pkg in ["aiosqlite", "greenlet"]:
    _datas, _binaries, _hidden = collect_all(_pkg)
    a.datas += [(_dest, _src, "DATA") for _src, _dest in _datas]
    a.binaries += [(_dest, _src, "BINARY") for _src, _dest in _binaries]
    a.hiddenimports += _hidden

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
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
    upx=True,
    upx_exclude=[],
    name="backend",
)
