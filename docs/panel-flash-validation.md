# 0.6.5 展开闪烁修复

0.6.7 更新：下述不透明窗口与 setShape 的方案已被透明表面常驻、透明度切换替代，以恢复真正透出桌面的圆角，同时避免每次原生 show/hide 的闪烁。当前行为和像素验证见 `panel-rounded-surface-validation.md`；本文保留历史诊断证据。

2026-10-25，用户报告每次展开列表均闪烁一下。

## 复现与原因

新增显式诊断 `STOCK_BAR_PANEL_FLASH_CHECK=1`，配合既有原生面板检查运行。使用本地行情夹具与独立配置，在面板后放置诊断背景；通过 Electron 桌面捕获连续采样，仅保留面板区域裁图和时间序列，不保存周围桌面。每次收起后等待 550ms，再展开并采样 650ms，共 8 次。

0.6.4 同一回路稳定失败：8 次中 3 次画面先完整显示，再短暂透出背景；采样期间没有意外 hide 或 resize 事件。删除重复 focus、改用 showInactive、单独关闭 DWM 过渡效果均未消除问题。仅把透明原生窗口换为不透明窗口后，8 次均无画面中断，表明本环境中闪烁来自透明窗口的显示合成路径。证据位于 `artifacts/panel-flash-minimal/` 和 `artifacts/panel-flash-opaque-probe/`。

## 修复

面板使用不透明 `#101824` 原生背景，继续关闭原生边框。采用 [Electron setShape](https://www.electronjs.org/docs/latest/api/base-window#winsetshaperects-windows-linux-experimental) 设置圆角区域，在尺寸变化时更新；单纯移动或行情更新不重复设置区域。CSS 圆角与原有外观保留，四角由原生区域裁切，不需要透明窗口合成。

继续支持按钮切换与获得焦点时 Esc 收起，点击外部保持展开。两处行情悬浮详情框仍不提供。DWM 探针及其可执行文件已删除，产品不修改系统动画偏好，也不依赖该探针。

## 验证

`artifacts/panel-flash-fixed/` 的 8 次连续采样均为零中断，每次约 28–35 帧。真实 HWND 区域检查确认四角不在绘制区域内、中部在区域内；渲染内容中部 alpha 为 255。旧的原始页面截图四角 alpha 断言改为实际 HWND 区域断言，因为现在圆角发生在原生绘制区域，页面截图不包含该裁切。

便携程序使用同一回路验证，证据为 `artifacts/panel-flash-packaged/`。默认回归不自动开启桌面捕获；显式诊断结束后停止视频轨道、移除捕获 handler 并销毁诊断背景窗。物理多屏、其他真实缩放及其他机器上的合成路径仍需实机验证。`setShape` 在 Electron 文档中标记为 Experimental，本应用固定 Electron 45.0.0 并在当前 Windows 环境验收。

0.6.5 构建与 59 项常规测试通过（5 项原生测试默认跳过）；便携 EXE 的 105 项原生断言通过，包含 8 次展开连续采样，每次 22–29 帧，均为零中断。几何测试还覆盖极小区域的中部可见性，避免圆角裁切把极窄面板全部裁掉。
