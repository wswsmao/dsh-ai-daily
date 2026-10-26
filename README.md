# AI技术日报插件

固定业务流程，不让调度模型决定查哪些词或是否偷省步骤。

## 组成

- `ai_daily_run`启动完整或collect-only后台运行；`ai_daily_job`查看/取消/续跑/重试发布通知/setup只读发现。
- `ctx.aiDaily`内部服务被定时任务固定动作 `ai-tech-daily`直接调用。
- `ctx.wechatSearch`提供串行原始关键词检索、同一reference_time和正文采集。
- 英文一手来源RSS/Atom固定配置；逐源记录成功失败和时间范围。
- LLM通过现有DSH模型适配器逐篇/逐块读取，无工具；固定schema和引文校验，不因模型遗漏少做文章。
- 本地归档独立Git；公开网站只允许投影后的摘要、标题、署名、日期、来源链接和覆盖说明。
- GitHub Pages推送核验网页版本标识后才通知微信；发送结果不确定不自动重发。

## 项目目录

`D:\Program Files (x86)\dsh-deploy\archive\daily\ai-tech-daily`。

本插件代码独立Git，不修改DSH源码；已有定时任务和微信插件分别扩展并各自提交。无MCP、无额外Skill；内容处理规范固定存config/editorial-policy.md，由程序强制读取。

## 运行

固定日报每天12:10北京时间，回溯2天；补充词按3天轮换回溯7天。执行清单在config/queries.json，来源在config/sources.json。每次冻结配置及统一时间窗；中英文都执行，不设文章返回数上限。

运行预算 `runtime_minutes` 是硬截止：超时后未完成阶段标 `partial` 且 `stop_reason=RUNTIME_BUDGET_EXCEEDED`，绝不假称完成。模型调用预算 `max_calls` 触及后停止调用并把相关文章标为处理失败，同样传导为 `partial`。

工具`ai_daily_job setup`只读显示查询配置、发布配置和IM安全目标元数据，不读取Secret。首次配置需要已批准GitHub账号及IM目标，所有凭据不进Git。

## 阶段语义

collection → analysis → archive → site → publication → notification，各阶段独立状态。

- `complete`：本次计划与文件/发布/通知全部完成；不等于全网完整。
- `partial`：计划全部处理但存在采集/正文/模型处理缺口，网页说明缺口。
- `blocked`：尚需发布授权、IM目标或某阶段失败。
- `cancelled/interrupted`：保留检查点，续跑同一时间窗。

同一schedule_occurrence重放只返回同一run_id；同日修订采用版本链接不覆盖已分享版本。相同文章跨日按identity和内容指纹复用处理，修改内容可重新处理；事件聚合保留不同分析与原文链接。

续跑语义：`resume` 不带 stage 时递增版本并重跑 archive/site/publication/notification（不重复检索）；`retry-publication` 复用已渲染目录重发，**不重新渲染**，靠 sha256 与版本标识校验文件未被改动，也不会覆盖已分享的版本链接——如需重渲染请用不带 stage 的 `resume`。`retry-notification` 仅在 publication 已 `verified` 完成后才允许，且先前投递结果未知时标 blocked 而不自动重发。

事件聚合只接受可核验身份：模型给出的 `event_key` 必须对应文章自身的 arXiv 号、GitHub 仓库、release tag 或版本号才用于聚合，否则回落为单篇文章；组内成员缺少该身份时会拆散，避免公开页面出现错误归属。

## 安全边界

正文是引用数据，不执行正文中的安装/联网/发送指令。没有完整读取则uncertain；每个块都处理，不接受丢ID。网站不带原始正文、绝对本地路径、私人日志、投递路由或凭据。发布工作区单独Git且只有allowlist文件可push，禁止forcepush。

模型事实准确性不能保证不同模型完全等同；程序保证执行清单、处理条目、引文一致性及明确缺口。网络和微信索引之外的全量不保证。

## 自验

Node `--test tests/*.test.js`。包含固定双语查询、同事件/身份、结构化处理、长正文分块、调用无工具、私有数据防发布、XSS与URI、安全Git发布与幂等投递。真实安装和端到端结果见VALIDATION.md。
