# 顶栏自动前景色：两个时序问题的分析与修复

> 环境：GNOME Shell 50.4 / mutter 50.4 / Fedora，扩展运行在
> `transparent-top-bar@icookie-tea.github.io`。
> 本文记录两个问题的完整定位过程、修复方案和回归测试。
> 测试的用法见 [`../tests/README.md`](../tests/README.md)。

## 0. 结论摘要

| 现象 | 根因 | 修复 |
|---|---|---|
| 进入 overview 偶发用错前景色，约 0.5–1s 后自愈 | 采样定时器可能落在 overview 的 250ms 过渡窗口内，采到尚未变暗/模糊的背景，并被当成稳态值写进 `overview` 缓存；下次进入会先套用这个脏缓存 | 用 `_transitioning` 标记过渡，采样前后都校验；`shown`/`hidden` 后的采样延迟 500→100ms；失效时清掉其它状态的缓存；无缓存时用桌面亮度兜底 |
| 窗口靠近时面板变黑有过渡，窗口离开时变透明没有过渡 | St 的过渡是"旧/新样式交叉淡化"，过渡进行中如果再来一次**不同的**样式变更会被直接取消（`timeline_stop` + `completed`）。旧代码每次窗口 `notify::allocation` 都 remove+add 前景色 class，于是离开方向的过渡被杀掉；靠近方向因为 remove 是空操作而幸存 | `_applyAutoColorClass()` 幂等：只有判定结果真正变化才动 class |

---

## 1. 问题一：进入 overview 偶发错色

### 1.1 相关时序（GNOME Shell 50）

`js/ui/overview.js` 里（源码行号以 GNOME Shell 50.4 为准）：

```js
export const ANIMATION_TIME = 250;

show(state) {
    ...
    this._shown = true;
    Main.layoutManager.showOverview();
    this._animateVisible(state);
}

_animateVisible(state) {
    this._visible = true;                                  // ← 先置位
    ...
    this._changeShownState(OverviewShownState.SHOWING);    // ← 后发 'showing'
    this._overview.animateToOverview(state, () => this._showDone());
}

_showDone() {
    ...
    this._changeShownState(OverviewShownState.SHOWN);      // ← 动画结束发 'shown'
}

_animateNotVisible() {
    this._visibleTarget = false;
    ...
    this._changeShownState(OverviewShownState.HIDING);
    this._overview.animateFromOverview(() => this._hideDone());
}

_hideDone() {
    this._visible = false;                                 // ← 'hidden' 之前才置 false
    ...
    this._changeShownState(OverviewShownState.HIDDEN);
}
```

`js/ui/overviewControls.js` 里，overview 的背景（模糊/压暗层，Blur my Shell
等也挂在这里）由 `stateAdjustment` 驱动，缓动时长同样是 `ANIMATION_TIME`：

```js
animateToOverview(state, callback) {
    this._stateAdjustment.value = ControlsState.HIDDEN;
    this._stateAdjustment.ease(state, {
        duration: Overview.ANIMATION_TIME,
        onStopped: callback,        // → _showDone → 'shown'
    });
}
```

于是扩展看到的时间线是：

| 时刻 | 事件 | 扩展行为 |
|---|---|---|
| t=0 | `_visible=true`，随后发 `showing` | `_currentBackgroundState` 已经变成 `overview`，`_applyAutoColorClass()` **立即套用 overview 缓存的颜色** |
| t=0–250ms | 背景层随 `stateAdjustment` 交叉淡化，面板下方像素从"桌面"渐变到"overview" | — |
| t=250ms | 动画结束，发 `shown` | 安排一次采样，旧代码延迟 500ms |
| t=750ms | 采样开始 | 结果写缓存 → 颜色纠正（约 30ms 后） |

也就是说：**如果 overview 缓存是错的，用户会看到约 0.8 秒的错误颜色，
然后被 `shown+500ms` 的采样纠正**——正好是"很快就变成正确颜色"。

