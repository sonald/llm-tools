# ModelFiles 本地目录与 SSH 目录加载详细设计

## 1. 结论

ModelFiles 应继续是“只读、按需检查模型文件”的工具，不演变成模型下载器、文件管理器或 SSH 客户端。

推荐在 `RepositoryService` 内部增加一个真实的读取 seam：

```swift
protocol RepositoryAccess: Sendable {
    var location: RepositoryLocation { get }

    func loadSnapshot() async throws -> RepositorySnapshot
    func read(
        _ file: RepositoryFile,
        range: ClosedRange<UInt64>?
    ) async throws -> Data
}
```

四个生产 adapter 实现这个 interface：

- Hugging Face HTTP
- ModelScope HTTP
- 本地目录
- SSH 目录

`RepositoryService` 仍是 Store 唯一调用的 module，继续负责：

- 输入规范化和来源选择；
- 自动竞速 ModelScope / Hugging Face；
- 32 MiB 阅读上限；
- 权重文件锁定；
- SafeTensors / GGUF 的范围读取策略；
- Jinja、Imatrix 和普通文件的读取与检查；
- 对 UI 输出统一的 `RepositorySnapshot` 与 `InspectionDocument`。

这样新增来源不会把来源判断扩散到解析器和 View，现有格式检查逻辑也不需要复制。

SSH 首版调用系统 `/usr/bin/ssh`，使用用户已有的 OpenSSH 配置、ssh-agent、known_hosts、ProxyJump 和 ControlMaster。应用不增加 SSH 依赖，不收集密码，不保存私钥。

## 2. 目标与非目标

### 2.1 目标

1. 可以递归打开一个本地模型目录。
2. 可以通过 SSH 打开远程服务器上的一个模型目录。
3. 本地和 SSH 来源具有与 Hub 来源一致的文件分类、搜索和专用阅读器。
4. 普通文件仍只在选中后读取，最多 32 MiB。
5. SafeTensors 只读取 8-byte 长度和 JSON Header。
6. GGUF 只读取完成 metadata 与 tensor 目录所需的前缀，最多 32 MiB。
7. PyTorch、ONNX 等不可检查权重继续保持锁定，任何来源都不得完整读取。
8. 切换仓库或文件时，进行中的本地读取或 SSH 进程可取消，旧结果不得覆盖新选择。
9. Hub 的现有行为、历史记录和原生 macOS 交互不回退。

### 2.2 非目标

- 不加载模型或 tensor 数据。
- 不下载、上传、修改、删除或同步文件。
- 不提供远程目录浏览器；输入必须直接指向模型根目录。
- 不实现密码输入、私钥导入、主机密钥管理或 SSH 配置编辑。
- 不实现 SFTP、连接池或应用自管的 SSH ControlMaster。
- 不跟随目录中的符号链接。
- 不为本地或 SSH Markdown 加载相对图片；首版继续只允许现有 HTTPS 图片路径。
- 不把本地或 SSH 目录伪装成不可变版本。
- 不增加通用虚拟文件系统、插件注册表或动态 adapter 工厂。

## 3. 现有实现与需要调整的位置

当前数据流是：

```text
ContentView
  -> ModelFilesStore.openRepository()
      -> RepositoryService.loadRepository(input:)
          -> Hugging Face / ModelScope 清单
      -> RepositorySnapshot
  -> ModelFilesStore.loadSelectedFile()
      -> RepositoryService.inspectFile(_:from:)
          -> URLSession 全文或 HTTP Range
          -> InspectionDocument
  -> DetailView
```

现有结构有四个与“只支持 Hub”绑定的假设：

1. 输入框只接受 Hub 模型 ID 或 URL，不能识别本地与 SSH 位置。
2. `RepositorySnapshot` 必须有 `modelID`、Hub `source` 和 revision。
3. `RemoteFile` 假设每个文件都有 revision，并携带当前 UI 不使用的 `isLFS`。
4. `inspectFile` 通过 `contentURL` 读取，Range 只能走 HTTP。

格式分类和检查本身没有绑定 Hub，应原样复用：

