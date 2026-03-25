# Safari AI Sidebar 实际状态与下一步计划

Last updated: 2026-03-25

## 说明

这份文档不再只描述理想中的 MVP 顺序，而是基于当前仓库中的真实实现来判断：

- 哪些部分已经完成
- 哪些部分已经开始但还没有收口
- 接下来最值得做的事情是什么

## 当前阶段判断

项目已经明显超过“Phase 0 工程骨架”。

按真实代码状态判断，当前处于：

- `页面理解`：已基本落地
- `安全写入`：主链路已落地，但仍需实站验证和补强
- `宿主面板与 Agent 扩展`：已开始超出原始 MVP
- `架构收敛与稳定性治理`：尚未完成

换句话说，项目不是“还没做出来”，而是“已经做出不少功能，但需要把范围和架构重新收束”。

## 实际完成度

### 1. 工程骨架与通信链路

当前状态：`已完成`

仓库中已经存在：

- `macOS App + Safari Web Extension` Xcode 工程
- 扩展 `background.js`、`content.js`、popup UI
- Native Messaging 入口和宿主路由
- 宿主面板状态落盘与同步

已实现链路：

- popup -> background
- background -> content script
- background -> native host
- native host -> 宿主 App 状态文件 / 控制能力

备注：

- 原设计里的“Provider HTTP Stub”并不是当前主路径
- 现在的真实实现已经更接近“扩展直接经 native host 调用 Swift 侧 Codex 服务”

### 2. 页面理解能力

当前状态：`大体完成`

已实现：

- 当前页面 URL、标题、选区提取
- 正文候选区域打分与选择
- 结构化正文抽取
- 页面结构摘要
- 交互元素摘要与目标索引
- 页面视觉背景/配色提取
- 目标站点识别：
  - GitHub
  - Gmail
  - X
  - Yahoo Mail

代码依据：

- `safarai Extension/Resources/shared/page-context.js`
- `tests/page-context.test.js`

当前结论：

- 浏览器侧页面理解已经不是 stub，而是较完整的 DOM-first 实现
- 这部分是目前代码库最扎实的模块之一

### 3. 安全写入能力

当前状态：`主链路已完成，仍需回归验证`

已实现：

- 聚焦输入框识别
- 站点特化选择器回退
- 高亮目标输入框
- 草稿写入 textarea / input / contenteditable
- 写入失败时降级到剪贴板
- 明确不自动提交

代码依据：

- `safarai Extension/Resources/shared/write-target.js`
- `safarai Extension/Resources/content.js`
- `safarai Extension/Resources/background.js`
- `tests/write-target.test.js`

当前缺口：

- 仍缺少针对真实 GitHub / Gmail / X / Yahoo Mail 的稳定性回归记录
- 富文本编辑器的边界情况还没有系统验证

### 4. Codex 登录、模型与回答能力

当前状态：`已接入真实链路`

已实现：

- 宿主 App 发起 Codex OAuth
- 本地 `localhost` 回调监听
- token 交换与 refresh
- 模型拉取
- 流式回答

代码依据：

- `safarai/CodexOAuthService.swift`
- `safarai/CodexModelService.swift`
- `safarai/CodexResponseService.swift`

这意味着：

- 当前项目已经不是只依赖 mock 数据
- 真正的 Codex 登录和请求链路已经落在宿主 App 中

### 5. 面板 UI 与产品范围

当前状态：`已经超出最初 MVP`

当前宿主 App 不只是最小控制面板，还已经包含：

- 独立聊天面板
- 会话历史
- 线程管理
- 附件
- 主题 / 语言 / 跟随页面色彩
- Agent 模式 UI

代码依据：

- `safarai/ViewController.swift`
- `safarai/Resources/Panel.js`

这和最初“最小 Sidebar 产品”的差异很重要：

- 现在的产品方向更像“Safari 上下文聊天面板 + 页内 agent”
- 如果不主动收敛，范围会继续膨胀

## 已验证内容

### 自动化测试

2026-03-25 已执行：

```bash
node --test tests/*.test.js
```

