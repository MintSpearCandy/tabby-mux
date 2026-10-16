# tabby-mux

tmux 架构复刻插件（Session-Window-Pane）。宿主源码参考：`D:\Home\Project\TabbySuite\reference\tabby`（v1.0.237，与隔离实例同版）。通用调试方法论见用户级 skill `tabby-debug`（本机环境快照在其 ENVIRONMENT.md）。

## 布局

```
src/
  index.ts            NgModule 入口（5 个 multi provider：Config/Hotkey/Command/ToolbarButton/SettingsTab）
  configProvider.ts   defaults：mux.* 配置 + hotkeys.mux.* 子树（必须声明，否则用户绑定被 ConfigProxy 丢弃）
  commands.ts         MUX_COMMANDS 命令表（id/labelKey/needs*/run）——palette、热键描述、热键分发共用
  mux.service.ts      核心服务：session/window 注册表 + 所有操作（debug 句柄 window.tabbyMux）
  statusbar.service.ts 底部状态栏（DOM 注入；会话条+pane 信息+CPU/MEM 资源采样，无窗口列表）
  sidebar.service.ts  左侧会话栏（appRoot .window 首子元素 = 最外侧左栏；轮询等待挂载点）
  settings/           SettingsTabProvider + 设置页组件（内联模板+Bootstrap 控件+ngModel 即存）
  hotkeys.ts          HotkeyProvider（mux.* 热键描述）
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

## UI 注入与设置页（2026-10-16 二轮实测）

- **左侧会话栏**：`appRoot .window`（flex 容器）的**第一个子元素** = profile-tree 之左 = 最外侧左栏。挂载点在 appRoot 视图初始化后才存在 → 服务轮询（200ms×300）。内容区宽度被挤压 → xterm ResizeObserver 自动 refit。
- **状态栏资源采样**：`os.cpus()` 两次采样差值算 CPU、`freemem/totalmem` 算内存；采样器跑在 `NgZone.runOutsideAngular`（纯 DOM 渲染不需要惊醒变更检测），config.changed$ 时重建采样器（间隔/开关热生效）。
- **设置页**：`SettingsTabProvider`（tabby-settings，devDep）+ 内联模板组件（FormsModule + Bootstrap 类）。**npm typings 的基类 `title` 是属性**——子类用 getter 覆盖会 TS2611（BetterConfiger 走手写 declarations.d.ts 声明 accessor 的路线；本项目标题 locale 无关，直接字段）。配置控件 `[(ngModel)]` 直绑 `config.store.mux.*` 代理嵌套属性 + `(ngModelChange)="config.save()"`（嵌套属性赋值是 ConfigProxy 安全路径）。CDP 开设置页：`require('tabby-settings')` 可在 renderer 解析 → `app.openNewTabRaw({type: SettingsTabComponent, inputs:{activeTab:'mux'}})`。

## 会话模板与设置页（2026-10-16 三轮实测）

- **模板**：`MuxSessionTemplate { id, name, createdAt, windows: RecoveryToken[] }`，存 `mux.templates`（config）。**ConfigProxy 的数组必须整组赋值才持久化**（`store.mux.templates = [...cur, tpl]`，push() 会被丢弃——workwench 同款结论）；保存 = 每窗口 `getRecoveryToken()`（新窗口要等 session 初始化，带 4×300ms 重试）；应用 = `tabRecovery.recoverTab(token)` → `tabsService.create` → 恢复出的是 SplitTabComponent（走 `addTabRaw` 而非 wrapAndAddTab）→ `registerWindow`，全程 `suppressAdoption++`。恢复的是同布局新 shell，非运行中进程。
- **设置页页签**：内联模板组件自带样式（原生 `.form-line` 类 scoped 在 tabby-settings 组件内不可复用，自绘 `.mux-form-line` 结构 + 主题变量贴近原生观感）；开关用 `form-check form-switch`。动态命令（每模板一条 apply 入口）只在 CommandProvider.provide() 里追加，不进 MUX_COMMANDS（无热键 defaults）。
- **closeTab 语义**：`app.closeTab(tab)` 默认**不检查 canClose**（checkCanClose 参数未默认为 true）；关闭前自动存 recovery token 到 closedTabsStack。多 pane SplitTab 的销毁链较长（逐 pane teardown + getFullRecoveryToken），CDP 测试断言前留足等待。
- **PromptModalComponent 返回值**（2026-10-16 用户报告"保存无效果"的根因）：`modal.result` 在 OK 时 resolve **对象 `{value, remember}`**（不是字符串！）、cancel 时 resolve `null`、backdrop/esc 才 reject。取值必须 `result?.value`——`typeof result === 'string'` 判断会让所有弹窗流程静默 no-op。
- **入口可见性设计**：模板入口（rail 模板区/底栏书签按钮）**常驻**而非"有模板才显示"——空态显示"保存当前会话为模板"引导项，0 模板时点击底栏按钮直接转保存。隐身入口 = 用户找不到功能。

## 模板：布局 spec 格式 + 图形编辑器（2026-10-16 五轮重构）

- **数据模型**（types.ts）：`MuxSessionTemplate.windows: MuxWindowSpec[]`，每窗口 = `layout` 树（容器 `{orientation, ratios, children}` / 叶子 `{pane: MuxPaneSpec}`）；`MuxPaneSpec` 二选一：`profileId`（**引用**，应用时 registry 现取）或内嵌 `profile`（**分叉副本**）。旧 token 格式在 boot 时 `migrateTemplates()` 一次性转换。
- **引用判定**（template.model.profilesMatch）：id + name + command + args 相等即引用；**cwd 故意不比**——运行中 pane 的 options.cwd 是解析后的启动目录（还有 `restoreFromPTYID`、`__getValue` 等 ConfigProxy 函数键/会话残留），都是启动期物化而非用户修改。嵌入时 stripRuntimeFields 清洗这些键。
- **应用路径**（buildWindowFromSpec）：`tabsService.create({type: SplitTabComponent})` → `addTabRaw` → **`await split.initialized$`**（视图就绪，zone 外调用会挂！）→ 逐叶子 `newTabParametersForProfile` + `tabsService.create` + `(split as any).attachTabView(tab)` + `tab.parent = split` → 用 **`new SplitContainer()` 递归构建真树**赋给 `split.root`（不能用裸对象，引擎会调 root.getAllTabs()）→ `split.layout()` + `focus(first)`。
- **捕获**：直读 `win.tab.root`（SplitContainer）——比 getRecoveryToken 可靠（无初始化竞态）。
- **图形画布**：递归 ng-template（`context: {$implicit, path}`），ratios → `flex-grow`（cell 包一层做 flex item）；结构变异前**先捕获 pane 对象**再 `findPathByPane` 恢复选中（normalizeSpec 会提升容器改变路径）。
- **提升 Profile**：`ProfilesService.newProfile(profile)`（genId 默认 true，生成 `local:custom:<name>:<uuid>` id）→ pane 转回引用。注意：**没有 removeProfile API**（删除要走 config）。
- @angular/cdk/drag-drop 作 external 可用（宿主为 tabby-core 保留 CDK）；设置页测试句柄 `window.__muxSettingsComponent`。
- 删除窗口最后一个窗格必须连带删窗口；startEdit 过滤空窗口自愈旧数据。`PlatformService.showMessageBox`：`{buttons, defaultId, cancelId}` → `result.response` 按钮下标。

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
