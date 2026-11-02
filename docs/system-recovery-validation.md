# 真实系统恢复验收：主机断网、OpenD 重启、整机休眠

验证日期：2026-10-24，Asia/Shanghai。Windows 11 企业版 10.0.26200 x64，单物理显示器、缩放约 183.75%；Electron 45.0.0、futu-api 10.11.7108；OpenD 返回 serverVer=1011、serverBuildNo=7108。业务恢复代码为 0.2.1，额外启用只读诊断入口；0.2.2 收录本轮脚本、记录及诊断入口，没有修改行情恢复算法。

本轮三项均进行了实际系统操作，不使用 TCP 故障代理或手动发出 Electron 电源事件。共同结果：旧价及源时间保留，异常期间连接状态正确，恢复后重新收到全部 4 只自选数据、恢复 4 个基础订阅，可见页价格与服务状态一致。自选为 US.SOXL、US.AAPL、US.SPY、HK.00700；周六取得源端最后支持时段报价，不宣称产生新成交。

## 结果

| 实测 | 实际操作与系统证据 | 恢复结果 |
| --- | --- | --- |
| OpenD 重启 | 21:27:52 起停止 Futu_OpenD 与 FTWebSocket；按原启动参数恢复。PID 从 28580/38448 变为 12776/33336 | 断开时为 retrying，旧价和源时间保留；从开始恢复进程到全部订阅恢复约 14.88 秒，21:28:12.432 已恢复全部数据 |
| 主机断网 | 21:28:48.065 实际禁用唯一活动 WLAN（接口 15），Status=Disabled、AdminStatus=2；21:29:00.831 开始重新启用 | net.isOnline=false，程序为 retrying；从开始重新启用网卡到连接及全部订阅恢复约 15.26 秒，21:29:16.091 恢复；结束后 WLAN 为 Up |
| 整机实际睡眠/休眠 | 21:31:06.266 调用 SetSuspendState，21:31:40.547 返回，约 34.28 秒；Windows Kernel-Power 42/107 与 Power-Troubleshooter 1 记录真实进入/恢复，Electron 收到原生 suspend/resume | 休眠时 disconnected、旧价和源时间保留；从原生 resume 到全部订阅恢复约 5.30 秒，21:31:45.868 恢复全部数据；应用进程 34472 未重启 |

恢复时间来自 500ms 采样的应用状态，包含主机网络、OpenD 就绪及配置的重试间隔，不是行情内部渲染延迟。恢复后每只证券的 receivedAt 都晚于该场景的恢复参考时刻，证明重新接收数据，而非只看到保留旧价。屏幕可见页也核验了“已连接”和价格；其他自选通过服务数据及订阅状态核验。

## 实际电源状态与唤醒来源

请求的是睡眠路径（Hibernate=false），系统日志 TargetState=4、EffectiveState=5。按 Windows 的 [SYSTEM_POWER_STATE 枚举](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-system_power_state)，4 为 S3、5 为休眠。因此本轮记录为“当前系统策略下的实际睡眠/有效休眠路径恢复通过”，不宣称强制纯 S3 已单独通过。没有为取得某种状态修改用户的混合睡眠或电源策略。

Kernel-Power 42 的 RecordId=128844，107 的 RecordId=128850；Power-Troubleshooter 1 的 RecordId=128861，SleepTime=13:31:06.270Z、WakeTime=13:31:40.545Z。后者记录的唤醒来源为 Intel USB 3.20 主机控制器。测试前已设置约 45 秒硬件唤醒计时器及 75 秒备份唤醒任务，但本次实际由 USB 来源唤醒，不能据此宣称计时器实际触发唤醒已经验证。

原生 Electron suspend=13:31:06.524Z、resume=13:31:40.566Z；没有调用 powerMonitor.emit。事件日志和应用事件共同证明实际低功耗转换，不能将系统日志部分记录的 TimeCreated 差值直接当作完整睡眠时长。

## 执行与恢复措施

监视器入口为 Electron 的 `--system-recovery-check`，直接连接真实 OpenD，只读加载真实配置和受 Windows 保护的密钥；不保存自选、位置或外观。独立的管理员控制器只允许 Preflight、OpenD、Network、Sleep 四种固定动作，通过 Windows UAC 由用户批准管理员会话。

- 停止 OpenD 前，先只读验证原可执行程序及启动参数能够取得；参数仅在进程内存中保留，不输出或保存账号、密码或连接 key。停止后按原参数恢复父进程及其 WebSocket 服务。
- 禁用 WLAN 前，设置独立恢复进程和定时任务。正常路径会重新启用原网卡；即使控制流程失败，独立看门狗仍会在限定时间重新启用它。
- 休眠前核验交流供电、取得本进程所需的关机权限、创建硬件唤醒计时器及备份任务。临时权限随测试子进程结束消失，不更改系统权限策略。
- 每个动作都有失败状态、超时和 finally 恢复；结束后删除临时唤醒任务，管理员控制器和行情监视器退出。末次预检确认没有残留 StockBarAcceptance-* 任务；网络与 OpenD 均运行正常。

原始股票配置文件修改时间仍为 2026-10-24 00:27:43（本轮之前），未被测试写入。没有新增开机任务或持久网络/电源设置。

本轮未发现新的行情恢复运行故障。修正的是验收工具本身：兼容 OpenD 启动路径的不同表示形式；明确按 UTF-8 读取包含中文的 JSON，避免 Windows PowerShell 5 默认编码破坏内容；用 DateTimeOffset 判断报告新鲜度，避免 UTC/本地时间相减错误。前置检查失败时未停止服务，没有把这些工具错误记成应用恢复失败或通过。

## 可复核证据

目录：`artifacts/system-recovery/20261024-212232/`。

- `summary.json`：三项最终断言、恢复时刻、旧价保留、新接收时间、界面比对及清理结果。
- `OpenD-result.json`、`Network-result.json`、`Sleep-result.json`：每项实际操作与结果；`Preflight-result.json` 含最终唤醒来源和残留任务检查。
- `states.jsonl`：每 500ms 记录的脱敏状态；`monitor-result.json`：连续监视结果与原生电源事件；`frame-*.png`：状态转换时的正式界面截图。
- `Network-process-watchdog.json`：独立网络恢复进程的结束记录。

这些文件不作为跨启动行情缓存，不包含密钥或富途账号参数。当前产品其余未验项目仍以 [完整验收清单](./acceptance.md) 为准，其他硬件、网卡、固件和强制纯 S3 组合不能由本机这一轮推定通过。

## 构建与交付复核

补验完成后，33 项常规自动回归通过（原生恢复集成用例仍需显式启用），TypeScript、Vite 与原生辅助程序构建通过。0.2.2 暂存便携程序的独立配置原生 UI 检查通过：正式悬浮条存在、页面无 require、限定 bridge 可用、置顶且不抢焦点；证据为 `artifacts/system-recovery/release-ui/result.json`。新增 PowerShell 脚本通过语法检查，文档本地链接有效。

交付包为 `release/stock-bar-0.2.2-win32-x64.zip`；大小与 SHA-256 见 `release/latest.json` 和 ZIP 同名 `.sha256`。原始用户配置、密钥、行情诊断及完整系统日志不放入交付包。
