# tabby-mux

tmux-style session / window / pane management for [Tabby](https://tabby.sh).

First milestone: the tmux hierarchy on top of Tabby's native tab engine.

```
tmux session → MuxSession   逻辑命名分组（插件侧运行时状态）
tmux window  → 顶层 SplitTab（Tabby 原生分屏 tab，≥1 个 pane）
tmux pane    → SplitTab 内的子终端（原生 split 引擎直管，插件不包装）
```

## 功能（v0.1）

- **Session / Window / Pane 数据模型与管理服务**（`MuxService`）
  - 自动领养：通过正常途径新开的终端 tab 自动归入当前会话；实例重启后恢复的 tab 同样被领养成窗口（会话按 tmux 风格编号 0,1,2…）
  - 最后一个窗口关闭时会话自动消亡（tmux 语义）
  - 新窗口继承当前焦点 pane 的 profile（无则回退第一个本地 shell）
- **tmux 附着模式（会话隔离，默认开启）**：tab 栏同一时刻只显示**当前附着会话**的窗口
  - 新建会话 = 当前会话整组撤下（终端继续后台运行）+ 新会话附着
  - 状态栏左侧会话条：当前会话高亮、后台会话变暗显示窗口数，点击切换附着（整组换装）
  - `mux.isolatedSessions: false` 可切换回混合模式（所有窗口全部可见），`mux.toggle-isolation` 命令热切换
  - ⚠️ 后台（未附着）会话不在 Tabby 自身的崩溃恢复快照里——重启后不可恢复
- **左侧会话栏（最外侧）**：垂直 session 导航，位于 profile-tree/其他侧栏更左（appRoot `.window` 的第一个子元素）
  - 当前附着会话高亮，后台会话显示窗口数徽章；点击切换附着，底部 "+" 新建会话
- **tmux 式底部状态栏（会话仪表盘）**：`[alpha] [beta] | pane i/n | CPU 24% MEM 74%`
  - 窗口列表刻意不在此重复（tab 栏已承担）；会话条点击切换附着
  - **系统资源监控**：CPU/内存使用率实时采样（`os.cpus()` 增量 + `freemem`），刷新间隔可配置
- **设置页**（设置 → Tabby Mux）：**模板为第一页签**（仿"配置和连接"页的分组列表：点击行进入悬浮编辑、▶ 图标新建会话、⋯ 菜单收起重命名/分组/删除）；其余合并为"通用设置"单页（状态栏/会话侧栏/会话行为三节）
  - 模板编辑为**悬浮 modal**（xl），布局画布**分隔框可拖动**调整比例；pane 右下角**无边框编辑图标**打开该连接的编辑页（引用自动分叉，保存=存为 tabby-mux 独立配置，**另存为配置和连接**为显式操作）
- **会话模板**（布局 spec 格式）：以**窗口布局树**（orientation/ratios/窗格）而非黑盒 token 保存工作区
  - **窗格 Profile 双语义**：默认**引用**现有 Profile（应用时直取其当前定义）；修改配置后**分叉为独立副本**随模板保存；副本可**提升为新 Profile** 写回注册表（窗格自动转回引用）
  - 捕获会话 = 直读 SplitContainer 树（无 token 往返，即时可靠）；应用 = 按树重建窗口（fresh shell，不恢复进程）
  - **入口全覆盖**：右键会话（侧栏/底栏）保存；侧栏"模板"区（常驻 + 搜索框）；底栏书签按钮（搜索选择器）；命令面板；设置页
  - **图形化布局编辑器**（设置 → 模板 → 编辑）：嵌套 flex 画布按真实比例渲染布局；**左键选中、右键出操作菜单**（水平/垂直拆分、复制、删除、指定 Profile、修改配置、存为新 Profile）——Profile 指派复用 Tabby 原生**可搜索配置选择器**；副本窗格在面板内联编辑（名称/命令/cwd）并可提升为新 Profile；窗口级右键复制/删除、拖拽/箭头排序、从当前会话导入（选择器）、添加空白窗口（选择器）；工作副本 + 预览应用 + 显式保存/放弃
- **38 个命令**：新建/重命名/关闭/切换/附着 会话与窗口、选窗 1-9、
  分割（tmux `%`/`"` 语义）、关闭/导航/缩放/均分/调整 窗格、模板、切换状态栏/隔离模式/会话侧栏
  - 全部注册进**命令面板**（Ctrl-Shift-P）与**热键系统**
  - 热键默认全部不绑定（避免与 Tabby 内置冲突），在 设置 → 热键 的
    `mux.*` 分组里自行绑定
- 工具栏按钮：新建 mux 会话

## 调试句柄

实例运行时 `window.tabbyMux` 暴露 `MuxService`（CDP 验证用）。

## 开发

```bash
npm install
npm run check        # smoke 加载自检 + typecheck + build
npm run deploy       # 部署到隔离实例 D:\Env\TabbyEnv\instances\mux（需先 build）
node scripts/cdpEval.js "<expr>"     # 对运行实例求值（CDP_PORT 默认 9242）
node scripts/cdpConsole.js [秒]      # 抓 renderer console
```

## 热键绑定建议（tmux 直译）

| tmux | 命令 | 建议绑定 |
|---|---|---|
| `prefix c` | mux.new-window | Ctrl-Shift-T*（与内置冲突，需先解绑） |
| `prefix %` | mux.split-pane-right | （内置 split-right 已有 Ctrl-Shift-S） |
| `prefix "` | mux.split-pane-bottom | （内置 split-bottom 已有 Ctrl-Shift-D） |
| `prefix n/p` | mux.next-window / previous-window | Ctrl-Alt-Right / Left* |
| `prefix 0-9` | mux.select-window-1..9 | — |
| `prefix x` | mux.kill-pane | — |
| `prefix z` | mux.pane-zoom | （内置 pane-maximize 已有 Ctrl-Alt-Enter） |
| `prefix d` | detach | 未实现（一期无 detach） |

标 `*` 的与 Tabby 默认绑定冲突，二选一。

## Roadmap

- [ ] prefix 前缀键两段式系统（`Ctrl-B` + 命令键）
- [ ] 会话持久化（后台会话纳入恢复快照）
- [ ] tmux 布局模式（even-horizontal / main-horizontal / tiled）
- [ ] 自研布局引擎（替换 SplitTab 承载，支持 pane 边框样式）
- [ ] 设置页（SettingsTabProvider）

## License

MIT
