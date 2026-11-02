# 富途云端 API 真实接入验证

验证日期：2026-10-24（Asia/Shanghai）。目标：保留 Windows 桌面悬浮条，验证能否通过富途官方网页授权后直接读取云端行情，免装 OpenD。

## 结论

本机已完成真实的 OAuth Public Client 注册、用户官方网页登录授权、PKCE 回调及令牌交换、令牌刷新、港美股 REST 报价读取、云端 WebSocket 鉴权和两只证券的报价推送。核心接入路线验证通过，可以继续设计悬浮条的云端连接选项。

本次仅运行独立诊断脚本，没有把悬浮条改为云端版本，也没有修改现有 OpenD 设置。脚本不加载 OpenD 配置或密钥，不调用本地 OpenD API；本机原有 OpenD 进程是否运行，不参与此链路。网络使用现有 HTTPS_PROXY 环境所配置的本机代理，不能把该结果外推为所有用户网络均可直连。

## 实测结果

证据：`artifacts/cloud-api-probe.json`。只保留接口状态、脱敏权限和证券行情字段；令牌、授权码、PKCE verifier、账户标识不保存在证据中。OAuth client_id 是公开客户端标识，单独保存在忽略提交的 `.cache/cloud-oauth-client.local.json`。注册管理令牌被丢弃，访问令牌和刷新令牌只在验证进程内存中使用，进程已退出。

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| 云端时间接口 | HTTP 200 | 返回毫秒时间戳 |
| 未授权 REST 对照 | HTTP 401，-12006 | 无凭证不能读取报价 |
| 无效令牌 WS 对照 | WebSocket 连接成功，鉴权返回 4002 | 网络连通与有效授权分开验证 |
| Public Client 注册 | HTTP 201 | `token_endpoint_auth_method=none`，要求 PKCE；请求 `quote:read`，服务端同时返回账户选择 scope |
| 官方网页登录及回调 | 通过 | 用户自行在官方页面完成；本机校验随机 state，以 S256 PKCE 换取令牌 |
| 令牌交换 | HTTP 200 | 实际 scope 为 `quote:read` 加账户选择范围，无 `trade:read`、`trade:write` 或 `quote:write`；有效期 7200 秒 |
| 授权 REST 报价 | HTTP 200 | 返回腾讯 HK.00700、苹果 US.AAPL 两条实际报价 |
| 刷新令牌 | HTTP 200 | 使用 refresh_token 获得新 access_token，权限保持行情读取 |
| 云端 WS 鉴权 | 通过 | 使用刷新后的令牌连接 `wss://webapi-quote.futunn.com/ws` 并取得鉴权成功响应 |
| 云端 WS 报价 | 已收到 | 发送两只证券订阅后，收到 US.AAPL、HK.00700 各一帧 QUOTE；不能据此宣称持续实时更新已通过 |

REST 样本：HK.00700 最新价 386、昨收 382.4，源时间为北京时间 2026-10-23 16:07:58；US.AAPL 最新价 347.725、昨收 348.22，常规报价源时间为北京时间 2026-10-24 04:00:00。这些是本次接口返回的历史报价，不代表文档阅读时的当前价格。苹果另返回盘前 349.7、盘后 347.61、夜盘 345.91；WS 的扩展时段子对象带各自源时间。未实测跨时段切换和涨跌基准，不把这些字段直接作为完整产品实现。

## 实际协议差异与脚本修正

首轮已认证 WS 收到鉴权成功及两条 QUOTE，但没有被脚本识别为与请求 id 对应的订阅确认响应。文档只说通常返回 `code:0` 的确认；本轮没有保存其他帧的结构，不能判定是服务端省略确认、响应形状不同或需要调整匹配。实际收到两只请求证券的 QUOTE 证明数据链路可用；独立确认响应仍待核实。

首轮诊断的 `subscriptionAccepted:false` 是初始默认值，不能解释为服务器明确拒绝。其 `observationSeconds:45` 是预设值，实际因等待确认的约 15 秒计时器提前结束，不能作为观察满 45 秒的证据。原始证据另加解释说明。脚本已改为未收到确认时记录 null、从鉴权成功起单独观察 45 秒、记录实际耗时和消息字段结构，并在退出时对已发送的订阅请求主动取消；修正后的完整授权轮次尚未重跑。

初版诊断输出的 scope 含服务端账户选择标识；已将现存证据中的标识脱敏，并修正后续日志输出。没有输出或落盘访问令牌、刷新令牌或密码。

## 后续迁移前需验证

- 开市时持续变化的报价和源时间；当前是周末，静态首帧不能证明持续实时性或报价时延属性。
- 盘前、常规、盘后的数据选择和涨跌基准；当前仅证明接口返回这些字段。
- 超过 10 分钟的连接、周期 refresh、令牌过期及网络恢复后的重订阅。官方 auth 与 heartbeat 页面描述有差异，见文档核验记录。
- 本机代理之外的目标用户网络、其他账户的地区与市场权限、额度和公开发布条件。
- 正式应用里的系统浏览器授权、系统加密保存 refresh_token、退出账号与撤销处理，以及悬浮条与搜索目录的云端适配。

## 复现

在项目目录运行（使用项目已安装的 undici）：

```powershell
# 无需登录：时间、REST 未授权对照和 WS 无效凭证对照
node scripts/probe-cloud-api.cjs
# 如需重新执行完整账户验证，复用已注册的公开 client_id
node scripts/probe-cloud-api.cjs --authorize
# 在本机浏览器打开 http://127.0.0.1:60355/，由用户完成官方授权
node --test tests/cloud-probe.test.cjs
```

本机回调仅绑定 127.0.0.1:60355，20 分钟未完成则退出。脚本拒绝不匹配的 state、重复回调、缺少行情读取或包含额外业务权限的令牌；不保存令牌，不调用交易或持仓接口。4 项本地检查通过，覆盖 state 异常输入、权限限制、账户标识脱敏和行情证据字段白名单。

官方依据：[授权与注册](https://open.futunn.com/api/overview/getting-started)、[行情 WS 鉴权](https://open.futunn.com/api/quote/push/auth)、[行情订阅](https://open.futunn.com/api/quote/push/subscribe)、[报价字段](https://open.futunn.com/api/quote/realtime/stock-quote)。完整文档核验及尚未确认的限制见 [cloud-api-research.md](./cloud-api-research.md)。