- `FileClassifier`
- `SafetensorsInspector`
- `GGUFInspector`
- `IMatrixInspector`
- `TokenizerInspector`
- `TemplateRenderer`
- `InspectionDocument`

## 4. 方案比较

### 4.1 方案 A：继续在 `RepositoryService` 中增加来源 switch

做法是在列清单、全文读取、Range 读取、外部打开等每个位置分别增加 `.local` 和 `.ssh` 分支。

优点是首个 diff 最短。缺点是来源判断会至少出现四次，SafeTensors 和 GGUF 的读取策略容易与传输细节交织；以后修正短读、取消或文件变化时必须改多个分支。

不采用。它减少的是首日代码，不减少完整实现和后续维护成本。

### 4.2 方案 B：内部 `RepositoryAccess` seam

`RepositoryService` 面向统一的“列文件 + 全文/范围读取”interface，四种来源各自实现 adapter。interface 不暴露认证、URL、文件句柄或 `Process`。

优点：

- 格式检查只有一份；
- 每个 adapter 只处理自己的 I/O 与错误；
- Range 的“精确返回指定字节数”成为统一合同；
- Store 和 View 不知道 SSH 命令或本地文件句柄；
- 本地临时目录和假的进程输出可以覆盖主要测试面。

采用此方案。已有四个真实生产 adapter，这个 seam 不是为未来预留的抽象。

### 4.3 方案 C：引入 SSH/SFTP SDK 和通用虚拟文件系统

例如增加 SSH 库、连接 session、凭据存储、host key UI，再统一为 VFS。

不采用。它会同时引入依赖、认证生命周期、连接状态和新的安全面，而当前任务只需要只读列目录与范围读取。只有系统 SSH 无法满足明确需求时再升级，见第 17 节。

## 5. 领域模型

### 5.1 来源识别

界面不保留来源 Picker。`RepositoryService.loadRepository(input:)` 在一个入口按明确前缀识别：

1. `/` 开头的绝对路径或 `file://` URL：本地目录；
2. `ssh://` 开头：SSH 目录；
3. 其他输入：沿用原有自动模式，并行尝试 ModelScope 与 Hugging Face。

不猜测相对路径、`~/path` 或 `host:/path`。这些形式继续报输入错误，避免把模糊文本解释为文件系统或远程命令。

### 5.2 已解析位置

删除仅能表达 Hub 的 `RepositorySource`，用一个可携带真实寻址信息的 enum 替代：

```swift
enum RepositoryLocation: Hashable, Sendable {
    case huggingFace(modelID: String)
    case modelScope(modelID: String)
    case local(root: URL)
    case ssh(SSHLocation)
}

struct SSHLocation: Hashable, Sendable {
    let user: String?
    let host: String
    let port: Int?
    let rootPath: String
}
```

`RepositoryLocation` 提供少量 computed properties：

- `title`：`Hugging Face`、`ModelScope`、`本地`、`SSH host`；
- `canonicalInput`：成功打开后回填输入框和历史记录。

不增加 `RepositoryLocationProtocol` 或来源注册表。这个 enum 是 UI 状态与已解析输入必须共享的有限事实集合。

### 5.3 SSH URI 合同

SSH 来源只接受一种明确格式：

```text
ssh://[user@]host[:port]/absolute/model/path
```

示例：

```text
ssh://gpu-box/data/models/Qwen3-4B
ssh://alice@gpu.example.com:2222/srv/models/Llama-3
```

规则：

- 必须是 `ssh` scheme；
- host 必填，不允许以 `-` 开头；
- user 可选；
- port 可选，范围为 `1...65535`；
- path 必须为绝对路径；
- path 按 URL percent-decoding 后使用，因此空格等字符可表达；
- 拒绝 password、query、fragment、NUL 和控制字符；
- 首版不接受 `host:/path`、相对路径和 `~/path`，避免歧义与额外 shell 语义；
- SSH config alias 可以作为 host 使用。

密码禁止出现在 URI 中，避免进入 UserDefaults、日志或错误信息。

