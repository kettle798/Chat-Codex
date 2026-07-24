# Codex invalid cwd Operation not permitted 排障与适配说明

## 背景

运行 Chat-Codex 时，聊天侧可能收到：

```text
Codex 执行失败: invalid cwd: Operation not permitted (os error 1)
```

这个错误不是微信投递限流、审批过期、模型 token 或 GitHub 问题。它来自 Codex app-server 对工作目录 `cwd` 的解析或配置加载阶段，含义是当前 Codex app-server 进程无法把某个工作目录解析成可用目录。

本次排查基线：

- Chat-Codex 当前分支：`main`。
- Codex 参考源码：`references/openai-codex`，HEAD `f61b51ddd Support remote code-mode hosts in app-server (#35098)`。
- 相关 Chat-Codex 文件：
  - `src/codex/app-server/rpc-client.ts`
  - `src/codex/app-server-codex-adapter.ts`
  - `src/codex/workdir.ts`
  - `src/cli.ts`
  - `src/cli/serve/startup.ts`
- 相关 Codex 参考源码：
  - `references/openai-codex/codex-rs/app-server/src/request_processors.rs`
  - `references/openai-codex/codex-rs/utils/absolute-path/src/lib.rs`
  - `references/openai-codex/codex-rs/app-server/src/request_processors/thread_processor.rs`
  - `references/openai-codex/codex-rs/app-server/src/request_processors/turn_processor.rs`
  - `references/openai-codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
  - `references/openai-codex/codex-rs/app-server-protocol/src/protocol/v2/turn.rs`

## 结论

`invalid cwd: Operation not permitted (os error 1)` 表示 Codex app-server 在处理请求里的 `cwd` 时遇到本地操作系统权限错误。

最常见原因有两类：

1. Chat-Codex 启动时所在目录对 Codex 子进程不可访问。
2. 当前绑定的 Codex session 历史 `cwd` 对 Codex 子进程不可访问。

第一类很容易被忽略。最新 Codex 的 `resolve_request_cwd()` 会调用 `AbsolutePathBuf::relative_to_current_dir(...)`，而 `relative_to_current_dir()` 会先读取 app-server 进程自己的 `std::env::current_dir()`。因此即使 Chat-Codex 传给 app-server 的 session cwd 已经是绝对路径，只要 app-server 子进程自己的当前目录不可访问，也可能直接返回 `invalid cwd: Operation not permitted`。

当前 Chat-Codex 启动 app-server 时没有显式设置子进程 `cwd`，所以 Codex 子进程会继承 Node/Chat-Codex 进程的 `process.cwd()`。

## 当前实现（2026-07-24）

本轮先实现可观测性，不在证据不足时修改运行 cwd：

- 仅当 Codex app-server 返回原始 `invalid cwd` 错误时，Bridge 才检查请求携带的 cwd 与 Node 进程当前 cwd。
- 检查记录请求来源（`thread/start`、`thread/resume` 或 `turn/start`）、session id、`stat`、`realpath`、读取/进入目录权限结果与原始错误文本。
- 聊天侧仍原样展示 Codex 返回的错误；不会改写为中文提示。
- `/status` 会在对应 session 下展示最近 cwd 错误及诊断摘要；终端日志会输出结构化的 `codex invalid cwd diagnostic` 记录。
- 不修改 session cwd，不重建 session，不自动重试 RPC，也不重放失败任务。

因此，这次改动用于区分“请求中的历史 session cwd 有问题”和“app-server 继承的进程 cwd 有问题”，而不是用猜测替换用户的工作区。

## 为什么不会弹审批

这不是一次可以由 `/OK`、`/P`、`/NO` 处理的 Codex 操作审批。正常顺序是：

```text
收到聊天消息 -> 解析 cwd -> 建立/恢复 session -> 开始 turn -> Codex 尝试执行受限操作 -> 请求审批
```

这次错误发生在第二步。macOS 在 app-server 读取或进入当前目录时直接返回 `Operation not permitted`，Codex 尚未拿到可用的工作目录，也尚未产生“准备执行哪条命令、访问哪个工作区外路径”的操作意图，因此没有可发送给聊天渠道的审批请求。

`/permission full` 也通常不能修复此问题。它控制的是 Codex 已经启动并解析好工作目录之后的 sandbox/审批策略，不能绕过 macOS 对进程自身工作目录、父目录或受保护位置的访问限制。

同理，`runtimeWorkspaceRoots` 不是此错误的绕过手段；它用于在已选定运行环境后解析 workspace-write 的范围，不会授予进程访问一个连 `cwd` 都无法解析的位置的 macOS 权限。

## 当前链路

Chat-Codex 会在三类请求里传 cwd：

- 新建 session：`thread/start` 传 `cwd: input.cwd`。
- 恢复 session：`thread/resume` 传 `cwd: discovered?.cwd`。
- 开始普通 turn：`turn/start` 传 `cwd: stored.session.cwd`，并把同一个 cwd 放进 workspace-write sandbox writable root。

也就是说，如果某个 route 绑定到了一个历史 cwd 不可访问的 session，用户之后每发一条普通消息都会再次命中同一个坏 cwd，看起来就会“频繁出现”。

另外，`src/codex/workdir.ts` 当前只检查：

- 路径是否存在。
- 路径是否为目录。

它还没有检查：

- 当前进程是否能进入该目录。
- 当前进程是否能读取该目录。
- 父目录是否可 traverse。
- `realpath` 是否能解析。
- macOS TCC 隐私权限是否阻挡 Terminal、iTerm、Node 或 Codex。

## 常见触发场景

### macOS 隐私权限

macOS 的隐私权限可能阻止终端或子进程访问 Desktop、Documents、Downloads、iCloud Drive、外置盘或某些受保护目录。表现上可能不是 `EACCES`，而是 `Operation not permitted (os error 1)`。

需要检查的应用通常包括：

- Terminal 或 iTerm。
- 启动 Chat-Codex 的 Node 运行环境。
- Codex CLI 所在进程。

### 外置盘或挂载目录

项目或历史 session cwd 如果在 `/Volumes/...` 下，可能因为外置盘未挂载、卷权限变化、系统休眠后挂载状态异常而失败。

### 历史 session cwd 已失效

恢复已有 Codex session 时，Chat-Codex 会从 Codex 本地历史记录读取原始 cwd。即使当前启动参数 `--cwd` 指向一个可用目录，选择已有 session 后也会使用历史 session 自带的 cwd。

当前 CLI 里选择已有 session 时，`--cwd` 会被忽略，这是为了避免偷偷迁移已有 session 的 workspace 和 sandbox root。

### 启动目录本身失效

如果 Chat-Codex 从一个后来被删除、卸载、权限收回的目录启动，Codex app-server 子进程继承这个 cwd 后，解析任何带 cwd 的请求都可能失败。

## 如何快速确认

先确认 Chat-Codex 是从哪个目录启动的：

```bash
pwd
/bin/pwd -P
```

确认目录存在且当前用户可以进入和读取：

```bash
ls -ldeO@ "$PWD"
node -e 'const fs=require("fs"); const p=process.argv[1]||process.cwd(); fs.accessSync(p, fs.constants.R_OK|fs.constants.X_OK); console.log("ok", p)' "$PWD"
```

如果报错目录是历史 session cwd，也对那个目录执行同样检查：

```bash
ls -ldeO@ "/absolute/session/cwd"
node -e 'const fs=require("fs"); const p=process.argv[1]; fs.accessSync(p, fs.constants.R_OK|fs.constants.X_OK); console.log("ok", p)' "/absolute/session/cwd"
```

如果目录在外置盘上，先确认挂载：

```bash
ls /Volumes
ls -ld "/Volumes/<volume-name>"
```

如果是 macOS 隐私权限，进入系统设置：

```text
Privacy & Security -> Full Disk Access
Privacy & Security -> Files and Folders
```

给启动 Chat-Codex 的 Terminal/iTerm 授权。授权后完全退出终端并重新启动 Chat-Codex。

## 立即恢复方式

### 重新从安全目录启动

进入一个明确可访问的目录再启动 Chat-Codex：

```bash
cd /Volumes/MacSSD/Repositories/codex-chat-bridge
```

然后按原来的启动命令启动，并显式指定新 session cwd：

```bash
--cwd /Volumes/MacSSD/Repositories/codex-chat-bridge
```

如果你使用的是 TUI，就在工作目录配置里选择一个当前可访问的目录。

### 不要继续恢复坏 cwd 的历史 session

如果问题来自历史 session 的 cwd，当前最稳的恢复方式是：

1. 先让那个历史 cwd 恢复可访问，比如重新挂载外置盘或补 macOS 权限。
2. 如果短期无法恢复，创建新 session，使用可访问 cwd。
3. 暂时不要继续 `/resume` 或 `/use` 到坏 cwd 的历史 session。

### 确认不是权限模式问题

`/permission approval`、`approve-for-me`、`full` 主要影响 Codex 执行命令时的审批和沙箱策略，不会绕过 app-server 解析 cwd 的本地 OS 权限错误。

## 是否是新版 Codex 需要适配

是，但不是说旧的顶层 `cwd` 字段已经不能用了。

最新 Codex 仍然支持 `thread/start.cwd`、`thread/resume.cwd` 和 `turn/start.cwd`。同时，最新协议增加了实验性的：

- `runtimeWorkspaceRoots`
- `environments`
- remote code-mode host 相关路径表达

这些新能力说明 Codex 正在把“当前工作目录”和“运行环境/工作区根目录”拆得更细。Chat-Codex 当前继续使用顶层 `cwd` 是合理的兼容路径，但应该补上本地 cwd 预检和诊断记录，避免排查时只能看到一条裸错误。

### 新版机制怎么理解

可以把新版 Codex 的工作区机制理解成三层：

1. `cwd`
   这是当前仍可用的兼容字段。它表示本地默认环境里的当前工作目录。Chat-Codex 现在就是通过 `thread/start.cwd`、`thread/resume.cwd`、`turn/start.cwd` 传这个值。
2. `runtimeWorkspaceRoots`
   这是运行时的工作区根目录列表，用来解析权限 profile 里的 `:workspace_roots` 这类占位符。它不等于“无条件可读写白名单”。真正能不能读写，仍由当前 permission profile / sandbox 决定。比如 workspace-write 模式通常会把 `:workspace_roots` 当成可写范围；范围外的写入或高风险命令仍应走失败、沙箱外执行审批或权限申请。
3. `environments`
   这是更完整的运行环境选择。每个 environment 有自己的 `environmentId`、`cwd` 和 `runtimeWorkspaceRoots`。本地环境只是其中一种，后续 remote code-mode host 会用这类字段表达远程工作目录，而不是单纯表达本机路径。

当前 Chat-Codex 不需要马上发送 `environments`。本地微信/飞书桥接仍可以继续用顶层 `cwd`。

近期已完成的是错误后的本地诊断：聊天侧保留 Codex 原始错误，日志和 `/status` 记录请求 cwd 与 app-server 继承 cwd 的检查结果。只有当真实记录明确指向某一类问题时，才需要做下一阶段的定向适配。

后续如果要支持 remote code-mode host，才需要把 route/session 的工作区从“一个本机 cwd 字符串”升级成“环境选择 + 环境 cwd + workspace roots + permission profile”。那时不能再用本机 `fs.accessSync()` 去验证远程 cwd，也不能把 workspace roots 当成绕过审批的额外授权。

### 更新后出现、重启后恢复如何判断

“更新 Codex 后第一次出现，重启 Chat-Codex 后又恢复”是有价值的线索，但不能只凭时间先后就认定为 Codex 版本回归。

- 当前 app-server 确实会在处理 `cwd` 时读取自身的 `current_dir()`；新版本更容易经过新的 environment / app-server 初始化路径时，可能暴露原先未触发的目录访问问题。
- 如果重启后仍恢复了**同一个 Codex session id**，但错误消失，优先怀疑旧 app-server 子进程继承的启动 cwd、挂载状态或 macOS 授权状态；重启会重新创建该子进程。
- 如果重启后 Bridge 创建了**新的 Codex session id**，则历史 session 记录的 cwd 也仍是高概率原因；新 session 换成了新的 cwd，错误自然消失。
- 当前 Codex CLI 启动时还会尝试在 `CODEX_HOME/tmp/arg0` 创建 helper alias。若这里没有写权限，它会给出 `could not create PATH aliases: Operation not permitted` 警告并继续运行。这与 `invalid cwd` 是不同代码路径，不能把两者当成同一个错误；但都提示运行环境可能有 OS 级权限/沙箱限制。

因此，修复不应依赖“重启碰巧恢复”。Bridge 现在会在出错后记录 session id、请求 cwd、app-server 继承 cwd 和检查结果；下次出现时即可直接区分是启动进程问题还是历史 session 问题。

## 后续可选适配

### 1. 分离 app-server 子进程 cwd 和 session cwd

仅当诊断持续表明 app-server 继承的进程 cwd 不可访问，而请求 session cwd 正常时，才考虑给 `AppServerRpcClient` 新增受控的 `processCwd` 或 `spawnCwd` 选项，启动 `codex app-server` 时显式传给 `spawnCodex(..., { cwd: processCwd })`。

选择原则：

- 必须是绝对路径。
- 必须存在。
- 必须是目录。
- 当前进程必须有 `R_OK | X_OK`。
- 使用 Chat-Codex 已配置的 `startup.cwd`，它本来就是新 session 的默认工作目录。
- 不要在后台静默回退到 `os.homedir()`、系统临时目录或其他目录；这会改变 Codex 的配置发现位置、相对路径基准和用户预期的工作区。

这是一个有条件的修复，不是本轮默认行为；它会改变 app-server 的相对路径基准和配置发现位置，必须先有真实诊断记录和单独测试。

### 2. 新建 session 前预检 cwd

如果后续需要更早发现问题，`resolveNewSessionWorkdir()` 或其调用方可以补充：

- `fs.statSync(cwd).isDirectory()`
- `fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK)`
- `fs.realpathSync.native(cwd)` 仅用于诊断，不强制改写用户看到的逻辑路径。

预检首先是诊断，不应静默改写 cwd 或替换用户的 session。若 app-server 随后返回错误，聊天侧仍展示 Codex 原始错误。诊断内容至少包含：

```text
cwd: <cwd>
access check: Operation not permitted
source: startup cwd / new session cwd
```

但不应在预检失败时擅自替换 cwd、创建新 session 或代替 Codex 返回另一个错误。

### 3. 恢复历史 session 前预检 discovered cwd

`AppServerCodexAdapter.loadSessionFromServer()` 当前会把 `findCodexSessionById()` 找到的 `discovered?.cwd` 直接传给 `thread/resume`。

可选方案：

- 如果 discovered cwd 可访问，继续传给 app-server。
- 如果不可访问，不直接调用 `thread/resume`，而是保留 Codex 原始错误口径并记录诊断上下文。
- 诊断里明确这是历史 session cwd，不是当前聊天消息问题。

诊断记录示例：

```text
cwd: <cwd>
access check: Operation not permitted
source: discovered historical session cwd
session: <session-id>
```

### 4. 开始 turn 前再次预检 stored session cwd

session 启动后，外置盘可能被卸载，macOS 权限也可能被收回。因此 `turn/start` 前仍应检查 `stored.session.cwd`。

如果失败，可先记录诊断，但不自动替换 cwd、不自动创建新 session，也不自动重试或重放本次 turn。随后仍由 app-server 返回原始错误；这样不会因为“修复”而重复执行用户任务或改变历史 session 的工作区。

### 5. `/status` 展示最近 cwd 错误

当 app-server 返回 `invalid cwd` 时，`/status` 现在会显示：

- 当前 session id。
- 当前 session cwd。
- 最近 cwd 错误。
- 最近 cwd 错误保留 Codex 原始错误文本，不改写成中文解释。
- 本地诊断可以额外记录 source、access check 和 realpath 结果。

### 6. 谨慎支持历史 session cwd 修复

可以后续讨论新增一个显式修复能力，例如：

```text
/resume <session> --cwd <path>
```

或 TUI 中“用新 cwd 恢复历史 session”。但这会改变历史 session 后续 turn 的 workspace 和 sandbox writable root，必须有明确确认，不能静默迁移。

### 7. 远程环境适配放到后续

`environments` 和 `runtimeWorkspaceRoots` 是新协议方向，但当前微信/飞书本地桥接不需要马上发送这些字段。

后续如果要支持 remote code-mode host，需要把 `Channel route -> Codex session -> environment selection -> workspace roots` 建成显式模型，不能只靠单个本机 cwd 字符串，也不能对远程 cwd 做本机文件系统预检。

## 后续判断顺序

1. 已实现：收到 `invalid cwd` 后记录请求 cwd、继承 cwd、原始错误和请求来源；聊天侧保留原始错误，且不重试。
2. 收集实际发生时的 `/status` 与终端诊断记录，确认失败的是请求 cwd、继承 cwd，还是两者都正常但 Codex 侧仍拒绝。
3. 仅当继承 cwd 是问题时，再评估为 app-server 增加显式 `spawnCwd`，并覆盖启动、重启和相对路径行为测试。
4. 若请求中的历史 session cwd 是问题，优先恢复挂载/权限；无法恢复时由用户显式创建或切换到新 session，不静默迁移旧 session。
5. 不做静默 cwd 回退、自动 session 重建或失败 turn 自动重试；是否提供显式历史 session cwd 修复命令另行设计。

## 判断口径

遇到这类错误时，优先按下面顺序判断：

1. Chat-Codex 启动目录是否可访问。
2. Codex app-server 子进程继承的 cwd 是否可访问。
3. 当前绑定 session 的历史 cwd 是否可访问。
4. 目录是否在外置盘、iCloud、Desktop、Documents、Downloads 等 macOS 隐私敏感位置。
5. 是否最近更新了 Codex，触发了更严格的 cwd / environment 校验路径。

只要前四项有一项失败，就先修本地权限或 cwd。不要先改微信投递、审批、模型或 token 逻辑。
