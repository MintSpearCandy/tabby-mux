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
- 附着不变式（2026-10-18 加固）：隔离模式下 tab bar 只列附着会话的窗口，靠**三层协同**维持——① `attachSession()` 做**全局清扫**（撤下所有非目标会话的已列出窗口，不是只 detach 前一个附着会话）；② `registerWindow()` 末尾把"注册到非附着会话"的窗口立即软移除（窗口经 `addTabRaw` 落地时会被列出+选中，必须在源头撤下）；③ `createSessionWithWindow()`/`createSessionFromTemplate()` 在**创建完成后**才 attach（预 attach 是竞态：创建在 `await resolveProfile` 处挂起，并发调用的 attachedSessionId 会被改写——高频新建曾因此把每个会话的窗口都漏管滞留在 bar，切换也不清除，2026-10-18 CDP 实测复现+修复）。并发创建的终态 = 最后 attach 者胜，全部窗口归属正确。
- **reconcile 不得重选选中**（2026-10-18 二轮）：`config.changed$` 每次保存都触发 `applyIsolationSetting()`——当 keep 就是当前附着会话时只做列表修复（`relistSessionWindows()`，不动选择），**禁止走完整 `attachSession()`**（其 `selectTab` 会把正在设置页/欢迎页改配置的用户拽回会话窗口；这曾是 64bcf58 重写删掉早退后的回归）。只有 keep ≠ 当前附着会话（真切换/模式转换）才完整 attach。
- 后台会话不在 app.tabs → **不进 Tabby 崩溃恢复快照**（重启即失，README 已注明）。
- detached 窗口的 kill 走 `canClose() + tab.destroy()` 直连（closeTab 只认已列出 tab）；destroy → destroyed$ → addTabRaw 的订阅 → tabRemoved$ → 注册表自清。
- **外来 tab（欢迎/设置页等非 SplitTab 顶层 tab）**：不领养（tryAdopt 的 instanceof 闸门）、不清出（清扫只碰注册窗口）、切到它们不改变附着状态。可选 `mux.foreignTabsToTail`（默认关）：每次切换会话时把外来 tab 顺序移到所有窗口之后——`moveTabToIndex` 是纯 splice+tabsChanged（不动活动 tab，pinned 被夹在前部，typings 缺失需 `(app as any)`），在 attachSession 尾部与混合模式 switchToSession 各调一次。

## 已验证的平台坑（2026-10-16 实测，别再踩）

