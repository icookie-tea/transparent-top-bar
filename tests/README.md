# 行为测试（嵌套 GNOME Shell）

这里保存的是两个"时序型"bug 的回归测试。它们和 250/500ms 级别的过渡动画
交错发生，手动操作很难稳定复现，所以测试在 toolbox 容器里的一个
**嵌套 GNOME Shell**（`gnome-shell --devkit`）中自动执行。

## 测试内容

`nested/automation.js` 在 shell 启动完成后运行，覆盖：

| 测试 | 断言 |
|---|---|
| A | `showing` 后 80ms 手动触发采样：`_transitioning` 为 true，且结果**不写入** overview 缓存 |
| A | `shown` 之后采样：结果**写入**缓存 |
| B | 窗口贴近面板时，面板变为不透明（黑色，`transparent-top-bar` 类被移除） |
| B | 窗口离开 300ms 后再触发一次 `_updateTransparent()`：面板背景仍在淡出中途（既不是全黑也不是全透明） |
| B | 过渡结束后面板完全透明 |
| C | 进入 overview 后，稳态采样结果被记录，且与桌面亮度不同 |

其中 B 的中途检查依靠 `Shell.Screenshot.pick_color` 读面板顶部像素：
`0` = 不透明黑，`0.8` = 背景色，中间值说明过渡没有被取消。

## 运行

```bash
tests/run-tests.sh
```

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CONTAINER` | `fedora-toolbox-44` | toolbox 容器名 |
| `WORKDIR` | `/tmp/transparent-top-bar-tests` | 容器可见的临时目录 |
| `KEEP` | `0` | `KEEP=1` 保留日志 |

前置条件：

- 在一个有图形会话的终端里运行（嵌套 shell 会通过 `mutter-devkit`
  在宿主机上显示一个窗口）
- 容器里要有 `gnome-shell >= 49`（`--devkit`）、`mutter-devkit`、`gjs`、GTK4

## ⚠️ dconf 隔离

**dconf 走的是会话总线，不是 `$HOME`。** 普通的一条

```bash
dconf write /org/gnome/shell/enabled-extensions "['...']"
```

写到的是**正在使用的桌面环境**的设置，而不是测试目录。开发这个测试时
确实踩过一次坑，把真机的扩展全禁用了，恢复过程见
`../docs/analysis.md` 的"经验教训"一节。

因此所有 dconf 操作都必须像 `nested/dconf-setup.sh` 那样：

```bash
env HOME="$TESTHOME" TTB_TEST_HOME="$TESTHOME" \
    dbus-run-session -- bash dconf-setup.sh
```

`dconf-setup.sh` 自带守卫：要求 `HOME == TTB_TEST_HOME`，并且拒绝在
`unix:path=$XDG_RUNTIME_DIR/bus`（真机会话总线）上运行。

## 用旧代码验证测试会失败

```bash
git stash push -- extension.js        # 回到修复前
tests/run-tests.sh                    # 预期 FAIL
git stash pop
```

修复前的代码会输出：

```
FAIL sample during transition is discarded (overview=0.42)
FAIL panel background is still fading mid-way (opaque=0 mid=0.8 final=0.8)
```

`mid=0.8 final=0.8` 表示面板背景被样式变更打断了过渡、直接跳到透明。

## 目录结构

```
tests/
├── run-tests.sh            # 宿主机入口：准备隔离 HOME、写 dconf、进容器跑测试
├── README.md
└── nested/
    ├── dconf-setup.sh      # 隔离 dconf 初始化（带会话总线守卫）
    ├── harness.sh          # 容器内：启动嵌套 shell + 测试窗口，汇总结果
    ├── automation.js       # gnome-shell --automation-script 执行的用例
    └── test-window.js      # GTK4 测试窗口（"贴近面板的窗口"）
```
