# dsh-subagent-grok

面向 **DeepSeek Harness 0.2.2-rc.3** 的 Grok Build 一次性子代理插件。
沿用官方 `@deepseek-ai/dsh-subagent-codex` 的 Cordis Provider、公共子代理工具、
子进程服务与运行句柄结构，协议层改为 Grok 原生 ACP。

## 固定行为

- 直接调用已经安装的 Grok CLI；不下载 CLI、不执行版本查询、不做 CLI 版本门槛检查。
- 启动参数为 `grok agent --always-approve --no-leader stdio`。
- `session/new` 同时传入 `_meta.yoloMode: true`；后续权限请求优先选择 `allow_once`。
- 每个任务使用独立进程和新 session，只发送一次 `session/prompt`，不恢复历史会话。
- 任务结束、取消或执行失败后，立即走原生 `_x.ai/session/delete` 清理该次 session，
  然后释放进程；完成通知等待清理结束。
- 原进程异常时，先回收它，再启动一次只负责删除的 CLI 连接；该连接不会新建 session。
- 删除操作只使用这一次 `session/new` 的 ID，不扫描删除已有会话或工作区。
- 沿用 Grok 原生认证和配置。`always-approve` 不覆盖 Grok 的 deny 规则、hooks 或管理员限制。

## 安装

发布压缩包内含可安装的 `dsh-subagent-grok-0.1.0.tgz` 和完整源码目录。
在 `.tgz` 所在目录，通过现有 DSH CLI 安装到需要的 Profile：

```powershell
dsh plugin --profile web add ./dsh-subagent-grok-0.1.0.tgz
```

如平时通过 npx 启动 Harness：

```powershell
npx @deepseek-ai/dsh@0.2.2-rc.3 plugin --profile web add ./dsh-subagent-grok-0.1.0.tgz
```

将 `web` 替换为实际 Profile 名称，按安装器提示加载配置层或重启。
插件注册 `grok` Provider，并通过官方 `@deepseek-ai/dsh-tool-subagent` 暴露全局工具
`subagent_grok`，`maxDepth` 设置为 `provider-managed`。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `providerName` | `grok` | Provider 注册名称 |
| `executable` | 自动定位 | 优先用户目录下 `.grok/bin/grok.exe`（Windows）或 `.grok/bin/grok`；否则使用 PATH 上的 `grok` |
| `model` | 不覆盖 | 可选原生模型名，通过 `--model` 原样传入 |
| `env` | `{}` | 叠加在 DSH 清理凭据后的父进程环境上 |
| `disposeGraceMs` | `3000` | DSH 管理的进程终止宽限，毫秒 |
| `cleanupTimeoutMs` | `30000` | 每次原生删除清理尝试的时间上限，毫秒；不是任务执行超时 |

例如在 Provider 条目的 `config` 中指定已有可执行文件：

```yaml
executable: 'C:\Users\YOUR_USERNAME\.grok\bin\grok.exe'
```

权限固定为 `always-approve`，session 清理固定开启，没有额外权限开关或保留历史开关。
已有本机登录仍由 Grok 使用；需要环境变量认证时，在 `env` 显式提供相应变量。
工作目录来自 DSH 的子任务请求；默认与父任务一致，文件修改不会因删除 session 而回滚。

## 实现结构

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 配置 schema、注入 `subagents/subprocess`、注册 Provider |
| `src/run.ts` | 本机可执行文件定位、进程所有权、结果结算、删除与回收 |
| `src/wire.ts` | ACP 握手、会话创建、权限应答、回答收集和原生删除 |
| `cordis.patch.yml` | Provider 与官方通用工具的 Profile 配置层 |
| `lib/` | 已生成的 ESM JavaScript 和公开类型，安装时无需编译 |

返回最后一段非空助手回答。Grok 提供 `response_started/response_completed` 时按这些
消息边界收集，否则以工具调用边界分隔回答。ACP 没有 Codex 的 `final_answer` 阶段保证；
没有可用边界时，连续的助手文本会合并。推理、工具载荷、计划与使用量不回传父会话。
仅以 `session/prompt` 响应的 `stopReason` 判断任务结束。

启动成功后沿用 `settleRunResult` 和 `subprocessRunHandle`；普通执行失败转为停止原因，
取消结果为 `aborted`。原生删除失败会尝试一次独立连接重试；若仍失败，会明确返回清理失败，
并让 `dispose()` 报错，不会把保留着 session 的任务报告成完全成功。
Grok 的原生删除也可能涉及它维护的远端副本和索引，因此远端服务不可用时删除可能失败。
进程被操作系统强制杀死或宿主崩溃时，无法保证清理回调能执行。

不继承父对话，不支持续接、父级 `agentPreset/agentOptions`、结构化输出或 Harness 深度强制约束。
插件不会替用户登录，不会创建新的 DSH 本地子 Session，也不会安装到你的环境中。

## 构建和打包

Node.js 要求与目标 Harness 一致：`>=24.9.0`。构建只使用 Node 内置的 TypeScript 转换器，
不加载插件依赖或运行 Grok：

```powershell
node scripts/build.mjs
npm pack --ignore-scripts --offline
```

依赖按 Harness `0.2.2-rc.3` 固定；Cordis 和 Schemastery 使用该源码基线的版本系列。
安装仍需由 DSH 的包管理器解析这些依赖。

**按用户要求，本次只编码、生成 JavaScript 和打包；未运行测试、类型检查、插件加载检查、
真实 CLI 任务或安装验证。兼容版本是实现目标，尚未经运行测试确认。**

许可：MIT。原版架构和共享实现的来源见 `NOTICE`、`LICENSE`。