1. **type-only import 不能出现在构造器参数类型里**：`constructor (private x: SomeService)` + `import type` → `emitDecoratorMetadata` 写入 `Function` 作为 token → Angular 注入字面量 `Function` → `NullInjectorError: No provider for Function!` → **整个 bootstrap 失败**（宿主降级重启后本插件消失、其余插件正常——极具迷惑性）。服务依赖一律 `Injector + 运行时 get()`。
2. **ASI 陷阱**：以 `(` 开头的语句（如 `(window as any).x = this`）会链到上一条无分号语句的调用上——用局部变量中转。
3. **`wrapAndAddTab` 不同步 await 内部 `addTab`**，且 `add()` 内部 `await initialized$.toPromise()`（ngAfterViewInit 触发）：新窗口的 `getFocusedTab()` 在视图初始化前是 null；**Angular Zone 外调用（CDP）时 ngAfterViewInit 无人触发，add() 可挂到下一次 zone 活动（最长 ~30s recovery 定时器）**。真实用户路径（热键/palette/工具栏）全在 zone 内，无此问题。**CDP 测试必须每步后派发 F13 keydown 戳 zone**。
4. **`addTabRaw` 在 `registerWindow` 之前发射 activeTabChange$**：窗口注册时若 `app.activeTab === tab` 必须手动同步 `currentWindowIndex`（否则索引永久 desync）——见 `registerWindow` 内注释。
5. **原生 `splitTab()`（duplicate 式）在终端 session 未初始化完时返回 null**（recovery token 未就绪）：splitPane 已做同 profile 新建终端的回退（也更贴近 tmux `%` 语义）。
6. 工程侧：typescript 必须 ^4.9.5（TS 5.x 与 tabby-terminal→@ng-bootstrap→compiler-cli peer 链 ERESOLVE）；peerDependencies 只声明 `@angular/core`；部署时 dist 必须**作为子目录**整体拷贝。
7. **`tabOpened$` 在 `addTabRaw` 内同步发射**（app.service.ts 唯一 next 点）：领养抑制（suppressAdoption）只需覆盖同步调用段——跨 await 的长命计数器会吞掉用户在模板构建期间并发新开的 tab（成为永远无主的窗口）。buildWindowFromSpec 的抑制已窄化到 `addTabRaw` 那一行。
8. **`ProfilesService.getProfiles()` 无宿主缓存**：每次调用重跑 builtin 枚举（本地 shell 的 fs.stat/PATH 扫描、SSH importer 读配置）——高频建会话时这是主要插件侧开销。创建路径走 `getProfilesCached()`（30s TTL + config.changed$ 失效；profile 编辑都经 config.save → 立即失效）。终端 spawn 本身是 `ipcRenderer.sendSync`（阻塞 renderer，宿主固有，无法规避）。

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
- **应用路径（2026-10-19 两阶段化）**：`createSessionFromTemplate` 阶段 1 **同步**创建全部窗口外壳（空 SplitTab + `setCustomTitle('…')` 占位 + 注册；隔离模式先 attach 再建壳避免逐壳 add-then-sweep 抖动），全部窗口瞬时可见、会话即刻可交互（实测 3 窗口 5ms 返回）；阶段 2 `fillWindowsProgressively` 后台**逐窗口**填 pane（registry 走 30s 缓存），**每窗口的 pane 全部 spawn 就绪（`tab.session` 出现）后才进入下一窗口**（waitPanesSpawned 门控，10s 超时兜底）——可见加载顺序严格从第一个窗口开始；'…' 占位标题在门控通过后才清除（标题解析顺序=真实加载顺序）。填充语义（fillWindowFromSpec）：`await split.initialized$`（视图就绪，zone 外调用会挂！）→ 逐叶子 `newTabParametersForProfile` + `tabsService.create` + `(split as any).attachTabView(tab)` + `tab.parent = split` → 用 **`new SplitContainer()` 递归构建真树**赋给 `split.root`（不能用裸对象，引擎会调 root.getAllTabs()）→ `split.layout()` → **`activatePanes(split)`**。
- **pane 前端附着的焦点门槛（2026-10-19 定位）**：终端 pane 的 `frontend.attach`（→ ResizeObserver → resize → frontendReady → session spawn 链）在 `baseTerminalTab.component.ts` 的 ngAfterViewInit 里**只在该 pane 有焦点时执行**，否则挂起等第一次 `focused$`。宿主 split 路径每次 add 都 focus 新 pane；spec 填充直接建树，若只 focus 首 pane，**其余 pane 永无 session（空白死格，直到用户点击才复活）**——自模板功能诞生即存在，多 pane 模板一直带病。修复 = `activatePanes()`：轮询重 focus 所有 `frontendIsReady !== true` 的 pane（150ms 间隔，8s 超时，重试自愈 CD 时序差），完成后 focus 首 pane。
- pane 子 tab **不经过 addTabRaw**（tabOpened$ 只在顶层发射）→ 填充阶段无需领养抑制；外壳被用户提前关闭则跳过，pane 全部无法解析（profile 已删）则销毁空壳防僵尸。
- **共用实例纪律**：instances\mux 是用户在用的调试实例——测试脚本**禁止把用户可写设置重置为硬编码默认值**（2026-10-19 事故：清理时把用户开启的 foreignTabsToTail 关掉，被用户当成置尾失效的 bug 报告）。需要改设置时先快照原值，测完恢复原值；用户数据（模板/会话）一律不动。
- **捕获**：直读 `win.tab.root`（SplitContainer）——比 getRecoveryToken 可靠（无初始化竞态）。
- **图形画布**：递归 ng-template（`context: {$implicit, path}`），ratios → `flex-grow`（cell 包一层做 flex item）；结构变异前**先捕获 pane 对象**再 `findPathByPane` 恢复选中（normalizeSpec 会提升容器改变路径）。
- **提升 Profile**：`ProfilesService.newProfile(profile)`（genId 默认 true，生成 `local:custom:<name>:<uuid>` id）→ pane 转回引用。注意：**没有 removeProfile API**（删除要走 config）。
- @angular/cdk/drag-drop 作 external 可用（宿主为 tabby-core 保留 CDK）；设置页测试句柄 `window.__muxSettingsComponent`。
- **编辑器 UI 惯例（2026-10-16 六轮简化）**：窗格/窗口动作全部走右键菜单（`popupContextMenu`），面板只留编辑字段；Profile 指派/空白窗口/导入窗口全部经**可搜索选择器**——`ProfilesService.showProfileSelector()`（宿主原生组件）或 `SelectorService.show()`（自定义选项：导入窗口用 result=MuxWindow）。
- **设置页原生化 + modal 泄漏（2026-10-17）**：`backdrop:'static'` 的 NgbModal **必须在组件 ngOnDestroy 里 dismiss**——否则切设置分区/关设置页后遮罩残留、整个页面点击无响应（用户报"按键无响应"的根因之一）。页签用 **ngbNav**（模块 import NgbNavModule/NgbDropdownModule）；模板列表复制 profilesSettingsTab 的 `collapse-container/collapse-item` 结构与样式（原生类 scoped 不可直接用，需自拷贝 CSS；`hover-reveal` 也非全局类）。分组存 `mux.templateGroups/collapsedGroups`（数组，整组赋值）。
- **ngFor 身份抖动 = 真实点击死亡（2026-10-17 根因二）**：宿主高频跑变更检测，**getter 返回新对象数组 + 无 trackBy** → ngFor 每秒重建 DOM ~40 次 → mousedown/mouseup 之间节点被替换 → **Chromium 不合成 click 事件**。DOM 合成 `.click()` 绕过命中测试所以测试全绿、真机全死。**验证真实点击必须用 `Input.dispatchMouseEvent`**（`scripts/cdpClick.js --selector`）。修复：trackBy（分组按 name、模板按 id），空闲 mutation 60/1.5s → 0。
- **原生 profile 编辑器复用（2026-10-17）**：`EditProfileModalComponent`（tabby-settings）——`componentInstance.partialProfile = deepClone(profile)` + `profileProvider = providerForProfile(...)`，result 即编辑后 profile（取消 resolve null）。宿主 1.0.237 运行时导出但 npm typings 缺失 → `declarations.d.ts` **完全遮蔽** tabby-settings（非模块文件的 ambient `declare module` 会整体遮蔽而非增补——只声明实际消费的两个成员）。窗格编辑语义：取消/无修改保存 = 保持原样（引用仍是引用），**有修改的保存才分叉为独立副本**；"另存为配置和连接"在窗格右键菜单（显式输入名称）。
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

