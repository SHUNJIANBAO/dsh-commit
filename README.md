# dsh-commit

DeepSeek Harness 的一键提交插件：在输入栏工具行左侧加一个「提交」按钮。

点一下，插件会代替你在当前会话里发一条指令，由当前会话的 Agent 完成下面这些事：

1. 先判断当前工作目录是 Git 还是 SVN 工作副本；两者都不是就只回一句说明，什么都不动。
2. 有改动就用 `git diff` / `svn status` 看清这次改了什么，写一条**中文单行、不超过 50 字、只讲大致修改方向**的提交信息（不带 `feat:` / `fix:` 前缀），把全部改动连同未跟踪的新文件一起提交。
3. Git 提交后自动推送；被拒先 `git pull --rebase` 再推；rebase 冲突则 `git rebase --abort` 并报告冲突文件。SVN 直接 `svn --non-interactive commit` 进服务器。
4. 最后一行汇报：提交号、提交信息、改动文件数、推送结果。

没有未提交改动时只回一句「当前没有未提交的改动」，不会改动任何文件。

## 设计取舍

插件本身只有两个文件、约 250 行，**不跑 git、不调模型、不带技能**：

- 判断仓库类型、读 diff、写提交信息、提交与推送，都交给当前会话的 Agent —— 它本来就有这些工具、审批链路和对话上下文，插件重复实现只会更差。
- 按钮只走 Host 的 `sessionController.prompt`（`mode: "queue"`，不打断正在跑的那一轮）代替用户发一条自包含中文指令，所以在对话里看起来就像你自己打了一段话。
- 万一宿主没暴露 `session.prompt`，会退化成把指令填进输入框（提示「已填入」），功能不丢。
- 槽位注册失败一律就地吞掉：客户端插件 `apply` 抛错会让 entry 变 `failed`，桌面端会直接打不开。

## 安装

```bash
dsh plugin --profile desktop install dsh-commit
```

或在本仓库目录下执行：

```bash
dsh plugin --profile desktop install .
```

装完刷新 Web 界面，输入栏左侧即可看到「提交」按钮。

## 开发

```bash
node test/offline-regression.mjs   # 离线回归：槽位落座、指令内容、连点防抖、降级路径等
```

`test/harness.mjs` 是纯桩环境：用 `__ModuleLoader__` 载入 `lib/client.js`，配一个真 hook 语义的 React 桩与 slots 桩，因此不需要起宿主也能跑。

## 结构

| 文件 | 作用 |
| --- | --- |
| `lib/client.js` | Web 端按钮 + 指令文本（唯一有逻辑的部分） |
| `lib/index.js` | 宿主半入口（空 `apply`，仅为保持 bundle 形态） |
| `cordis.patch.yml` | 把插件插进 profile 的配置补丁 |
| `test/offline-regression.mjs` | 离线回归测试 |

## License

MIT