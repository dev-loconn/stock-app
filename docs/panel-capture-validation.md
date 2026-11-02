# 0.6.1 面板边框与截图失焦修正

0.6.5 更新：0.6.2 的透明窗口圆角方案已被不透明窗口与原生圆角区域替代，解决每次展开时的合成闪烁；当前依据实际 HWND 区域检查圆角。以下 0.6.1–0.6.2 内容保留为历史记录，详见 `panel-flash-validation.md`。

2026-10-25，用户报告：展开面板有一圈边框；微信 / QQ 截图后面板变白，再点展开按钮会恢复。

## 确认与修正

- 列表展开时调用 `focus()`，触发 `.overview-table-scroll:focus-visible` 的蓝色轮廓。现在只重置滚动位置，不主动聚焦列表；保留 Tab 导航与键盘焦点样式。Esc 仍由原生窗口处理。
- 原生面板虽设置 `frame: false`，Windows HWND 仍保留 `WS_CAPTION`。新增只读原生样式检查捕捉到该问题，修复前 `caption=true`、`thickFrame=false`，检查失败；设置 `thickFrame: false` 后两项均为 false，同一检查通过。
- 禁用这个瞬时面板的原生装饰及显示/隐藏动画，避免截图浮层切换焦点时走带原生装饰的过渡路径；`hasShadow` 同步明确为 false。[Electron 官方选项说明](https://www.electronjs.org/docs/latest/api/base-window)说明 `thickFrame: false` 会移除原生阴影和窗口动画。

## 验证范围

原生集成检查使用独立配置与本地协议夹具，覆盖正式 preload、IPC、React 和 Windows 窗口。新增检查读取实际 HWND 样式、验证展开不会自动聚焦列表，并连续 20 次让另一个原生窗口获得焦点，等待面板收起后再展开，检查深色画面像素、列表行数及渲染进程存活。

开发版原生结果位于 `artifacts/panel-capture-final/`；便携版位于 `artifacts/panel-capture-packaged/`。每次循环都应完成失焦收起与重开，重开后近白像素占比小于 5%，渲染进程无退出。此项能捕获重开后的空白页面，不能证明隐藏窗口没有桌面合成残影。

当前环境尝试 Ctrl+Alt+A 未观察到微信截图浮层，未完成实际微信 / QQ 截图快捷键的端到端复现，不能宣称该触发下的白屏已确认消除。白屏按原生窗口失焦过渡路径做了针对性处理，其最终效果仍需用户同一截图工具复测。多屏、其他缩放和其他截图软件也未由这轮测试覆盖。

原生样式读取脚本只读窗口样式，不改变系统设置、不安装输入钩子；未新增全局截图快捷键。

## 最终结果

- 0.6.1 TypeScript、Vite 与原生检测器构建通过。
- Node.js 24.19.0 下常规测试 58 项通过，5 项需显式开启的原生测试跳过。首次在受限环境运行因临时目录写入和本地回环连接被拒绝而失败，正常权限重跑通过。
- 开发版与 0.6.1 便携 EXE 各通过 79 项原生断言，均包括 20 次失焦重开及画面检查。便携版原生样式为 `caption=false`、`thickFrame=false`，`panel.png` 已人工查看，没有展开时自动出现的蓝色列表焦点框。
- 测试环境偶尔报告基线横条 `alwaysOnTop=false`，继续按已有验收方式记录限制，没有将该项记为通过。其余多屏和实盘边界沿用原验证文档。

## 0.6.2 圆角修正

用户在直接运行 0.6.1 后发现圆角消失。关闭原生装饰后，原生窗口不再裁切圆角；页面虽有 `border-radius: 8px`，其外侧仍被 HTML 与窗口的不透明背景填满。

保留 `thickFrame: false`，使用透明原生窗口并仅对 overview 页清除 HTML/body 背景；列表本身仍使用不透明 `#101824` 背景。圆角由现有 CSS 绘制，不恢复原生边框或动画。这符合 [Electron 透明窗口与 CSS 外形示例](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles)。

新增原生截图像素断言：四个最外角 alpha 小于 5，中部内容 alpha 为 255。0.6.1 在四角检查上失败；修复后四角、中部、原生样式及既有 20 次失焦重开检查均通过。开发版证据为 `artifacts/panel-corners-fixed/`，便携版为 `artifacts/panel-corners-packaged/`。截图工具白屏的端到端验证边界仍保留。
