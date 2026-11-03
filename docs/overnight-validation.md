# 美股夜盘行情

版本：0.8.0。实施及验证日期：2026-11-01，Asia/Shanghai。

## 行为与边界

美股夜盘独立显示“夜盘”标签、最新成交价格、源时间及涨跌幅。涨跌基准为该轮夜盘开始前最近一个交易日的常规收盘价；午夜不更换基准。进入夜盘但没有有效成交时显示“待夜盘行情”，保留上一时段的完整报价；基准未知时涨跌幅显示 `—`。进入盘前、常规或盘后时，新时段有效报价到达后才同时切换价格和涨跌幅。

富途规定夜盘为美东周日至周四 20:00 至次日 04:00，并属于次日交易日。实现按美东当地日期分组：20:00 后向前推进一个日历日，与次日凌晨共享夜盘日期；使用市场源状态确认是否开放，不以本机时钟推断周末或假日开市。日期运算与报价时间使用 America/New_York，兼容冬夏令时。

云端使用带 `time` 和 `period_type=OVERNIGHT` 的逐笔 REST，接入已有 `TICKER` 推送；按该时段响应的 `last_close` 绑定基准。明确标记时段的成交按源标签处理；未带标签的推送需同时符合源市场状态和 20:00～04:00 的时间范围。过期夜盘、未来时间、证券或时段不匹配的数据不采用。旧 REST 可补充本轮基准，不覆盖较新的推送价格，也不复用前一轮夜盘的基准。

OpenD 夜盘逐笔使用 `Session.ALL=3`，按成交源时间筛选夜盘数据。富途的[行情订阅接口](https://openapi.futunn.com/futu-api-doc/quote/sub.html)不接受 `Session.OVERNIGHT=4`。从盘前/盘后的 `Session.ETH=2` 切换时先取消旧逐笔订阅，避免一直保留不包含夜盘的 ETH 订阅。缺权限时保留本次运行旧价，下一轮重试。

## 真实 SOXL 响应

使用正式应用的 Windows 加密登录环境读取官方接口，未修改自选，输出不含凭证或账户标识。证据为 `artifacts/us-sessions/live-soxl.json`，复现脚本为 `scripts/check-us-sessions.cjs`（使用 Electron 主进程执行）。

| 项目 | 结果 |
| --- | --- |
| 请求 | `/api/v1.0/quote/US.SOXL/rt-ticker?num=100&period=OVERNIGHT` |
| 实际时段 | OVERNIGHT |
| 最近夜盘成交价 | 85.78 |
| 源时间 | 2026-10-30 03:59:53.916 America/New_York |
| 本轮基准 | 102.39 |
| 生产解析回放 | 夜盘，85.78，-16.222287332747342%，界面格式化为 -16.22% |
| 当前周末实际服务 | 保留较新的盘后 78.0012 / 77.05 = +1.23%，不被更早的夜盘替换 |

上述是实际返回的历史夜盘响应及生产解析回放。本次为周末，尚未实测活跃夜盘的连续推送、真实跨午夜及夜盘至盘前切换，不能将其标为实盘验收完成。OpenD 夜盘通过 SDK 协议夹具验证，未声称已通过真实 OpenD 夜盘验证。

## 自动验证

- 85 项自动回归通过，5 项原生专项默认跳过；新增覆盖跨午夜、冬夏令时与周日开盘、错误夜盘/时段、基准隔离、REST/推送竞争、云端重连、夜盘结束启动恢复及 OpenD 订阅切换。
- TypeScript、Vite 和原生组件构建通过。
- 开发版原生云端专项 22 项检查通过，包含正式 IPC 添加 SOXL、夜盘价格及基准、React 横条“夜盘 / +3.00%”渲染；证据 `artifacts/cloud-desktop/result.json`、`cloud-overnight.png`。使用隔离配置及合成协议，不能代替实盘。
- 0.8.0 便携程序的同一原生云端专项 22 项检查通过，包含夜盘界面与数据模型检查；最终 ZIP 的版本、必需文件及 SHA-256 在交付前核对。

官方依据：[夜盘时段及交易日](https://www.futuhk.com/cn/support/topic2_707)、[逐笔成交](https://open.futunn.com/api/quote/realtime/rt-ticker)、[时段及市场状态枚举](https://open.futunn.com/zh-cn/api/quote/naming-dictionary)、[推送数据格式](https://open.futunn.com/zh-cn/api/quote/push/data-format)。
