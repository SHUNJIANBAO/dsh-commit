window.__ModuleLoader__.load({
  id: "dsh-commit",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    /* 两件依赖：slots 用来在输入栏左侧落座，remote 用来代替用户发一条 prompt。
     * 插件自己不跑 git、不调模型——那一轮的判断、总结与提交都交给当前会话的 Agent，
     * 这样复用它的工具、审批与对话上下文，插件本身只有几十行。 */
    const inject = ["slots", "remote"];

    /**
     * 点击按钮时代替用户发出的指令。
     *
     * 整段自包含：不依赖本插件的宿主半、不依赖历史对话、也不依赖任何技能注册，
     * 因此在会话里看起来就像用户自己打了一段话。
     */
    const COMMIT_INSTRUCTION = [
      "一键提交：按下面的流程执行，全程不要问我问题。",
      "1. 判断版本库：`git rev-parse --is-inside-work-tree` 成功就是 Git；否则 `svn info` 成功就是 SVN；两个都不是，就只回一句「当前项目不是 Git 也不是 SVN 仓库，没有执行任何操作」并结束，不要改动任何文件。",
      "2. Git 仓库：`git status --short` 没有输出就只回一句「当前没有未提交的改动」并结束。否则用 `git diff`（必要时连同未跟踪文件的内容）看清这次改了什么，再 `git add -A` 把全部改动和未跟踪的新文件一起加入暂存区，写一条中文单行、不超过 50 字、只讲大致修改方向、不带 feat:/fix: 之类前缀的提交信息并 commit。",
      "3. 提交后推送：没有上游用 `git push -u origin HEAD`；被拒绝就先 `git pull --rebase origin <当前分支名>` 再 push；rebase 出现冲突立即 `git rebase --abort`（保持已提交、未推送的状态）并把冲突文件告诉我。git 命令都带上 `GIT_TERMINAL_PROMPT=0`，避免卡在凭据输入上。如果 push 报 `cannot create standard input pipe` 或 `Permission denied`，说明当前命令沙箱不允许 git 创建子进程管道：改用完整访问权限（danger-full-access）重试这一条 push，并在汇报里说明是提升权限后才推上去的。",
      "4. SVN 工作副本：`svn --non-interactive status` 没有输出就只回一句「当前没有未提交的改动」并结束。否则未版本化的 `?` 文件先 `svn add`；提交前先 `svn --non-interactive update`，出现 `C` 冲突就停下把冲突文件告诉我、绝不 `svn revert`；没有冲突就用同样格式的提交信息 `svn --non-interactive commit`（它直接进服务器，不需要再推送）；如果 commit 因 out of date 被拒，先 update 再重试一次。",
      "5. 最后只用一行汇报结果：提交号（SVN 用 `svn info --show-item last-changed-rev`）、提交信息、改动文件数、推送结果（SVN 说明是否已提交到服务器）。不要做敏感文件检查，也不要额外追问。"
    ].join("\n");

    if (typeof document !== "undefined" && !document.getElementById("dsh-commit-style")) {
      const style = document.createElement("style");
      style.id = "dsh-commit-style";
      style.textContent = [
        ".dsc-wrap{display:inline-flex;align-items:center;vertical-align:middle;}",
        ".dsc-btn{min-width:0;max-width:140px;height:28px;border-radius:var(--dsw-radius-sm,6px);font-size:13px;font-weight:500;line-height:20px;display:inline-flex;align-items:center;gap:4px;padding:0 8px;border:none;cursor:pointer;outline:none;user-select:none;transition:background-color .15s,color .15s;background:transparent;color:var(--dsw-alias-label-secondary);}",
        ".dsc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}",
        ".dsc-btn:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));}",
        ".dsc-btn:disabled{color:var(--dsw-alias-label-dimmed);opacity:.6;cursor:default;}",
        ".dsc-icon{flex:none;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;}",
        ".dsc-icon svg{width:14px;height:14px;display:block;}",
        ".dsc-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden;}",
        ".dsc-badge{color:var(--dsw-alias-state-error-primary,#d03050);font-size:11px;margin-left:4px;white-space:nowrap;}",
        ".dsc-badge-hint{color:var(--dsw-alias-label-secondary);font-size:11px;margin-left:4px;white-space:nowrap;}"
      ].join("\n");
      document.head.appendChild(style);
    }

    /** 内联 SVG：向上箭头 + 托盘（提交/上传的通用隐喻）。 */
    function CommitIcon() {
      return react.createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          fill: "none",
          xmlns: "http://www.w3.org/2000/svg",
          "aria-hidden": "true"
        },
        react.createElement("path", {
          d: "M8 10.4V2.9",
          stroke: "currentColor",
          strokeWidth: "1.2",
          strokeLinecap: "round"
        }),
        react.createElement("path", {
          d: "M4.95 5.95 8 2.9l3.05 3.05",
          stroke: "currentColor",
          strokeWidth: "1.2",
          strokeLinecap: "round",
          strokeLinejoin: "round"
        }),
        react.createElement("path", {
          d: "M2.9 9.6v2.1c0 .83.67 1.5 1.5 1.5h7.2c.83 0 1.5-.67 1.5-1.5V9.6",
          stroke: "currentColor",
          strokeWidth: "1.2",
          strokeLinecap: "round"
        })
      );
    }

    /** 只有「宿主没暴露 session.prompt」才走填草稿的降级路径，别的错误照常报错。 */
    function promptUnavailable() {
      const error = new Error("remote session prompt service unavailable");
      error.code = "prompt-unavailable";
      return error;
    }

    function currentTimeZone() {
      try {
        const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
        return typeof zone === "string" && zone ? zone : undefined;
      } catch (error) {
        return undefined;
      }
    }

    function makeRequestId() {
      return "dsh-commit-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    }

    /**
     * 代替用户把指令发进当前会话（等价于在输入框里打完按回车）。
     *
     * 走 Host 的 sessionController.prompt：mode 用 queue，正在跑的那一轮不会被
     * 打断，本指令排在它后面执行。
     */
    async function sendInstruction(ctx, sessionId) {
      const remote = ctx.remote;
      const session = remote ? remote.session : undefined;
      if (!session || typeof session.prompt !== "function") throw promptUnavailable();

      const request = {
        requestId: makeRequestId(),
        sessionId,
        mode: "queue",
        content: [{ type: "text", text: COMMIT_INSTRUCTION }]
      };
      const timeZone = currentTimeZone();
      if (timeZone) request.clientTimeZone = timeZone;

      const signal = typeof AbortController === "function" ? new AbortController().signal : undefined;
      const result = signal ? await session.prompt(request, signal) : await session.prompt(request);
      if (result && result.ok === false) {
        const detail = result.error ? (result.error.message || result.error.code) : "";
        throw new Error(detail || "指令发送失败");
      }
      return result;
    }

    /** 组件工厂：把 ctx 收进闭包，注册出去的只是组件本身。 */
    function makeCommitButton(ctx) {
      return function CommitButton(props) {
        const [busy, setBusy] = react.useState(false);
        const [error, setError] = react.useState(null);
        const [filled, setFilled] = react.useState(false);

        const sessionId = props.sessionId;
        const locked = props.locked === true;
        const actions = props.inputActions;
        /* 槽位标准 props：useInput 给当前草稿，inputActions.setDraft 整段改写草稿。 */
        const draft = typeof props.useInput === "function"
          ? (props.useInput((state) => (state ? state.draft : "")) || "")
          : "";

        const run = () => {
          if (busy || locked || !sessionId) return;
          setBusy(true);
          setError(null);
          setFilled(false);
          sendInstruction(ctx, sessionId).then(() => {
            /* 指令已排队，下一轮对话里立刻能看到，这里不用再提示。 */
          }, (reason) => {
            if (reason && reason.code === "prompt-unavailable"
              && actions !== undefined && typeof actions.setDraft === "function") {
              /* 极端情况（宿主没暴露 session.prompt）：退化成把指令填进输入框，功能不丢。 */
              actions.setDraft(draft && draft.trim() ? draft + "\n" + COMMIT_INSTRUCTION : COMMIT_INSTRUCTION);
              setFilled(true);
              return;
            }
            setError(reason instanceof Error ? reason.message : String(reason));
          }).finally(() => {
            setBusy(false);
          });
        };

        const title = error
          || (filled ? "已填入输入框，按回车发送" : "检查当前项目的版本库，总结改动并提交（Git 会顺带推送）");

        return react.createElement(
          "span",
          { className: "dsc-wrap" },
          react.createElement(
            "button",
            {
              type: "button",
              className: "dsc-btn",
              "aria-label": "提交当前改动",
              title,
              disabled: busy || locked || !sessionId,
              onClick: run
            },
            react.createElement("span", { className: "dsc-icon" }, react.createElement(CommitIcon, null)),
            react.createElement("span", { className: "dsc-label" }, busy ? "提交中" : "提交")
          ),
          error && react.createElement("span", { className: "dsc-badge", role: "status" }, "失败"),
          !error && filled && react.createElement("span", { className: "dsc-badge-hint", role: "status" }, "已填入")
        );
      };
    }

    /**
     * 在 `conversation.input.left`（输入栏工具行左侧，list 槽位）落座，返回 disposer。
     *
     * 关键纪律：任何失败都就地吞掉，**绝不把异常抛出 apply** —— 静态客户端插件的
     * apply/effect 抛错会让该 entry 变成 "failed"，桌面端以
     * "web boot: N entry did not activate" 判定启动失败（表现为客户端打不开）。
     * 最坏情况只是本按钮不出现，宿主 UI 必须照常启动。
     */
    function seatCommitButton(ctx, component) {
      try {
        const dispose = ctx.slots.register(
          { name: "conversation.input.left", id: "dsh-commit", order: 0, label: "提交" },
          component
        );
        return typeof dispose === "function" ? dispose : () => {};
      } catch (error) {
        console.warn("[dsh-commit] 提交按钮落座失败（不影响宿主启动）：", error);
        return () => {};
      }
    }

    function apply(ctx) {
      try {
        ctx.slots.inject("conversation.input.left", () => seatCommitButton(ctx, makeCommitButton(ctx)));
      } catch (error) {
        console.warn("[dsh-commit] 注入槽位失败（不影响宿主启动）：", error);
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});