### 1.2 脏缓存是怎么产生的

`_refreshBackgroundLuminance()` 旧代码只检查一次状态：

```js
const state = this._currentBackgroundState;
const generation = ++this._sampleGeneration;
const luminance = await this._sampleBackgroundLuminance(state);

if (generation !== this._sampleGeneration || state !== this._currentBackgroundState)
    return;   // 只有"状态已经变了"才丢弃
```

问题有两个：

1. **`hiding` 期间 `Main.overview.visible` 仍然是 true**（直到 `_hideDone`
   才置 false）。所以退出动画中途开始的采样，状态被记录成 `overview`，
   结束时状态检查也不会失败——采到的是"桌面正在淡入"的混合值。
2. **任何遗留的采样定时器都可能落进过渡窗口**。采样由 `_scheduleSampling()`
   统一调度，而触发它的路径很多：`shown`/`hidden` 后的采样、壁纸
   `BackgroundManager` 的 `changed` 事件（1500ms 延迟）、`sample-count`
   修改（250ms）等。切换 overview 本身不会取消已经排队的采样，所以
   一个"上一次事件"留下的定时器完全可能在过渡进行到一半时触发。

这些中间值会被写进 `overview` 缓存，一直保留到下一次 overview 采样。

### 1.3 实测证据

真机 journal（阈值 0.7、`transparency=0`，所以判定分界线就是 0.7）：

```
22:32:46  [overview] median=0.791     ← 过渡中途，清晰壁纸
22:32:47  [overview] median=0.479     ← 稳定后的 overview 背景
22:32:49  [overview] median=0.816
...
22:35:13  [overview] median=0.479
22:35:14  [desktop]  median=0.816
```

- 0.479 → 浅色文字（正确）
- 0.79–0.82 → 深色文字（错误）

`overview` 一个状态里同时出现两组差得很远的值，且只在快速开关 overview
的时段出现——这就是过渡中途的采样被接受。GNOME Shell 50 本身就会把
overview 背景明显压暗（嵌套会话里实测 desktop≈0.80、overview≈0.135），
所以这种脏缓存的颜色差异非常大。

### 1.4 修复

`extension.js`：

- **过渡标记**：`showing`/`hiding` 置 `_transitioning = true`，
  `shown`/`hidden`（`_onBackgroundStateChanged()`）清零。
  采样函数开始和结束都检查：

  ```js
  async _refreshBackgroundLuminance() {
      if (this._transitioning)
          return;
      ...
      if (generation !== this._sampleGeneration ||
          this._transitioning ||
          state !== this._currentBackgroundState) {
          return;
      }
  ```

- **缩短纠正延迟**：`SAMPLE_DELAY_STATE` 500 → 100ms。`shown`/`hidden`
  本身就是动画结束信号，不需要再等半个过渡。

- **失效时清缓存**：`_invalidateLuminance()`（壁纸、配色方案、
  显示器变化）现在会把**其它状态**的缓存删掉，避免"桌面壁纸换了，
  overview 缓存还是旧的"。

- **兜底**：当前状态没有缓存时，用 deskop 的亮度做临时判断，
  而不是退回主题默认色（首次进入 overview 不再闪一下默认颜色）。

---

## 2. 问题二：窗口离开时面板背景没有过渡

### 2.1 St 的过渡机制

`src/st/st-theme-node-transition.c`：St 的样式过渡不是逐属性插值，而是把
**旧 theme node 和新 theme node 各离屏渲染一次，然后按进度做整块交叉淡化**：

```c
StThemeNodeTransition *
st_theme_node_transition_new (ClutterActor *actor,
                              StThemeNode *from_node,
                              StThemeNode *to_node, ...)
{
  duration = st_theme_node_get_transition_duration (to_node);  // 时长取"目标"节点

  transition->old_theme_node = ...;
  transition->new_theme_node = ...;
  transition->timeline = clutter_timeline_new_for_actor (actor, duration);
  ...
  clutter_timeline_start (transition->timeline);
}
```

