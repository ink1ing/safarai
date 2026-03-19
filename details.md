# Safari AI Sidebar 细节设计

## 1. 系统组成

整个系统分为四个核心部分：

1. `Host App`
2. `Safari Sidebar UI`
3. `Safari Extension Background`
4. `Content Script`

### Host App

职责：

- 管理设置、登录状态、日志、调试信息
- 提供本地消息宿主能力
- 调用本地 Provider HTTP 服务
- 管理本地存储

建议模块：

- `ProviderClient`
- `ConversationStore`
- `LogStore`
- `SettingsStore`
- `NativeMessagingBridge`

### Safari Sidebar UI

职责：

- 展示当前会话
- 展示页面上下文摘要
- 提供快捷动作按钮
- 显示写入确认

侧边栏首版应包含：

- 当前站点与页面标题
- 当前选区状态
- 快捷操作区
- 会话区
- 草稿区
- 写入确认区

### Background

职责：

- 维护当前 tab 会话上下文
- 将 Sidebar 请求转发到 content script 或 Host App
- 保存当前页面的轻量状态

### Content Script

职责：

- 读取 DOM
- 提取页面正文、标题、选区
- 识别输入框、可编辑区
- 高亮目标节点
- 执行文本写入

## 2. 核心数据结构

### PageContext

```json
{
  "site": "github",
  "url": "https://github.com/...",
  "title": "Example Page",
  "selection": "selected text",
  "articleText": "main extracted content",
  "focusedInput": {
    "type": "textarea",
    "placeholder": "Leave a comment",
    "label": "Comment"
  }
}
```

### ConversationMessage

```json
{
  "id": "msg_001",
  "role": "user",
  "kind": "question",
  "text": "总结这个页面"
}
```

### DraftIntent

```json
{
  "targetId": "input_001",
  "targetDescription": "GitHub PR comment box",
  "draft": "建议评论内容",
  "requiresConfirmation": true
}
```

## 3. 消息协议

推荐使用统一 JSON 消息协议。

### 请求

```json
{
  "id": "req_001",
  "type": "summarize_page",
  "payload": {
    "context": {}
  }
}
```

### 响应

```json
{
  "id": "req_001",
  "ok": true,
  "payload": {
    "answer": "页面总结",
    "draft": null
  }
}
```

### 错误

```json
{
  "id": "req_001",
  "ok": false,
  "error": {
    "code": "PROVIDER_TIMEOUT",
    "message": "request timeout"
  }
}
```

## 4. Provider 设计

### 为什么用本地 HTTP

你要求“可实现性和稳定性优先”，所以 Provider 黑盒边界建议固定为本地 HTTP。

优点：

- Swift 调用最稳定
- 黑盒可用任何语言实现
- 以后替换 Provider 不影响扩展逻辑
- 便于单独做健康检查与日志

### 推荐接口

- `GET /health`
- `POST /chat`
- `POST /summarize`
- `POST /rewrite`
- `POST /draft`

### 必须支持的字段

- `request_id`
- `site`
- `url`
- `title`
- `selection`
- `article_text`
- `focused_input_context`
- `conversation_history`

### 必须支持的行为

- timeout
- 明确错误码
- 非 200 返回
- 日志关联 request_id

## 5. 写入流程设计

写入流程必须固定，不允许自由发挥。

### 标准流程

1. 用户在 Sidebar 触发“写入当前输入框”
2. content script 获取当前聚焦输入元素
3. 如果找不到，提示用户先点击输入框
4. 如果找到，提取目标描述
5. Provider 生成草稿
6. 页面中高亮该输入框
7. Sidebar 展示草稿和目标说明
8. 用户确认
9. content script 写入文本
10. 不提交，不点击发送

### 禁止行为

- 自动按回车
- 自动点击发送
- 自动跳转
- 自动切换标签页

## 6. 站点适配策略

### GitHub

优先支持：

- PR 页面
- Issue 页面
- README 页面
- 评论输入框

适配重点：

- 评论框定位
- Markdown 内容读取
- 代码块与正文区分

### Gmail

优先支持：

- 单封邮件页面
- 邮件线程总结
- 回复编辑框

适配重点：

- 邮件正文提取
- 当前线程上下文
- 富文本输入区写入

### X

优先支持：

- 单帖文页面
- 线程页面
- 回复框
- 发帖框

适配重点：

- React 控制 DOM 的稳定定位
- 动态节点重新挂载后的再识别
- 选中内容与可见正文区分

### Yahoo Mail

优先支持：

- 邮件阅读页
- 回信框

适配重点：

- 富文本输入兼容
- 失败时回退到剪贴板

## 7. 降级策略

首版必须允许降级，否则产品会过度脆弱。

### 阅读能力降级

如果正文提取失败：

- 退化为只使用标题、URL、选中内容

### 写入能力降级

如果无法稳定定位编辑器：

- 不执行页面写入
- 只展示草稿
- 提供“复制到剪贴板”

### Provider 降级

如果黑盒不可用：

- 显示统一错误提示
- 不阻塞 Sidebar 打开

## 8. 日志与调试

必须做结构化日志。

### 每次请求记录

- `request_id`
- `site`
- `url`
- `action_type`
- `extract_duration_ms`
- `provider_duration_ms`
- `write_target_detected`
- `write_confirmed`
- `write_success`
- `error_code`

### 本地日志用途

- 定位站点适配失败
- 定位 Provider 超时
- 定位扩展失联
- 对小范围测试用户做问题排查

## 9. 本地存储设计

首版建议 SQLite。

存储内容：

- 最近会话
- 最近站点上下文摘要
- 用户偏好
- 最近写入记录
- 调试日志索引

不建议长期落盘：

- 全量页面 HTML
- 整页 DOM 快照
- 明文 token

## 10. 安全与边界

虽然本项目是本地使用和小范围测试，但仍需明确边界。

### 允许

- 读取当前页面可见文本
- 读取选中内容
- 写入用户确认后的目标输入框

### 不允许

- 自动提交
- 自动批量操作多个页面
- 后台静默读取所有标签页
- 无提示执行破坏性动作

## 11. 未来可扩展点

为了不返工，首版就要预留这些扩展位：

- 多 Provider 支持
- 流式输出
- Prompt 模板
- 站点适配器注册表
- 页面结构化提取模板
- 操作审批策略

## 12. 设计结论

这个项目首版成败的关键不在 OAuth 逆向，而在下面三件事：

1. 页面上下文抽取是否稳定
2. 输入框定位与写入是否稳定
3. 扩展、宿主 App、Provider 三者之间的边界是否清晰

因此首版设计必须坚持：

- Sidebar 单入口
- Read-first，Write-safe
- Provider 黑盒隔离
- 站点适配分层
- 降级优先于误操作
