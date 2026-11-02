# 富途云端 API 文档核验

核验日期：2026-10-24，Asia/Shanghai。范围：保留 Windows Electron 悬浮条，通过官方网页登录授权，免装本机 OpenD。本文只记录官方文档事实及据此作出的工程判断；真实接口与账户验证结果应另行记录。

## 结论与边界

官方已有面向桌面应用的 OAuth 2.1 + PKCE、云端 REST 和行情 WebSocket 文档。从接口设计看，可实现“桌面程序 → 官方网页授权 → 直接连接云端行情”，不需要在此链路中启动 OpenD。这是文档支持的技术路线，不能据此宣称本机网络、当前账户、实时行情权限或公开分发条件均已验证通过。[快速开始](https://open.futunn.com/api/overview/getting-started)

## 授权流程

官方为 Public Client 提供 `POST https://webapi.futunn.com/oauth2/register`：注册 `redirect_uris`、`token_endpoint_auth_method: "none"`，使用 authorization_code / refresh_token，取得 client_id。示例回调为 `http://localhost:60355/callback`。

程序生成随机 state、code_verifier，计算 S256 code_challenge；打开 `https://webapi.futunn.com/oauth2/authorize/confirm`。用户在官方页面登录并选择权限，回调地址须与注册值完全一致；程序核对 state，再向 `/oauth2/token` 交换令牌。授权码有效 5 分钟且只可成功使用一次；令牌响应包含实际 scope 和 expires_in。文档明确此流程适用于桌面应用，无需客户端保存 API 私钥。[快速开始](https://open.futunn.com/api/overview/getting-started)

本悬浮条只需行情读取，应以最终授权结果中的 `quote:read` 为准，不要求 trade:read、trade:write、quote:write 或账户权限。官方 FAQ 将 quote:read 定义为实时行情/K 线读取；用户可以独立选择权限并在 Dashboard 撤销令牌。该 FAQ 属于 MCP 文档，只用于解释 scope，不把 MCP 的会话规则直接套用到行情 WebSocket。[官方权限 FAQ](https://open.futunn.com/mcp-docs/faq)

## 实时行情链路

连接 `wss://webapi-quote.futunn.com/ws` 后，先发鉴权帧：

```json
{"action":"auth","data":{"auth_type":"oauth2","authorization":"Bearer ACCESS_TOKEN"}}
```

成功响应带 session_id / server_time，随后才能订阅。凭证有效不代表行情订阅成功；市场、品类、档位、额度、代码有效性均会影响结果。不要将内部路由字段当作客户端参数。令牌须放在系统钥匙串或加密存储，不能进入公开配置或日志。[行情鉴权](https://open.futunn.com/api/quote/push/auth)

订阅示例：

```json
{"id":"cloud-probe-quotes","action":"subscribe","quote":["US.AAPL","HK.00700"]}
```

取消时发送 action=unsubscribe 及对应类型/代码。可订阅 quote、order_book、ticker、kline。订阅成功后，同一连接按行情变化推送；应分别记录订阅响应和收到的实际行情。[订阅与取消](https://open.futunn.com/api/quote/push/subscribe)

WS 以 type / symbol / data 区分消息。QUOTE 包含 last_price、prev_close_price 和源时间 data_time_ms，并列出可选的 pre_market、after_market、overnight 子对象；字段可能缺失、为 0 或空值，需按实际市场和时段判定。首次收到一帧报价不能证明观察到了持续实时变化。[推送格式](https://open.futunn.com/api/quote/push/data-format)

REST `POST /api/v1.0/quote/stock-quote`，请求 `{"code_list":["US.AAPL","HK.00700"]}`，结果为 data.quote_list；其源时间字段为 data_time。文档列出 US 股票/ETF 和 HK 股票/ETF 等支持范围，以及盘前、盘后、夜盘子对象的 price、change_val、change_rate 等字段；非对应时段可能为 0。需实测扩展时段数据及涨跌基准，不能机械以 0 当有效价格。[基本报价](https://open.futunn.com/api/quote/realtime/stock-quote)

## 限额与尚未明确的条件

云端 REST 文档目前规定同 IP WebAPI 请求不超过每分钟 100 次，建议批量、缓存静态资料与指数退避。本悬浮条可优先订阅推送，REST 用于初始补齐及恢复补齐，避免逐只高频轮询。[REST 限流](https://open.futunn.com/api/overview/rate-limit)

公开鉴权文档确认存在行情档位及订阅额度限制，但本次无法读取链接指向的 WS 专用额度页面，因此没有确认具体数值。传统 OpenD 文档的 100/300 等额度不能直接作为云端账户的承诺。MCP FAQ 也提示部分能力会受账户或地区限制；尚未找到云端普通行情 API 完整地区准入表，不推定中国内地或任何具体账户一定可用。[行情权限条件](https://open.futunn.com/api/quote/push/auth)、[账户或地区提示](https://open.futunn.com/mcp-docs/faq)

文档公开提供注册流程，但本次文档核验没有确认是否所有用户均可成功注册、是否存在额外生产准入或公开分发审核。以上须以真实注册、用户官方授权及接口返回进一步验证。

## 长连接文档差异

鉴权页要求连接至少每 10 分钟发送 refresh 帧，建议每 5 分钟；该页还建议令牌过期后刷新并重新建连。[行情鉴权](https://open.futunn.com/api/quote/push/auth)

Keep-Alive 页则强调协议层 ping/pong、没有自定义 JSON heartbeat；其令牌更新步骤建议在同一连接再次发送 auth。该页未解释上述 refresh 帧格式。二者不完全一致，不能仅凭阅读宣称长连接生命周期已经实现可靠；正式迁移前应核实具体 refresh 协议、长连超过 10 分钟、令牌刷新及断线重订阅行为。[连接保活](https://open.futunn.com/api/quote/push/heartbeat)

## 工程验证的通过标准

1. 本机无需依赖 OpenD 的连接，即能完成 client 注册、官方授权、合法回调和仅行情读取 scope。
2. REST 返回所请求的真实 US/HK 样本，WS 鉴权及订阅分别成功；记录源时间、推送类型、权限和错误，不能用示例数据替代。
3. 观察持续行情变化；跨扩展时段核实盘前/盘后价格与涨跌基准。休市时没有新推送不能单独认定接口失败。
4. 验证令牌刷新、长连接维护、断网恢复与重订阅后，才考虑将云端连接作为产品选项。

上述为工程验收建议，不表示已执行或已通过。本文不包含凭证、授权码、用户资料或账户数据。
