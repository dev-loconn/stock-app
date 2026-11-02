# 盘前涨幅与夜盘旧价修复（0.11.2）

验证日期：2026-11-02，Asia/Shanghai。

## 原因与修复

1. 实际 QUOTE 推送包含扩展时段独立的 `data_time_ms`。它更新盘前价格时，原 `applyTrades` 丢掉了逐笔 REST 已确认的本轮基准；随后使用常规报价的 `prev_close_price`。2026-11-02 盘前，SOXL 的常规报价仍属于 10 月 30 日：`last_price=77.05`，`prev_close_price=102.39`。截图价格 80.68 因此被算成 -21.20%，正确基准 77.05 对应 +4.71%。现在同轮 QUOTE/TICKER 共享已确认基准；尚无逐笔基准时，按常规报价所属日期选择收盘价。
2. 服务原来按常规报价的时间丢弃整个较旧 QUOTE 包，即使同包夜盘字段带有更新的独立源时间，也不采用。通过本地 WebSocket 重现了“夜盘停留在 80、新推送 80.91 不显示”。现在常规、盘前、盘后、夜盘分别比较源时间；旧常规时间不拦截新夜盘，旧扩展字段也不能因常规时间较新而回退价格。
3. 实际推送批次为新成交在前，同一毫秒可有多笔成交。无时段标签的批次原来会让后续同毫秒记录覆盖第一条；现在同一批次保留第一条，与逐笔 REST 的处理一致。

修复保留未知基准、错误时段/日期过滤、跨午夜分组、旧回复只补基准而不盖掉新价的规则。没有有效新报价时仍保留上一时段完整报价。

## 复现与回归

最小涨幅复现：`node node_modules/vitest/vitest.mjs run tests/cloud-market.test.ts -t "keeps the current pre-market close"`。修复前明确得到基准 102.39，期望 77.05；修复后通过。

新增回归覆盖同轮 QUOTE/TICKER 交替、首个盘前 QUOTE、三个扩展时段基准、夜盘同毫秒成交、常规与夜盘独立时间、较旧扩展内容不回退价格，以及没有推送时继续用 REST 更新夜盘。`tests/market.test.ts` 的盘前夹具同时改为明确区分最近常规收盘价与其上一交易日收盘价。

Node 24.22.0（项目 Electron 的 Node 运行模式）完整自动回归：107 项通过，6 项原生专项默认跳过；TypeScript、Vite、Windows 原生组件构建通过。

另行执行开发版及 0.11.2 便携程序的原生云端专项，各 22 项检查通过，包含独立配置中的正式 IPC、React 夜盘标签、价格和涨跌幅渲染。结果：`artifacts/cloud-desktop/result.json`。该专项使用合成协议，不替代活跃夜盘实盘验证。

## 实际行情证据

运行中的 0.11.1 经 `--capture` 确认 SOXL 盘前使用错误基准 102.39。真实接口、推送和生产服务的脱敏记录：

- `artifacts/us-sessions/live-soxl-2026-11-02-before.json`：当前 REST 报价及逐笔基准。
- `artifacts/us-sessions/live-soxl-2026-11-02-pushes-before.json`：修复前收到真实 QUOTE/TICKER 后，基准被覆盖为 102.39。
- `artifacts/us-sessions/live-soxl.json`：修复后实际生产服务，观察 15 秒，25 条白名单行情帧、28 个盘前样本，基准全部保持 77.05，价格持续变化，最后样本 80.7854 / +4.848020765736538%。

只读检查脚本：Electron 主进程执行 `scripts/check-us-sessions.cjs --observe-ms=15000`。仅记录白名单行情字段，不输出凭证或账户标识，不修改自选。

当前已进入盘前，夜盘响应只能作历史回放：本轮最新成交 80.91，源时间 `2026-11-02T08:59:57.978Z`，基准 77.05，+5.009733939%。夜盘旧价的代码路径已通过协议回归；尚未捕获用户当时卡价的原始包，实际活跃夜盘连续更新仍需下一轮实盘确认，不能将回放当作该项验收。

官方字段依据：[QUOTE/TICKER 推送格式](https://open.futunn.com/zh-cn/api/quote/push/data-format)、[常规与扩展报价字段](https://open.futunn.com/api/quote/realtime/stock-quote)、[订阅及重连规则](https://open.futunn.com/zh-cn/api/quote/push/subscribe)。