### 5.4 文件与快照

`RemoteFile` 改名为 `RepositoryFile`，因为文件不再必然是远程文件：

```swift
struct RepositoryFile: Identifiable, Hashable, Sendable {
    let path: String                 // 相对模型根目录
    let size: Int64?
    let revision: String?            // 仅 Hub 内容寻址需要
    let contentHash: String?
    let category: FileCategory
}
```

删除 `isLFS`。当前代码只在构造时赋值，没有行为依赖它；是否允许读取已经由 `category`、`structuredInspectionFormat` 和 `isBlocked` 决定。

快照改为：

```swift
enum RepositoryVersion: Sendable {
    case immutable(label: String)
    case live
}

struct RepositorySnapshot: Sendable {
    let location: RepositoryLocation
    let version: RepositoryVersion
    let files: [RepositoryFile]
}
```

Hub 使用 commit revision。Local / SSH 使用 `.live`，UI 显示“实时目录”，不显示伪造的 branch 或 SHA。

本地与 SSH 的清单只代表打开时刻。应用不计算目录 hash，因为这会读取权重并破坏 lazy-load 承诺。

## 6. Module 与 Interface

### 6.1 `RepositoryService`：外部 Interface

Store 只依赖两个主要方法：

```swift
struct RepositoryService: Sendable {
    func loadRepository(input: String) async throws -> RepositorySnapshot

    func inspectFile(
        _ file: RepositoryFile,
        from snapshot: RepositorySnapshot
    ) async throws -> InspectionDocument
}
```

辅助查询保持很小：

```swift
func browserURL(
    for file: RepositoryFile,
    in snapshot: RepositorySnapshot
) -> URL?

func markdownBaseURL(
    for file: RepositoryFile,
    in snapshot: RepositorySnapshot
) -> URL?
```

`markdownBaseURL` 只为 Hub 返回 HTTPS URL。本地和 SSH 返回 `nil`，避免 Markdown 间接读取模型目录外的本地文件或引入第二套 SSH 图片加载流程。

### 6.2 `RepositoryAccess`：内部 seam

```swift
protocol RepositoryAccess: Sendable {
    var location: RepositoryLocation { get }

    func loadSnapshot() async throws -> RepositorySnapshot
    func read(
        _ file: RepositoryFile,
        range: ClosedRange<UInt64>?
    ) async throws -> Data
}
```

合同：

- `range == nil` 表示读取完整文件；调用前 `RepositoryService` 先执行 32 MiB 与权重锁定检查；
- 非空 range 必须返回恰好对应长度的数据，不能静默短读；
- adapter 不解析文件格式；
- adapter 不缓存 `InspectionDocument`；
- 路径只能来自该 adapter 返回的清单，并在每次读取前再次校验；
- 所有方法响应 Swift Task 取消；
- 任何 adapter 都不得跟随清单中的符号链接。

`RepositoryService` 根据 `RepositoryLocation` 创建 adapter。自动模式并行创建 ModelScope 与 Hugging Face adapter，首个成功快照获胜；已打开快照总是保存已解析的具体 location，因此后续读取不会再次自动竞速。

为测试范围读取和取消行为，`RepositoryService` 的 internal initializer 接受一个 `@Sendable (RepositoryLocation) -> any RepositoryAccess` 闭包，默认值创建生产 adapter。测试注入 recording adapter；不再为这个单一用途增加 `RepositoryAccessFactory` 类型。

### 6.3 格式检查保持单份

`inspectFile` 的分派不变，只把 `URLSession` 读取替换为 `RepositoryAccess.read`：

```text
RepositoryFile
  -> structuredInspectionFormat
      safetensors -> read 0...7 -> validate length -> read exact header
      gguf        -> read successive 1 MiB ranges until directory complete
      imatrix     -> read full file <= 32 MiB
      jinja       -> read full file <= 32 MiB and require UTF-8
      generic     -> reject blocked weight, read full file <= 32 MiB
```

由此，权重安全规则与解析行为不因来源改变。

## 7. Hub adapter

