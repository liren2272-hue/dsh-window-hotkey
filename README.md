# dsh-window-hotkey

DeepSeek Harness 插件：一个全局快捷键（默认 `Ctrl+Alt+Q`），在「最小化」和「唤回并置前」之间切换主窗口。在任何程序里按都生效。

灵感来源于微信的Ctrl+Alt+W，个人用的很习惯，于是给DSH也实现一个类似的功能。

插件全部内容均来源于DSH，欢迎交流讨论。

> **仅限 Windows。** 依赖 Win32 API（全局热键、窗口管理）和系统自带的 .NET Framework 编译器，不支持 macOS / Linux。

## 安装

### 方式 A：pnpm / npm 安装（推荐）

```bash
# 在 DSH 的 profile 目录里执行（通常是 ~/.dsh/<profile>）
pnpm add @liren2272/dsh-hotkey
```

然后把插件加进配置补丁。编辑该 profile 的 `dsh-bundle.yaml`（或任意 cordis 配置补丁文件），追加：

```yaml
- insert:
    - id: window-hotkey
      name: '@liren2272/dsh-hotkey'
      config:
        enabled: true
        hotkey: ctrl+alt+q
        windowTitle: DeepSeek Harness
```

重启 DeepSeek Harness（或重新启停插件）后生效。

### 方式 B：本地目录安装

```bash
git clone https://github.com/liren2272-hue/dsh-window-hotkey.git
cd dsh-window-hotkey
# 无需构建，也无需安装依赖：插件是纯 ESM，运行时零第三方依赖
```

在 profile 的配置补丁里用绝对路径引用：

```yaml
- insert:
    - id: window-hotkey
      name: '/absolute/path/to/dsh-window-hotkey'
      config:
        enabled: true
        hotkey: ctrl+alt+q
```

### 从源码验证安装是否生效

启动后按一次快捷键，然后看助手日志（默认 `%TEMP%\dsh-hotkey\hotkey.log`）：

- 出现 `registered mods=0x0003 vk=0x51 id=1` —— 快捷键已抢到
- 出现 `toggle: ...` 行 —— 按键已被助手收到并执行

## 配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后不注册快捷键，也不启动助手进程 |
| `hotkey` | `"ctrl+alt+q"` | 组合键文本，见下方语法；改完需要重启宿主（或重新启停插件）生效 |
| `windowTitle` | `"DeepSeek Harness"` | 用来识别主窗口的标题后缀，与窗口类名 `Chrome_WidgetWin_1` 一起匹配 |
| `registerTimeoutMs` | `10000` | 快捷键被别的程序占用时，助手会在这个时间内反复重试，超时则放弃并记日志 |
| `logFile` | `<临时目录>/dsh-hotkey/hotkey.log` | 助手日志，默认 256KB 滚动截断 |
| `powershell` | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` | 助手使用的 PowerShell 可执行文件 |

### 组合键语法

`修饰键 + 一个按键`，用 `+` 连接，大小写和空格都无所谓。

- 修饰键：`ctrl` / `control`、`alt`、`shift`、`win` / `meta` / `super`，至少一个
- 按键：`a`–`z`、`0`–`9`、`f1`–`f24`、`space`、`tab`、`enter`、`esc`、`backspace`、`delete`、`insert`、`home`、`end`、`pageup`、`pagedown`、方向键 `up`/`down`/`left`/`right`、`numpad0`–`numpad9`

例：`ctrl+alt+q`、`alt+shift+f5`、`win+space`。只写修饰键、写两个普通键、或不写修饰键都会被拒绝，插件会在日志里说明原因。

## 工作原理

插件本身跑在宿主进程里，但它拿不到 Electron 的窗口对象（宿主以 `ELECTRON_RUN_AS_NODE` 方式运行），所以真正干活的是一个常驻的隐藏 PowerShell 助手：

1. 插件启动时把一段 C# 代码交给 PowerShell 编译运行，助手调用 `RegisterHotKey` 抢占全局快捷键，然后进入消息循环。
2. 收到 `WM_HOTKEY` 后，助手遍历顶层窗口，找出类名为 `Chrome_WidgetWin_1`、标题以 `windowTitle` 结尾的那个，按当前状态决定方向：
   - 已最小化 → 恢复并置前（`SC_RESTORE` + `AttachThreadInput`/`BringWindowToTop`/`SetForegroundWindow`）
   - 被隐藏 → 先显示再恢复
   - 正常显示 → 最小化（`SC_MINIMIZE`）
3. 用窗口消息（`SendMessageTimeoutW` + `WM_SYSCOMMAND`）而不是 `ShowWindow`，因为跨完整性级别时后者会被系统直接拒绝（`ERROR_ACCESS_DENIED`）。
4. 宿主退出后助手会在约 2 秒内自己退出；快捷键被别的程序占用时会重试，超时后在日志里写一条明确的冲突记录。

代价是一个常驻的隐藏 `powershell.exe` 进程（约几十 MB）。这是不安装任何原生依赖、也不改动 DSH 安装目录的前提下最稳的做法。

## 故障排查

- **按键没反应**：先看 `%TEMP%\dsh-hotkey\hotkey.log`。`registered` 说明已抢到键；`register failed … error=1409` 说明组合被别的程序占了（常见于输入法、显卡驱动面板、微信/QQ 截图），换一个组合即可。
- **按键有反应但不动窗口**：日志里会有 `toggle: no window matched`，通常是主窗口标题不含 `windowTitle`，调整配置里的后缀。
- **唤回后没有聚焦**：Windows 限制后台进程抢前台，助手会重试一次；仍有问题可先把窗口最小化（而不是隐藏）再唤回。
- 改了配置后需要让插件重新加载（启停插件或重启 DSH），快捷键才会重新注册。

## 开发与测试

`test/` 下是可移植的本地验证脚本。宿主进程是 Electron under `ELECTRON_RUN_AS_NODE`，所以运行方式取决于环境：

**如果 PATH 里有 Node（>= 22.19）：**

```bash
npm test           # 组合键解析单测，结果写到 test/parse-results.txt
npm run gen        # 渲染助手脚本到 test/generated-helper.ps1，方便检查生成的源码
```

**如果只用 DSH 自带的 Node：**

```bash
# Windows PowerShell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'C:\Program Files\Deepseek\DeepSeek Harness.exe' test/parse.test.mjs
Get-Content test/parse-results.txt
```

`plugin-smoke.mjs` 会用桩 context 加载真实插件入口（`apply → spawn helper → read helper log`），
约 6 秒后把结果写进 `test/smoke-results.txt`：

```bash
node test/plugin-smoke.mjs && cat test/smoke-results.txt
```

注意：smoke 测试会真的注册一次全局快捷键并拉起 PowerShell 助手，跑完即清理。
如果 `ctrl+alt+q` 已被占用，助手日志里会出现 `register failed`，那是预期行为而非测试失败。

## 目录结构

```
index.js            插件入口：apply()、配置合并、宿主侧日志回读
hotkey.js           Win32 侧：组合键解析、C# 助手源码、进程拉起与清理
cordis.patch.yml    cordis 配置补丁：把插件插进 profile
icon.svg            插件图标
locale/             插件在 DSH 设置界面显示的名称与描述（en / zh）
test/               可移植的本地验证脚本
```

## License

[MIT](./LICENSE)