关键在 `st_theme_node_transition_update()`：过渡进行中如果又来一次
**不等价**的样式变更，过渡会被直接取消：

```c
void
st_theme_node_transition_update (StThemeNodeTransition *transition,
                                 StThemeNode *new_node)
{
  ...
  else
    {
      if (clutter_timeline_get_elapsed_time (transition->timeline) > 0)
        {
          clutter_timeline_stop (transition->timeline);
          g_signal_emit (transition, signals[COMPLETED], 0);   // ← 过渡销毁
        }
      else
        {
          /* 同一帧内的变更：只更新目标节点 */
          ...
        }
    }
}
```

`src/st/st-widget.c` 的 `st_widget_recompute_style()` 把这条规则接起来：
有正在运行的过渡时就调用 `st_theme_node_transition_update()`，没有过渡且
"新旧样式绘制结果不同"时才新建过渡。另外 St 的
`add_class_name()`/`remove_class_name()` 在 class 已存在/不存在时是
空操作（不触发 `style-changed`），这两点共同解释了下面的方向不对称。

### 2.2 为什么只有一个方向有过渡

面板不透明（窗口贴近）时，扩展调用 `_setTransparent(false)`，随后
`_applyAutoColorClass()`。它是这样写的：

```js
_applyAutoColorClass() {
    Main.panel.remove_style_class_name(DARK_TEXT_CLASS);
    Main.panel.remove_style_class_name(LIGHT_TEXT_CLASS);
    ...
    Main.panel.add_style_class_name(darkText ? DARK_TEXT_CLASS : LIGHT_TEXT_CLASS);
}
```

窗口拖动时，面板被挂在每个窗口的 `notify::allocation` 上，**每帧**都会
走一遍 `_updateTransparent()` → `_applyAutoColorClass()`：

- **变不透明方向**：面板此刻已经没有颜色 class，两次 `remove` 都是空操作，
  后面的 `add` 又被 `has_style_class_name('transparent-top-bar')` 早退挡住。
  → 没有后续样式变更，St 的交叉淡化正常跑完。
- **变透明方向**：`_setTransparent(true)` 加上透明 class，同帧内
  `_applyAutoColorClass()` 加上颜色 class（此时 elapsed=0，安全）；
  **下一帧**的 `notify::allocation` 再次调用时，remove 掉颜色 class 是
  一次真实变更，随后 add 又是第二次 → `st_theme_node_transition_update()`
  发现 elapsed > 0 → 取消过渡、直接跳到透明。

### 2.3 实测

嵌套会话里用同一个测试分别跑修复前后（面板顶部像素亮度）：
`0` = 不透明黑，`0.8` = 背景色。

| | opaque | 窗口离开 ~300ms | 最终 |
|---|---|---|---|
| 修复前 | 0 | **0.800** | 0.800 |
| 修复后 | 0 | **0.306** | 0.800 |

修复前中途值已经等于最终值，说明淡出被跳过；修复后中途处于中间值，
过渡完整。

### 2.4 修复

`_applyAutoColorClass()` 改成幂等——先算出目标状态，只有与当前 class
不一致时才做增删：

```js
if (darkText === true) {
    if (!Main.panel.has_style_class_name(DARK_TEXT_CLASS)) {
        Main.panel.remove_style_class_name(LIGHT_TEXT_CLASS);
        Main.panel.add_style_class_name(DARK_TEXT_CLASS);
    }
} else if (darkText === false) {
    ...
} else {
    // 不适用自动颜色（关闭/不透明/transparency=100）时清空
}
```

这样窗口拖动期间 `_updateTransparent()` 可以随便调用，不会再产生
多余的 `style-changed`，过渡自然存活。顺带也省掉了每帧对整个面板
子树（`st_widget_style_changed` 会递归所有子 actor）的样式重算。