Hugging Face 和 ModelScope 继续使用 `URLSession` 与现有 JSON 结构：

- `loadSnapshot()` 调用现有 metadata endpoint；
- `read(range: nil)` 执行普通 GET；
- `read(range:)` 使用现有 `HTTPRangeLoader`；
- Range 仍必须返回 HTTP `206`，绝不因源站忽略 Range 而退回完整权重下载；
- commit / revision 填入 `.immutable`；
- `browserURL` 与 Markdown HTTPS base URL 保持现有行为。

这一阶段只移动代码到 adapter 之后，不改变网络请求、超时和源站选择语义。

## 8. 本地目录 adapter

### 8.1 打开与列清单

`LocalDirectoryAccess` 使用 Foundation：

1. 规范化根 URL，要求是已存在且可读的目录。
2. 用 `FileManager.DirectoryEnumerator` 递归遍历。
3. 不使用 `.skipsHiddenFiles`，保留 `.gitattributes` 等模型仓库文件。
4. 只保留 regular file；目录和符号链接不进入清单。
5. 读取文件大小，不读取文件内容，不计算 hash。
6. 将路径转换为相对根目录、使用 `/` 分隔的规范路径。
7. 通过现有 `FileClassifier` 分类，再使用现有排序规则排序。

遍历在后台执行，不继承 `@MainActor`。每处理一批条目检查 Task 取消。

### 8.2 路径安全

每次读取前：

- 拒绝绝对 `file.path`；
- 拒绝 `.`、`..` 和空路径分量；
- 将相对路径追加到根 URL；
- 解析符号链接后确认结果仍位于规范根路径内；
- 再次要求目标是 regular file 且不是符号链接。

本地目录由用户主动选择，首版不引入 `openat` / `O_NOFOLLOW` 文件描述符树。若未来要读取不受信任进程可并发修改的目录，再升级为基于目录 fd 的严格遍历。

### 8.3 全文与范围读取

- 全文：在后台用 `FileHandle` 读取，读取前后都执行大小上限校验；
- Range：`seek(toOffset:)` 后读取要求的字节数；
- 若实际大小与清单大小不同，抛出 `fileChanged`，提示刷新目录；
- 若返回字节数不足，抛出 `shortRead`；
- 读取后检查取消，取消结果不进入 Store 缓存。

不使用 memory mapping 读取完整权重；被锁定文件只能通过 SafeTensors / GGUF 的范围读取路径进入 adapter。

## 9. SSH 目录 adapter

### 9.1 为什么使用系统 SSH

macOS 没有适合当前 SwiftPM 工具直接使用的原生 SSH 文件 interface。调用 `/usr/bin/ssh` 可以立即复用：

- `~/.ssh/config` 中的 Host、IdentityFile、ProxyJump 等配置；
- ssh-agent 与钥匙串中的密钥；
- 用户的 known_hosts 决策；
- 用户自行配置的 ControlMaster 连接复用。

应用不需要拥有凭据和 host key 状态，安全面最小。

### 9.2 进程参数

本地进程固定为 `/usr/bin/ssh`，不从 `PATH` 搜索。基础参数：

```text
/usr/bin/ssh
  -T
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=2
  [-p port]
  [-l user]
  host
  /bin/sh -s -- 'absolute root'
```

约束：

- `BatchMode=yes` 禁止在无 TTY 的 GUI 进程中卡住等待密码；
- 不设置 `StrictHostKeyChecking=no`，不自动信任新主机；
- user、host、port 独立作为本地 argv 传递，host 拒绝 option-like 值；
- 远端 root path 用标准单引号 shell quoting，且输入解析已拒绝控制字符；
- 远端命令脚本从 stdin 发送，不把文件名拼成未引用 shell 代码；
- stdout 仅承载机器可解析的清单或文件二进制，stderr 单独收集。

第一次连接或密码认证失败时，UI 提示用户先在 Terminal 中完成 `ssh` 登录/known_hosts 建立，应用自身不弹凭据框。

### 9.3 远程清单协议