结果：

- `23 / 23` 通过

覆盖范围：

- 协议对象
- 页面上下文抽取
- 写入目标解析与写入
- 会话裁剪
- 日志裁剪

### 本地构建现状

2026-03-25 执行命令行构建时，`xcodebuild` 当前停在扩展签名阶段：

- `Command CodeSign failed with a nonzero exit code`

这说明：

- 工程本身是可识别的
- target / scheme 存在
- 但本地 CLI 构建还没有清理到“稳定可复现”

## 当前最主要的问题

### 1. 架构与设计文档已经不一致

设计文档强调：

- Sidebar 单入口
- Provider 走本地 HTTP 黑盒
- 最小范围的读写助手

实际代码已经变成：

- 扩展 + popup + 独立桌面面板并行
- Swift 直接承担 Codex 请求职责
- 出现 Agent 化能力和更大的桌面聊天产品形态

### 2. Provider 抽象还没有真正立住

原本想要的边界是：

- 扩展 / 宿主只依赖统一 Provider 接口

当前实际情况是：

- Swift 代码直接调用 Codex 后端
- 扩展 target 和 app target 都有账户/OAuth/模型相关实现

这会直接增加：

- 维护成本
- 替换 provider 的难度
- 调试和一致性风险

### 3. 稳定性验证还不够系统

虽然单测已经有基础，但还缺：

- 跨站点手工回归清单执行记录
- end-to-end 自动化验证
- 页面刷新、DOM 重挂载、扩展重载后的连续验证

## 建议的下一阶段计划

接下来不要继续无节制扩展功能，先做收敛。

### Phase A：产品范围收口

目标：

- 明确产品主入口到底是：
  - Safari popup/sidebar
  - 独立宿主面板
  - 两者并存

必须输出：

- 一份新的产品边界说明
- 保留功能与暂缓功能列表

如果不先做这一步，后面的代码会继续分叉。

### Phase B：Provider 架构收敛

目标：

- 把 Codex 调用收敛到单一 provider 边界
- 减少 app target / extension target 中重复的 OAuth、模型、账户逻辑

建议结果：

- 一个清晰的 Provider 服务层
- 一个统一的账户配置读写入口
- NativeRouter 不再承载过多业务细节

### Phase C：站点级稳定性验证

目标：

- 针对 GitHub、Gmail、X、Yahoo Mail 执行固定回归

最少验证项：

- 页面总结
- 选中文本解释
- 问答
- 草稿生成
- 写入确认
- 写入失败降级
- 页面刷新后恢复

### Phase D：构建与分发清理

目标：

- 解决扩展签名与命令行构建问题
- 形成稳定安装流程

交付物：

- 本地可复现 build 步骤
- Safari 扩展开启说明
- 宿主 App 首次登录与调试步骤

## 当前优先级排序

建议按下面顺序推进：

1. 先决定产品主形态，停止继续扩范围。
2. 收敛 Provider / OAuth / account 相关实现。
3. 补四个目标站点的真实回归验证。
4. 修复构建签名与安装链路。
5. 再考虑继续扩展 agent、多步操作或更多 UI 能力。

## 阶段性验收标准

下一轮不再以“功能更多”为成功标准，而以“更稳、更清晰”为标准。

必须满足：

- 主入口定义清楚
- Provider 边界清楚
- 四个目标站点最小链路可回归
- 写入仍然保持不自动提交
- 项目可在本地稳定构建和启动

可以后延：

- 更复杂的 agent 编排
- 更多站点
- 更丰富的桌面聊天能力
- 页面自动点击
- 多 Provider 切换
- 高级工作流模板

## 建议的项目管理方式

- 每个 Phase 结束都做一次回归测试
- 所有 bug 按站点分类记录
- 单独记录“页面读取失败”和“写入失败”
- 所有跨模块问题都保留 request_id

## 完成定义

这个项目首版完成，不等于功能最多，而等于：

- 你能在日常 Safari 使用中真实依赖它
- 小范围测试用户能安装并完成主要任务
- 你能定位失败原因并快速修复