---

## 3. 一并修复的问题

- **`_updateTransparentDelayed()` 定时器泄漏**：连续 `switch-workspace`
  时直接覆盖 `_delayedTimeoutId`，旧定时器失联；禁用扩展后它仍会触发，
  而那时 `this._settings` 已为 null，会抛 TypeError。现在先 remove 再排新定时器。
- **debounce id 未置空**：`transparency`/`dark-full-screen`/`disable-text-shadow`
  三个 debounce 触发后没有把 id 置 null，下次 `GLib.source_remove()` 会打印
  `g_source_remove: assertion 'tag > 0' failed` / `Source ID ... was not found`
  （journal 里已经有一堆）。现在回调里置 null、remove 前判空。
- **`_onWindowActorRemoved()` 空引用防护**：对未记录信号的 actor 不再直接解引用。
- **窗口信号合并**：每个窗口的 `notify::allocation`/`notify::visible`
  改为 50ms 合并一次（`_queueWindowUpdate()`），拖动窗口时不再每帧
  全量遍历窗口列表。
- **变透明时重新采样**：面板刚由不透明变透明时，采样点可能一直被窗口
  盖着，缓存里是窗口内容的亮度；现在会安排一次新采样。

---

## 4. 验证

测试细节见 [`../tests/README.md`](../tests/README.md)。核心是在 toolbox
容器里跑一个嵌套 GNOME Shell，用 `--automation-script` 驱动，
再用 `Shell.Screenshot.pick_color` 读像素。

修复后：

```
PASS initial desktop sample exists (desktop=0.8)
PASS overview transition flag is set (visible=true)
PASS sample during transition is discarded (overview=undefined)
PASS sample after transition is accepted (overview=0.42)
PASS panel becomes opaque when the window touches it
PASS opaque panel is black (panel=0 classes="null")
PASS panel is transparent after the window left (panel=0.8)
PASS panel background is still fading mid-way (opaque=0 mid=0.306 final=0.8)
PASS overview sample recorded while stable (desktop=0.8 overview=0.135)
SUMMARY ALL PASS
```

`git stash` 回旧代码后，同一个测试会抓到两个 bug：

```
FAIL sample during transition is discarded (overview=0.42)
FAIL panel background is still fading mid-way (opaque=0 mid=0.8 final=0.8)
```

---

## 5. 经验教训：dconf 必须用私有会话总线隔离

做这个测试时踩过一次坑：最初以为把 `HOME` 指到临时目录就够了，结果
`dconf write` 走的是**会话总线**，写进了正在使用的桌面环境——
`enabled-extensions` 被覆盖成只剩测试扩展，真实会话里的扩展被实时禁用。

恢复过程：

1. `disabled-extensions`（黑名单）没有被覆盖，它是"哪些被显式禁用"的权威
   来源（`dash-to-dock`、`desktop-icons-ng`、`frosted-overview`、
   `simple-taskbar`、`user-accent-colors@fabito02`、旧的
   `transparent-top-bar@ftpix.com` 等）；
2. 原来启用的集合 = 已安装扩展 − 黑名单，据此重建 `enabled-extensions`，
   写回后 Shell 会实时重新启用；
3. 背景/外观相关键 `dconf reset` 回默认（`picture-uri` 未被改动，壁纸仍在）；
4. 扩展自己的三个键（`sample-count` 等）reset 回未设置状态。

教训：**测试脚本里所有 dconf 操作都要在
`env HOME=$TESTHOME TTB_TEST_HOME=$TESTHOME dbus-run-session -- ...`
里执行**，并在脚本里加断言：`HOME == TTB_TEST_HOME`，且总线地址不是
`unix:path=$XDG_RUNTIME_DIR/bus`。`tests/nested/dconf-setup.sh` 已经内置了
这两个守卫。
