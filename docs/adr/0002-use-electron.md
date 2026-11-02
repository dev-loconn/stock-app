# 使用 Electron、React、TypeScript 与 Vite

第一版 Windows 11 行情悬浮条采用 Electron + React + TypeScript + Vite，已由用户在 Q23 与 Q23a 确认。该选择遵循用户对 Electron 技术栈的要求，以 Web 技术实现行情界面，并使用 Electron 承担桌面窗口和生命周期能力。

交付包含 Electron 运行时，包体积及常驻资源占用在实现阶段实测；当前不承诺具体资源指标。已验证 futu-api 10.11.7108 可在 Electron 45.0.0 主进程运行并接收本机 OpenD 持续推送；React 通过隔离 preload 的限定接口获取行情。0.2.0 便携发布程序已在含中文和空格的目录通过真实接入及原生全屏验收。