远端只依赖 `/bin/sh`、`find`、`wc` 和 `printf`。脚本：

1. 验证 root 是可读目录；
2. `find -P` 递归列出 regular file，不跟随符号链接；
3. 对每个文件使用 `wc -c` 取得大小；
4. 输出重复的 NUL 分隔记录：`relativePath\0decimalSize\0`。

选择 NUL 而不是按行协议，因为合法文件名可以包含空格、引号和换行。文件名不能包含 NUL，因此协议无转义歧义。

本地解析器必须：

- 要求字段成对且 UTF-8 有效；
- 要求 size 是非负 `Int64`；
- 拒绝绝对路径、空路径和任何 `..` 分量；
- 保留 Unicode、空格和普通标点；
- 使用 `FileClassifier` 分类并统一排序。

### 9.4 远程读取协议

每次选择文件启动一个短生命周期 SSH 命令。读取前，远端脚本用 `wc -c` 对比清单中的预期大小；不一致时返回专用退出码，UI 提示刷新。

全文读取：

- 仅在 Service 已确认文件不被锁定且清单大小不超过 32 MiB 后执行；
- 用 `dd` 把文件写到 stdout；
- 本地仍校验最终字节数与上限。

Range 读取：

- 使用固定 64 KiB block 的 `dd`，按 block 对齐到目标 offset 之前；
- 最多多读 65,535 bytes；
- 本地丢弃对齐前缀并裁剪到精确 range；
- 少于所需字节时失败。

不使用 `dd bs=1`，避免读取 MiB 级 GGUF 前缀时产生逐字节 I/O。offset、count 和 block 数都在本地从已校验整数计算，只以十进制参数传给脚本。

### 9.5 进程生命周期

内部增加一个小型 `SSHProcessRunner`，只负责运行固定 `/usr/bin/ssh`：

- 同时 drain stdout 与 stderr，避免 pipe buffer 造成死锁；
- 清单 stdout 上限 32 MiB；
- 文件读取 stdout 上限为请求大小加一个 64 KiB 对齐块；
- stderr 最多保留前 8 KiB 用于错误显示；
- Task 取消时对 `Process` 调用 `terminate()` 并等待退出；
- 只有退出码为 0 且输出合同满足时返回数据；
- 错误中不回显 URI password，因为解析阶段已禁止 password。

首版每次清单或文件读取使用一个 SSH 进程，不增加应用内连接池。若用户配置了 ControlMaster，OpenSSH 自行复用连接。

## 10. 资源与安全上限

现有 32 MiB 内容上限继续适用于所有来源，并补充清单上限：

| 项目 | 上限 | 行为 |
| --- | ---: | --- |
| 普通文件 / Jinja / Imatrix 全文 | 32 MiB | 超限不读取 |
| SafeTensors Header | 现有 inspector 上限 | 超限终止，不读 tensor 数据 |
| GGUF metadata 前缀 | 32 MiB | 超限终止 |
| 单次清单文件数 | 100,000 | 终止并提示缩小目录 |
| 单次 SSH 清单输出 | 32 MiB | 终止 SSH 进程 |
| SSH stderr 展示 | 8 KiB | 截断并标记 |
| 单个相对路径 UTF-8 长度 | 4 KiB | 拒绝该清单 |

这些限制在 `RepositoryService` 或共享清单校验中统一执行，不由 View 实现。

所有来源继续执行以下安全规则：

- 文件身份由相对路径分类；
- 被锁定权重不能进入全文读取；
- SafeTensors / GGUF 只能请求检查器要求的范围；
- 解析器限制和整数溢出检查保持现状；
- 不执行仓库中的代码、模板命令或模型配置；
- 不根据文件内容发起新的 SSH 或本地路径读取。

## 11. 状态、缓存与一致性

`ModelFilesStore` 的缓存仍是：

```swift
[String: InspectionDocument]
```

key 继续使用相对路径，因为切换 location 时会整体清空缓存。

状态规则：

