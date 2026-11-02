---
status: accepted
---

# 使用 Windows 原生注册保证热键长按不重复

已确认的交互要求四项快捷键均在按住主键时仅执行一次，保持修饰键按住、松开主键再按可以再次执行。Electron 全局快捷键回调不提供释放或重复标记，而 Windows 的 RegisterHotKey 与 MOD_NOREPEAT 有对应的明确语义，因此新增独立原生辅助进程承担注册和热键消息处理，Electron 主进程只分派已授权的窗口操作；同一组合只有一个注册所有者。

相比直接复用 Electron globalShortcut，此方案增加辅助进程及健康状态管理，但避免用固定节流或轮询释放来近似已确认的按键语义，可复用项目现有 Windows 原生产物的编译与打包方式。仅在前台设置窗口主动录入组合时临时使用键盘钩子，以正确捕获已注册组合；普通运行不使用该钩子。排除 F12 的修正随[完整设计](../global-shortcuts-design.md)于 2026-11-01 获最终确认，0.9.0 实现。依据为 [Microsoft RegisterHotKey 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey)与 [Electron globalShortcut 文档](https://www.electronjs.org/docs/latest/api/global-shortcut)。
