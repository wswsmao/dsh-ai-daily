# 日报插件自验记录

## 自动验证

2026-10-26，Node24：33项测试，32通过、1符号链接权限跳过、0失败。
覆盖固定双语计划、AgenticOS、准确article_id、原文引文核验、长正文全部分块、无工具模型调用、无正文保留uncertain、文章身份合并、schedule_occurrence重放、并发拒绝、collect-only不发布、移动阅读页安全投影与XSS、历史回补、公开Git树边界/远端/文件哈希、推送不确定不重试、发布版本标识、IM安全目标发现/发送及结果不确定性。

## 外部配置

用户批准使用已有GitHub账号新建公开日报网站，实际账号wswsmao。新建仓库wswsmao/ai-tech-daily并启用Pages从main根目录发布，HTTPS地址https://wswsmao.github.io/ai-tech-daily/。初始仅公开.gitignore控制文件，正式日报发布尚待端到端验证，不伪称网站已产生日报。

日报项目和发布checkout各自Git，原文/私有日志/.runtime不公开。定时任务目标用户指定为每天12:30北京时间。

## 待完成端到端自验

安装新服务与固定业务入口；正文真实采集；英文源实际可用；真实模型处理；归档与发布链接GET；IM目标发现和手机投递；定时业务真实终态。缺失或失败将明确更新本记录。