1. 打开新 location 时取消旧清单和文件任务，清空 snapshot、选择和缓存。
2. 成功后回填 `location.canonicalInput`。
3. 自动选择 `config.json` 或第一个未锁定文件并按需读取。
4. 文件切换取消旧读取；只有当前 task 的成功结果进入缓存。
5. local / SSH 文件大小变化时不使用旧内容，报错并提供“刷新目录”。
6. local / SSH 同大小内容变化无法在不额外读取/散列权重的情况下可靠检测；UI 用“实时目录”明确这一语义。
7. 不做磁盘内容缓存、SSH 文件缓存或跨启动缓存。

不增加 watcher。只有用户实际需要自动刷新本地目录时，再考虑 FSEvents；SSH 则没有同等简单可靠的跨平台 watcher。

## 12. 历史记录与持久化

历史只需要保存成功打开后的规范输入。来源可以由输入稳定推导，不再持久化重复状态：

```swift
struct RepositoryHistoryEntry: Codable, Hashable, Sendable {
    let input: String
}
```

规则：

- 仅成功打开后写入历史；
- 持久化 canonical input；
- Hub input 沿用现有大小写不敏感去重；local / SSH 路径按精确 canonical input 去重，避免合并大小写敏感文件系统中的不同目录；
- 从下拉列表选择历史时只恢复 input，打开时重新识别来源；
- 旧 `ModelFiles.modelHistory` 字符串数组与含 `selection` 的 v2 JSON 都只迁移 input；
- 旧 `ModelFiles.lastModelID` 作为新 last input 的一次性 fallback；
- 新数据使用版本化 key，例如 `ModelFiles.repositoryHistory.v2`；
- SSH URI 禁止 password，因此历史中只含 user、host、port 和 path；
- 不保存 SSH 环境变量、私钥路径、passphrase 或 stderr。

`modelID` / `modelHistory` 属性重命名为 `repositoryInput` / `repositoryHistory`，避免继续传播只支持 Hub 的命名。

## 13. UI 设计

### 13.1 顶部工具栏

移除来源 Picker，保留一个更宽的历史输入框：

```text
模型 ID、仓库 URL、本地路径或 ssh:// 地址…  [选择文件夹] [打开]
```

输入框获得焦点时用一个紧凑的原生提示列出模型仓库、本地目录和 SSH 目录三种格式；它只解释格式，不改变识别规则，也不增加设置项。

本地“选择文件夹”使用 `NSOpenPanel`，只允许选择一个目录。选择后写入标准化路径，仍由用户点击“打开”或按 Return 执行。

当前 app bundle 没有启用 App Sandbox，因此首版保存普通路径，不增加 security-scoped bookmark。若发布方式改为 sandbox，再按第 19 节的触发条件升级本地授权持久化。

应用启动时按输入格式判断：

- Hub 输入可保持现有自动打开行为；
- 上次输入是 local / SSH 时只恢复输入，不自动读取或连接；
- 尤其不允许仅因启动应用就执行 SSH 命令。

### 13.2 状态与文件身份

状态文案按位置显示：

```text
Hugging Face · main · SHA abc1234
ModelScope · master · SHA abc1234
本地 · 实时目录
SSH gpu-box · 实时目录
```

详情标题不再假设每个来源都有 branch/SHA。`RepositoryVersion` 决定版本文案。

“在源站打开”按来源处理：

- Hub：保留浏览器打开当前 revision；
- local：改为 Finder 中显示当前文件；
- SSH：首版隐藏该按钮；复制路径仍复制相对路径。

不增加泛化的“外部动作”命令框架；View 根据有限的 location enum 分支即可。

### 13.3 错误与恢复

错误分两层：

- 打开错误：输入无效、目录不存在、SSH 认证/known_hosts、清单超限；
- 文件错误：权限、文件变化、短读、格式无效、超出安全预算。

用户可执行的恢复：

- 输入错误：保留输入并聚焦字段；
- SSH exit 255：提示先在 Terminal 验证该 host；
- 文件变化：按钮文案为“刷新目录”；
- 其他文件读取错误：保留“重试”；
- 取消：不显示错误。

