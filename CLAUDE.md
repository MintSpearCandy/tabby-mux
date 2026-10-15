# tabby-mux

tmux 架构复刻插件（Session-Window-Pane）。宿主源码参考：`D:\Home\Project\TabbySuite\reference\tabby`（v1.0.237，与隔离实例同版）。通用调试方法论见用户级 skill `tabby-debug`（本机环境快照在其 ENVIRONMENT.md）。

## 布局

```
src/
  index.ts            NgModule 入口（4 个 multi provider：Config/Hotkey/Command/ToolbarButton）
  configProvider.ts   defaults：mux.* 配置 + hotkeys.mux.* 子树（必须声明，否则用户绑定被 ConfigProxy 丢弃）
  commands.ts         MUX_COMMANDS 命令表（id/labelKey/needs*/run）——palette、热键描述、热键分发共用
  mux.service.ts      核心服务：session/window 注册表 + 所有操作（debug 句柄 window.tabbyMux）
  statusbar.service.ts 底部状态栏（DOM 注入式，无宿主扩展点可用）
  hotkeys.ts          HotkeyProvider（35 个 mux.* 热键描述）
  toolbar.ts          工具栏按钮 —— 同时是 MuxService 的保底实例化钩子
  i18n.ts             en/zh 双语（LocaleService；禁 @ngx-translate/core）
  types.ts            MuxSession/MuxWindow/MuxSettings
scripts/
  smokeLoad.js        无 GUI 加载自检（Module._load stub，tabby-core 用 strictProxy）
  updateDebugCfg.js   部署 dist 子目录 + package.json 到实例（默认 instances\mux）
  cdpEval.js/cdpConsole.js  CDP 求值 / console 抓取（CDP_PORT 默认 9242）
```

## 概念映射（一期定案）

- session = 插件侧逻辑分组；window = 顶层 `SplitTabComponent`（**v1.0.237 起在 tabby-core**，不在 tabby-terminal）；pane = SplitTab 子 tab，**不做插件侧包装**，布局/焦点/resize 全部委托原生引擎（`addTab/splitTab/navigate/navigateLinear/maximize/equalize/resizePane/layout` + `tabAdded$/tabRemoved$/focusChanged$/initialized$`）。
- 本地终端组件在 tabby-local（`TerminalTabComponent`），但插件经 `ProfilesService.newTabParametersForProfile()` 拿 `NewTabParameters`，**无需 import** tabby-local。
- npm typings 锁 `1.0.231-nightly.0`：与 1.0.237 宿主有个别漂移（如 `setCustomTitle` 缺失）——已用 `(tab as any)` + 注释处理，新 API 先查 typings。

## 会话附着/隔离机制（2026-10-16 实测验证）

tmux attach 语义的落地（`mux.isolatedSessions`，默认开）：

- **软移除**：`app.removeTab(tab)` **不销毁 tab**——tab-body 的 `ngOnDestroy` 只 `placeholder.detach()`（tabBody.component.ts），组件/终端会话/xterm 全部存活；且此路径**不发射 `tabRemoved$`**（它只在 destroyed$ 链上发射），插件注册表天然无需清理。
- **恢复**：`app.addTabRaw(tab)` → `*ngFor` 新建 tab-body → `ngOnChanges` `setImmediate` 后 `placeholder.insert(tab.hostView)` 重插视图 → xterm ResizeObserver 自动 refit。
- 附着不变式：隔离模式下 `attachedSessionId` 唯一；`applyIsolationSetting()`（boot + config.changed$）做 reconcile——**混合→隔离切换必须撤下所有非 keep 会话的已列出窗口**（只处理 attached 会话不够，2026-10-16 实测踩过）。
- 后台会话不在 app.tabs → **不进 Tabby 崩溃恢复快照**（重启即失，README 已注明）。
- detached 窗口的 kill 走 `canClose() + tab.destroy()` 直连（closeTab 只认已列出 tab）；destroy → destroyed$ → addTabRaw 的订阅 → tabRemoved$ → 注册表自清。

## 已验证的平台坑（2026-10-16 实测，别再踩）

1. **type-only import 不能出现在构造器参数类型里**：`constructor (private x: SomeService)` + `import type` → `emitDecoratorMetadata` 写入 `Function` 作为 token → Angular 注入字面量 `Function` → `NullInjectorError: No provider for Function!` → **整个 bootstrap 失败**（宿主降级重启后本插件消失、其余插件正常——极具迷惑性）。服务依赖一律 `Injector + 运行时 get()`。
2. **ASI 陷阱**：以 `(` 开头的语句（如 `(window as any).x = this`）会链到上一条无分号语句的调用上——用局部变量中转。
3. **`wrapAndAddTab` 不同步 await 内部 `addTab`**，且 `add()` 内部 `await initialized$.toPromise()`（ngAfterViewInit 触发）：新窗口的 `getFocusedTab()` 在视图初始化前是 null；**Angular Zone 外调用（CDP）时 ngAfterViewInit 无人触发，add() 可挂到下一次 zone 活动（最长 ~30s recovery 定时器）**。真实用户路径（热键/palette/工具栏）全在 zone 内，无此问题。**CDP 测试必须每步后派发 F13 keydown 戳 zone**。
4. **`addTabRaw` 在 `registerWindow` 之前发射 activeTabChange$**：窗口注册时若 `app.activeTab === tab` 必须手动同步 `currentWindowIndex`（否则索引永久 desync）——见 `registerWindow` 内注释。
5. **原生 `splitTab()`（duplicate 式）在终端 session 未初始化完时返回 null**（recovery token 未就绪）：splitPane 已做同 profile 新建终端的回退（也更贴近 tmux `%` 语义）。
6. 工程侧：typescript 必须 ^4.9.5（TS 5.x 与 tabby-terminal→@ng-bootstrap→compiler-cli peer 链 ERESOLVE）；peerDependencies 只声明 `@angular/core`；部署时 dist 必须**作为子目录**整体拷贝。

## 常用命令

```bash
npm run check          # smoke + typecheck + build（提交前必跑）
npm run deploy         # → instances\mux（改 config.yaml 需重启实例才生效）
# 实例启停（手动，tools\tabby.ps1 已不存在）：
#   Start-Process 'D:\Env\TabbyEnv\instances\mux\Tabby.exe' -ArgumentList '--remote-debugging-port=9242'
#   杀进程只按路径过滤 '*TabbyEnv*instances*mux*'，禁止按进程名
```

## 验证配方（CDP）

```bash
node scripts/cdpEval.js "window.tabbyMux.sessions.length"
# 功能链路（注意 zone 戳）：
#   poke=F13 keydown/keyup → createSessionWithWindow → poke → newWindow → poke → splitPane('h')
#   断言：cur/last 索引、getAllTabs().length、状态栏 textContent（0:xxx* 1:xxx- pane i/n）
# 加载验证必须进程重启（Page.reload 不重载用户插件）；pluginModules 渐进填充等 ~20s
```

## 一期未做（Roadmap）

prefix 前缀键、detach/持久化、tmux 布局模式、自研布局引擎、设置页。热键默认全空（`hotkeys.mux.*: []`），用户在设置页绑定。
