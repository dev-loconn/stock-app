# 美股盘前盘后价格与涨跌幅修复

版本：0.7.2。验证日期：2026-11-01，Asia/Shanghai。

## 原因与修复

旧云端实现要求 `pre_market` / `after_market` 自带独立源时间，但真实 QUOTE/stock-quote 中这两个对象只有价格及涨跌数据。没有接入云端逐笔时，美股会一直保留常规报价及其涨跌幅；已有测试人为提供了扩展字段时间戳，未覆盖真实响应。

使用官方 `GET /api/v1.0/quote/{symbol}/rt-ticker?num=100&period=BEFORE|AFTER` 补回带 `time`、`period_type` 的实际成交。扩展时段单独订阅 WebSocket `ticker`，解析批量 `TICKER` 的 `time_ms`；切换时段自动调整订阅，断线重订阅。扩展权限失败保留基础行情，下一轮重试，不中断其他证券。

涨跌幅按 `(price / baseline - 1) * 100` 计算。按时段筛选的逐笔响应 `last_close` 与其报价绑定：盘前使用上一交易日常规收盘价，盘后使用当日常规收盘价。真实 SOXL 响应分别为 102.39、77.05，已与常规报价交叉核对。基准缺失显示未知；旧 REST 回复可补基准，但不能盖掉更新的推送价格。日期、证券、时段或未来时间不匹配的数据不采用。

显式 `period_type` 优先于硬编码时钟边界：真实 SOXL 最后一笔 BEFORE 的记录时间为美东 09:30:01.076，属于晚报的盘前成交。未带时段标签的推送继续使用市场状态及时间范围校验。

## 真实 SOXL 核对

通过正式应用的 Windows 加密登录环境只读取得数据，不修改自选。证据：`artifacts/us-sessions/live-soxl.json`；复现脚本：`scripts/check-us-sessions.cjs`，由 Electron 主进程执行。输出只含证券、价格、时间、时段及状态，不含凭证或账户标识。

| 数据 | 取值 |
| --- | --- |
| 常规报价日期 | 2026-10-30（America/New_York） |
| 常规收盘价 / 前一交易日收盘价 | 77.05 / 102.39 |
| 市场当前状态 | AFTER_HOURS_END |
| 最近盘后逐笔价 | 78.0012 |
| 盘后逐笔源时间 | 2026-10-30 19:59:59.876 America/New_York |
| 修复后实际服务选取 | 盘后，78.0012，基准 77.05 |
| 计算结果 | +1.234523036988966%，界面格式化为 +1.23% |

同一响应的无独立时间戳 `after_market.price` 为 78.0099、自带涨幅 1.245%；它与最近逐笔并非同一数值。本实现展示可验证源时间的最近逐笔，不把基础报价对象的时间冒充扩展价格时间，也不将两个报价的价格和涨幅混用。

## 验证范围

- 自动测试 75 项通过，5 项原生专项默认跳过；新增 9 项覆盖真实 SOXL 周末回放、盘前晚报、正确基准、推送、重连、旧数据、同毫秒成交、缺基准及权限失败恢复。
- TypeScript、Vite 及原生组件构建通过；开发版及 0.7.2 便携程序的原生云端专项各 19 项检查通过，使用隔离配置与协议夹具。
- 真实账号 REST 和修复后的实际 CloudQuoteService 已返回上述盘后数据；本次是周末，不能据此宣称活跃盘前/盘后的连续推送及实际跨时段切换已经实盘通过。

官方接口：[实时报价](https://open.futunn.com/api/quote/realtime/stock-quote)、[逐笔成交](https://open.futunn.com/api/quote/realtime/rt-ticker)、[推送数据格式](https://open.futunn.com/zh-cn/api/quote/push/data-format)、[订阅与取消订阅](https://open.futunn.com/api/quote/push/subscribe)。