不依赖 SSH stderr 的本地化文本做复杂错误分类。稳定的本地校验错误使用专用 case；远端失败显示退出码和截断后的 stderr。

## 14. 错误模型

`RepositoryService.ServiceError` 保留现有格式与 HTTP 错误，增加：

```swift
case invalidLocalDirectory
case invalidSSHLocation
case directoryNotReadable
case tooManyFiles(limit: Int)
case listingTooLarge
case unsafePath(String)
case fileChanged(String)
case shortRead(expected: Int, actual: Int)
case sshUnavailable
case sshFailed(exitCode: Int32, message: String)
```

`invalidModelID` 继续专用于 Hub。UI 不再把所有错误都描述为“源站”错误，统一使用“位置”或具体来源。

不要为每种 OpenSSH stderr 建立一组脆弱的 enum。只有应用能可靠判断的状态才建立类型。

## 15. 并发与性能

- Store 的状态更新仍在 `@MainActor`。
- 本地目录遍历、文件读取和进程 pipe drain 不在主线程执行。
- 自动 Hub 竞速保持现状，local / SSH 不参加竞速。
- SSH 清单是一次远程进程；不能为每个文件单独执行 `stat` 往返。
- 文件点击产生一次 SSH 进程；SafeTensors 通常两次，GGUF 每个 1 MiB chunk 一次。
- 首版不实现 SSH session 复用。用户的 ControlMaster 可以消除大部分握手成本。

已知性能上限：GGUF 可能需要多个 SSH 往返。只有真实测量表明这成为问题时，才把“连续读取直到远端给定上限”合并为一次命令，或引入持久连接；首版优先保持与现有检查器相同的逐段停止语义。

## 16. 测试与验收

### 16.1 自动测试

输入解析：

- 现有 model ID 与两种 Hub URL 不回退；
- local 绝对路径和 `file://` 规范化；
- SSH user / host / port / percent-encoded path 规范化；
- 拒绝 SSH password、相对 path、非法 port、query、fragment、option-like host 和控制字符。

本地 adapter 使用临时目录：

- 递归列出嵌套、隐藏、Unicode 和带空格文件；
- 跳过目录和 symlink；
- 产生正确相对路径、大小、分类和排序；
- 全文读取与跨 block Range 精确；
- 拒绝 `..` 逃逸；
- 文件大小变化返回 `fileChanged`；
- 超过文件数和路径长度上限失败。

SSH 纯逻辑与进程测试：

- NUL 清单解析支持空格、换行、引号和 Unicode；
- 拒绝畸形 record、负数/溢出 size、绝对路径和 `..`；
- root shell quoting 覆盖空格与单引号；
- 参数构造不允许 host 注入 option；
- 假进程脚本验证 stdout/stderr 分离、输出上限、非零退出和取消；
- Range 对齐计算覆盖 0、block 边界、跨 block 和文件尾短读。

Service 行为：

- 同一份 SafeTensors fixture 经本地 adapter 仍只请求两段；
- GGUF 只读取完成检查所需前缀；
- blocked 权重不会调用全文 read；
- 32 MiB 上限在 adapter 调用前生效；
- history 迁移、来源恢复和去重正确。

前三项通过注入 recording `RepositoryAccess` 从 `RepositoryService` 的外部 interface 断言，不直接测试私有 HTTP、本地或 SSH 实现细节。

### 16.2 手工 SSH 验收

自动测试不依赖真实 SSH server。发布前用一个已配置 key 登录的 Linux host 验收：

1. `config.json`、README、tokenizer 文件可列出并打开；
2. 路径包含空格、单引号和 Unicode 时行为正确；
3. SafeTensors 只读取 Header；
4. GGUF 只读取 metadata 前缀；
5. PyTorch 权重无法打开；
6. 读取中切换文件能取消 SSH 进程且无旧结果覆盖；
7. 修改远端文件大小后读取提示刷新；
8. known_hosts 未建立、密钥无效和目录无权限时错误可理解；
9. 远端没有 `python` 时仍可工作；
10. `ps` 确认取消和关闭应用后没有遗留 ssh 子进程。