prefix 前缀键、detach/持久化、tmux 布局模式、自研布局引擎。4 个命令有默认绑定（2026-10-25 用户指定，configProvider DEFAULT_BINDINGS）：new-session=`Ctrl-Shift-=`、switch-session-next/prev=`Ctrl-Shift-Down/Up`、new-session-from-template=`Ctrl-Shift-\`（新增命令，打开模板选择器）。

## 热键（2026-10-25 实测沉淀）

- **和弦格式**：`-` 分隔（非 `+`），键名基于 `event.code` 映射（hotkeys.util.ts）：`Equal→'='`、`Backslash→'\'`、`Arrow→''`（Up/Down）；Shift 下 `=` 报 `+` 但 code 归一为 `=`。
- **多重匹配规则**：同弦多命令时取**最长序列、同长取注册序首个**——builtin（tabby-terminal 等）先注册恒胜用户插件。**默认冲突清单（tabby-terminal config.ts）**：`zoom-in`=['Ctrl-=','Ctrl-Shift-=',…]、`scroll-up/down`=['Ctrl-Shift-Up','Ctrl-Shift-Down']——用户指定的新默认里 3 组被遮蔽（实测 CDP 注入只 Matched builtin；`Ctrl-Shift-\` 正常命中 mux）。用户需在 设置→热键 清掉 builtin 绑定才能让 mux 生效。
- **旧默认固化问题**：ConfigProxy 读数组会把旧默认（全 `[]`）固化写回 config.yaml → **改默认绑定对已有实例不生效**（存量覆盖默认）；新命令无存量则正常拿到新默认。升级时需显式写入用户配置（那属于落实用户需求，不违反共用实例纪律）。
- CDP 注入配方验证有效：F13 烧去重槽 + 两轮注入（300ms 间隔）+ `Runtime.consoleAPICalled` 抓 "Matched hotkey" 日志作命中证据；注入 zoom 类和弦后记得 `webFrame.setZoomLevel(0)` 复原。
