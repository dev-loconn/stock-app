# 0.2.0 全屏隐藏与 Windows x64 ZIP 验证

验证日期：2026-10-24，Asia/Shanghai。此版本在真实行情悬浮条基础上新增原生全屏检测和便携打包。

## 实现

原生 x64 辅助进程使用 Win32 枚举可见窗口，排除本程序、工具窗口、桌面、任务栏、最小化及 DWM 隐藏窗口。按显示器检查最上层正常窗口是否无标题栏且覆盖整个显示器，并排除普通最大化。使用每显示器 DPI 感知及物理坐标，避免混合 Electron 逻辑坐标和 Win32 坐标。它不读取窗口标题、内容或键盘。

每 400ms 检查一次，主进程将全屏隐藏与手动隐藏分开管理；只有两者均解除才使用 showInactive 恢复。启动先等待检测以减少闪现。行情服务继续运行，隐藏不触发取消订阅。检测器失效时解除自动隐藏并定期重启，手动隐藏仍优先。无需运行时 PowerShell 或原生 Node 扩展。

实现依据：[微软多显示器窗口定位](https://learn.microsoft.com/en-us/windows/win32/gdi/positioning-objects-on-multiple-display-monitors)、[窗口 Z 顺序](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features)、[DWM 边界与隐藏属性](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute)。

## 检查记录

- 27 项自动测试通过，含新增的跨显示器判断、移动到全屏显示器、手动隐藏优先、全屏中恢复、全屏启动和检测失败回退。
- 开发构建及便携程序的原生验收已通过：普通窗口、普通最大化、同屏全屏隐藏、HTML 视频全屏隐藏、退出后无焦点恢复、手动隐藏不被恢复覆盖、全屏中显式恢复继续等待。
- 本机仅有一个物理显示器，Windows 缩放约 183.75%；第二物理显示器和实际游戏的独占全屏模式仍待环境验证。跨显示器路由有固定样本验证，不能代替物理多屏通过。
- 00:18 左右，便携程序从含中文和空格的目录启动，自动恢复当前 4 只自选、700 宽度及受保护密钥，连接本机 OpenD 并重新获取真实行情。全屏隐藏时，SOXL 推送计数从 9 增至 10、AAPL 从 7 增至 8，确认隐藏不停止订阅。退出原生全屏及视频全屏后均恢复。
- 本地证据：artifacts/fullscreen-dev/fullscreen-check.json 和 artifacts/fullscreen-packaged-live/fullscreen-check.json。测试使用独立窗口与独立测试配置；带 live 参数的检查只读取真实配置和保护密钥，不修改自选/外观/位置，不导出密钥。
- 最终 ZIP 的 SHA-256 由打包脚本生成在同名 .sha256，最终解压复核另存 artifacts/zip-validation.json；原始日志/用户配置不放入 ZIP。

## 打包与限制

ZIP 包含 Windows x64 Electron、编译后界面/主进程、锁定的生产依赖及许可证、原生检测器、使用说明和验收记录。配置和加密密钥不打入包。外部 OpenD 独立安装登录；用户设置继续保存在 stock-bar 用户目录。

普通和无边框全屏已设计覆盖；非标准游戏覆盖层、受保护窗口和独占模式需实际程序验证。切回位于全屏窗口上方的正常应用后，按最上层窗口状态恢复。检测不使用窗口名称匹配或应用名单。