可选环境变量 `MODELFILES_SSH_TEST_URI` 只用于人工/CI 环境的集成测试入口；没有该变量时跳过，不把真实主机写进仓库。

### 16.3 回归命令

```bash
swift test --package-path tools/model-files
./tools/model-files/script/build_and_run.sh verify
```

还需在真实应用中检查：来源切换、文件夹选择、历史恢复、SSH 错误提示、文件快速切换和 Finder 打开。

## 17. 分阶段实现

### S1：模型与 Hub 无行为重构

- 引入 `RepositoryLocation`、`RepositoryVersion`、`RepositoryFile`；
- 删除 `RepositorySource`、`RemoteFile` 和未使用的 `isLFS`；
- 引入内部 `RepositoryAccess`；
- 把现有 Hugging Face / ModelScope 逻辑迁入 adapter；
- 所有现有测试和应用验证保持通过。

这是后续来源的 seam 验证。若 Hub 行为在此阶段发生变化，不继续叠加 local / SSH。

### S2：本地目录

- 增加 local 解析、清单和全文/Range 读取；
- 增加 NSOpenPanel 与 local 状态/外部动作；
- 增加临时目录测试；
- 验证 SafeTensors / GGUF 的本地按范围读取。

### S3：SSH 目录

- 增加 `SSHLocation`、清单协议、Range 读取和进程取消；
- 增加 SSH 错误与输出限制；
- 增加纯逻辑/假进程测试；
- 完成真实 Linux host 手工验收。

### S4：历史迁移与文案收口

- 历史升级为 `RepositoryHistoryEntry`；
- 迁移旧 UserDefaults；
- 更新“模型 ID / 源站 / 仓库原文”等只适用于 Hub 的 UI 文案；
- 完成全回归和真实应用检查。

## 18. 预计文件变更

优先控制在以下范围，不顺带重构阅读器：

```text
Sources/ModelFiles/Models/RepositoryModels.swift
Sources/ModelFiles/Services/RepositoryService.swift
Sources/ModelFiles/Services/DirectoryRepositoryAccess.swift   # 新增
Sources/ModelFiles/Stores/ModelFilesStore.swift
Sources/ModelFiles/Views/ContentView.swift
Sources/ModelFiles/Views/SidebarView.swift
Sources/ModelFiles/Views/DetailView.swift
Tests/ModelFilesTests/RepositoryAccessTests.swift              # 新增
Tests/ModelFilesTests/FileClassifierTests.swift
```

`DirectoryRepositoryAccess.swift` 包含 local、SSH 和私有 `SSHProcessRunner`。首版不再拆 `SSHClient`、`CommandBuilder`、`DirectoryScanner` 等浅 module；只有文件明显过大或出现第二个调用方时再拆。

## 19. 升级触发条件

以下需求出现前，不引入 SSH SDK：

- 必须支持密码交互或应用内密钥管理；
- App Sandbox / Mac App Store 成为发布要求；
- 必须在应用内管理 known_hosts；
- 单次操作需要大量随机 Range，进程/握手延迟已被测量为主要瓶颈；
- 需要上传、写回或持续目录监听；
- 必须支持没有 `/bin/sh`、`find`、`wc`、`dd` 的远端环境。

出现其中任一项时，再比较 NIOSSH/SFTP adapter。`RepositoryAccess` seam 可以容纳替换，不需要改变 Store、View 或格式检查器。

## 20. 完成定义

设计实现完成必须同时满足：

- Hub、本地、SSH 三类位置都能打开并显示统一文件清单；
- 文件格式分类和所有现有阅读器跨来源一致；
- 普通文件、SafeTensors、GGUF 分别遵守全文上限和范围读取规则；
- 不可检查权重在任何来源都没有读取路径；
- SSH 不保存密码/私钥，不绕过 host key 验证；
- local / SSH 明确显示“实时目录”，不伪装 revision；
- 取消、短读、文件变化和输出上限都有可执行恢复；
- 标准测试、bundle verify 和真实 SSH 手工清单全部通过。
