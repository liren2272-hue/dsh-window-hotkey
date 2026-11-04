# dsh-window-hotkey

用全局快捷键开关 DeepSeek Harness 窗口（默认 `Ctrl+Alt+Q`），无论应用是否在前台。
**改键直接在「通用设置 → 通用快捷键」里改，改完立刻生效。**

## 两个半边

| 半边 | 文件 | 作用 |
| --- | --- | --- |
| Host | `index.js` + `hotkey.js` | 起一个 PowerShell helper，用 Win32 `RegisterHotKey` 注册系统级热键，按键时最小化 / 还原 / 从隐藏唤醒窗口 |
| Client | `client.js` | 把命令注册进「通用设置 → 通用快捷键」，让这一项在 UI 里可见、可改键 |

Host 进程是 `ELECTRON_RUN_AS_NODE` 启动的，没有 BrowserWindow，也没有任何宿主服务暴露窗口句柄，
所以窗口只能经 Win32 直接驱动。helper 子进程故意不 detached，生命周期由脚本内的 `WatchParent`
线程盯住宿主 pid：宿主一死，helper 立刻注销热键并退出，不会留下占着热键的僵尸进程。

## 改键是怎么生效的

快捷键面板是 Electron 自己的编辑器，它只写 `keybindings.json`、只移动**应用内** binding；
真正的系统级热键由 helper 进程持有。两条链路本来互不相通，所以这里做了桥接，**两条路都通**：

1. **快路** — `client.js` 订阅 `shortcuts.catalog`，面板一改就 `POST /dsh-window-hotkey/bind`，
   Host 立刻换 helper 并回 `{ok, hotkey, label}`；机器抢不到该组合时返回 409，
   Client 用 `shortcuts.edit()` 把面板那一行改回实际注册的键（面板不会显示一个假键）。
2. **兜底** — Host 每 1 秒重读一次 `keybindings.json`（`%APPDATA%\@deepseek-ai\dsh-desktop\keybindings.json`）。
   即使页面还挂着旧 bundle、或你手改了文件，改键照样生效。

改完的选择缓存进 `hotkey-state.json`（插件目录内），重启后仍用这个键，不会被 `cordis.patch.yml` 覆盖。
在面板里清空这一行 = 主动解绑，会缓存成 `null`，重启也不会复活默认键。

两键和弦（如 `Ctrl+K Ctrl+S`）无法用 `RegisterHotKey` 表达，会被跳过并保持原注册不动。

## 关闭（不退出）后按热键为什么能活过来

点窗口 X 走的是 Electron 的 `window.hide()`，不是 Win32 隐藏，进程还在。纯 Win32
`ShowWindowAsync(SW_SHOW)` 只能让 HWND 变可见，Electron 主进程并不知道窗口"已显示"，
Chromium 的输入路由没被唤醒 —— 画面完整但点哪都没反应（就是之前那个"静态死页面"）。

所以隐藏分支改成 `WakeViaSecondInstance()`：再启动一次本 app 的 exe，让 Electron 自己走
`second-instance` → `focusPrimaryWindow()` → `window.show()` 把渲染进程真正唤醒。
启动前必须从环境里移除 `ELECTRON_RUN_AS_NODE`，否则新进程会跑成 node、拿不到单实例锁。

## 配置

`cordis.patch.yml` 里：

```yaml
config:
  enabled: true
  hotkey: ctrl+alt+q
  windowTitle: DeepSeek Harness
```

- `enabled` — `false` 时完全不加载 helper。
- `hotkey` — 首次启动用的组合（`ctrl` / `alt` / `shift` / `win` 加一个主键：字母、数字、`F1`–`F24` 或具名键）。
  一旦在面板里改过，以 `hotkey-state.json` 为准。
- `windowTitle` — 按标题**后缀**匹配窗口；应用标题形如 `会话名 — DeepSeek Harness`，后缀匹配能命中。

## 排障

`%LOCALAPPDATA%\Temp\dsh-hotkey\hotkey.log` 记录每次注册与开关：

```
[plugin] helper started pid=21184 hotkey=Ctrl+Alt+E
registered mods=0x3 vk=0x45 id=1
minimize hwnd=0x00040532 sent=True iconic=True
restore (was hidden) hwnd=0x00040532 woken=True
```

`registered mods=… vk=…` 出现 = 热键真的拿到手了；`register failed after … error=1409` = 被别的程序占着。

`resolve()` 故意是空操作：窗口获得焦点时系统已经把按键交给了 helper，应用内再执行一次会连开关两下。
