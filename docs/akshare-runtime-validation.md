# 0.6.10 AKShare 便携运行环境修复

2026-10-25，用户报告设置页所有市场持续显示“AKShare 数据源访问失败（undefined）”。

## 原因与修复

旧便携包未复制开发用 `.cache/akshare-venv`，程序退回调用系统 `python`。本机该命令指向不可运行的 Windows 商店别名。空 stderr 被当作 `{}` 解析后，正则将缺失 error 字段强制转为字符串 `undefined`，错误显示又把它附加到提示中。当前便携目录按原路径调用可复现，换用开发环境的真实解释器则成功返回港股目录。

0.6.10 在 `resources/app/runtime/python` 内置独立 Python 3.12.14、AKShare 1.19.3 及项目虚拟环境的依赖和许可文件。构建器复制标准库与专用依赖，使用相对 `_pth` 隔离路径；验证 `sys.flags.isolated` 及全部 `sys.path` 位于该运行环境中。运行时不依赖原机器的 Python、Windows 商店别名或开发路径。

发布包优先使用内置解释器。显式 `STOCK_BAR_PYTHON` 覆盖仍可用；完整包缺少内置解释器时给出重新解压提示，不再退回系统别名。错误解析检查字段类型，区分无法启动/缺依赖、取消和超时，未知 stderr 不原样输出，避免暴露代理地址或凭据。

Python 运行环境构建入口为 `scripts/build-akshare-runtime.py`；只允许重建本项目固定的生成缓存目录，指纹相同时复用，依赖变化时清理旧生成内容。包内不附带开发虚拟环境的绝对路径配置，也不附带用户自选、密钥和目录缓存。

## 当前验证

- TypeScript、Vite 与原生检测器构建通过。
- 常规回归 62 项通过，5 项需显式启用的原生检查默认跳过；Python 归一化测试 3 项通过。
- 空 stderr / 缺失 error 字段在修复前明确失败并产生 `undefined`；修复后不出现虚构错误详情。覆盖内置解释器优先级、显式覆盖、包不完整、取消/超时及错误输出脱敏。
- 便携目录内的隔离 Python 已独立成功导入 AKShare；通过正式 AKShareDirectory 调用返回港股 2,810 条；同一包内解释器成功查询美股 917 页分页信息，验证 requests 和 V8 解析依赖可搬移运行。
- 五市场真实同步全部完成：HK 2,810、US 18,166、SH 2,318、SZ 2,906、BJ 353，合计 26,553。美股同步约 566 秒。验证缓存为 `artifacts/akshare-runtime-fix/live-directory.json`，目录包含公开名称和代码，不含行情价格或账号数据。
- 已通过既有原子保存/合并路径将本次验证目录写入应用的 `security-directory-akshare.json`；腾讯、Apple、gzmt、payh 搜索验证通过。未修改自选、登录、外观或连接设置。
- 正式 EXE 的搜索回归结果为 `artifacts/akshare-runtime-fix/packaged-search/`。目录候选数不等于富途支持或可交易证券数，添加仍需行情服务核验。

新便携包完整解压后无需再安装 Python。首次同步仍可能需要数分钟；已有目录会保留供离线搜索。后续上游或网络故障仍可能影响刷新，失败时保留可用目录，不将本轮成功解释为永久网络可用。
