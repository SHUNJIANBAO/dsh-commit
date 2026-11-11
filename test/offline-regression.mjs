// dsh-commit 离线回归：list 槽位落座 + 点击代发指令 + 降级填草稿 + 失败提示。
//
// 跑法：node test/offline-regression.mjs
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createChecker, createSlotsCore, loadClientPlugin, makeSlots, mount } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = loadClientPlugin(path.join(here, "..", "lib", "client.js"));
const { check, report } = createChecker();

/** 让 promise 链结算。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 只声明本插件要用的那一个 list 槽位。 */
function declareComposerLeft(core) {
  core.register({
    name: "root",
    children: {
      "conversation.input.left": { kind: "list", scope: "session" }
    }
  }, "ROOT");
}

/**
 * 造一个可交互的夹具。
 *
 * @param promptImpl - remote.session.prompt 的实现；传 null 表示宿主没暴露该 API
 *   （`ctx.remote` 里没有 session.prompt），用于验证降级填草稿。
 */
function mountButton({ promptImpl = async () => ({ accepted: true }), inputActions, sessionId = "session-1", locked = false } = {}) {
  const core = createSlotsCore();
  declareComposerLeft(core);
  const calls = [];
  const drafts = [];
  const ctx = { slots: makeSlots(core) };
  if (promptImpl === null) {
    /* 宿主没暴露 session.prompt：remote 门面存在但没有 session 命名空间。 */
    ctx.remote = {};
  } else {
    ctx.remote = {
      session: {
        prompt: async (request, signal) => {
          calls.push({ request, signal });
          return promptImpl(request);
        }
      }
    };
  }
  plugin.apply(ctx);

  const entry = core.entries("conversation.input.left")[0];
  const actions = inputActions === undefined
    ? { setDraft: (text) => { drafts.push(text); } }
    : inputActions;
  const props = () => ({
    sessionId,
    locked,
    useInput: (selector) => selector({ draft: "已有草稿" }),
    inputActions: actions
  });

  let fixture = mount(plugin.react, entry.component, props());
  const button = () => fixture.element.children[0];
  /* 徽标是条件渲染的兄弟节点（失败徽标在前、已填入在后），按 role=status 找。 */
  const badge = () => {
    const node = (fixture.element.children || []).slice(1)
      .find((child) => child && typeof child === "object" && child.props && child.props.role === "status");
    return node ? node.children[0] : null;
  };

  return {
    core,
    entry,
    get calls() { return calls; },
    get drafts() { return drafts; },
    get disabled() { return button().props.disabled === true; },
    get label() { return button().children[1].children[0]; },
    get title() { return button().props.title; },
    get badge() { return badge(); },
    async click() {
      button().props.onClick();
      await settle();
      fixture.setProps({});
    },
    rerender() { fixture.setProps({}); }
  };
}

// ── 1. 依赖面 ──
{
  console.log("\n1. 依赖面");
  check("inject = [slots, remote]", JSON.stringify(plugin.inject) === JSON.stringify(["slots", "remote"]));
}

// ── 2. 落在输入栏左侧的 list 槽位 ──
{
  console.log("\n2. 槽位落座");
  const fixture = mountButton();
  check("conversation.input.left 上注册了一个条目", fixture.core.entries("conversation.input.left").length === 1);
  check("id = dsh-commit", fixture.entry.options.id === "dsh-commit");
  check("label = 提交", fixture.entry.options.label === "提交");
  check("kind 是 list（不是影子替换）", fixture.core.spec("conversation.input.left").kind === "list");
  check("两次 apply 不会抛错（重复挂载安全）", (() => {
    try {
      plugin.apply({ slots: makeSlots(createSlotsCore()), remote: {} });
      return true;
    } catch (error) {
      return false;
    }
  })());
  check("样式已注入", plugin.__styleText().includes(".dsc-btn"));
}

// ── 3. 点击 = 代替用户发一条指令 ──
{
  console.log("\n3. 点击发送指令");
  const fixture = mountButton();
  check("初始可点击", fixture.disabled === false);
  check("按钮文案 = 提交", fixture.label === "提交");
  await fixture.click();
  check("调用了 session.prompt 一次", fixture.calls.length === 1);

  const { request, signal } = fixture.calls[0] || {};
  check("request.sessionId = 当前会话", request?.sessionId === "session-1");
  check("request.mode = queue（不打断正在跑的那一轮）", request?.mode === "queue");
  check("requestId 非空", typeof request?.requestId === "string" && request.requestId.length > 8);
  check("content 是单段 text", Array.isArray(request?.content) && request.content.length === 1
    && request.content[0].type === "text" && typeof request.content[0].text === "string");
  check("传了 AbortSignal", signal !== undefined);
  check("clientTimeZone 是 IANA 字符串（有 Intl 时）", request?.clientTimeZone === undefined
    || typeof request.clientTimeZone === "string");
  check("发送后不再显示失败/已填入", fixture.badge === null);
}

// ── 4. 指令内容覆盖全部约定 ──
{
  console.log("\n4. 指令内容");
  const fixture = mountButton();
  await fixture.click();
  const text = fixture.calls[0]?.request.content[0].text ?? "";
  const must = [
    ["先探测 Git", "git rev-parse --is-inside-work-tree"],
    ["再探测 SVN", "svn info"],
    ["两都不是就只回一句", "当前项目不是 Git 也不是 SVN 仓库，没有执行任何操作"],
    ["干净时只回一句", "当前没有未提交的改动"],
    ["全部改动一起暂存", "git add -A"],
    ["中文单行 ≤50 字", "不超过 50 字"],
    ["不加前缀", "feat:/fix:"],
    ["自动推送", "git push -u origin HEAD"],
    ["推不动先拉再推", "git pull --rebase"],
    ["冲突就 abort", "git rebase --abort"],
    ["沙箱阻拦时提权重试", "danger-full-access"],
    ["SVN 未版本化先 add", "svn add"],
    ["SVN 过期先 update", "svn --non-interactive update"],
    ["SVN 绝不 revert", "绝不 `svn revert`"],
    ["SVN commit 直接进服务器", "svn --non-interactive commit"],
    ["git 不卡凭据输入", "GIT_TERMINAL_PROMPT=0"],
    ["SVN 汇报用 last-changed-rev", "svn info --show-item last-changed-rev"],
    ["最后一行汇报", "只用一行汇报结果"],
    ["不做敏感文件检查", "不要做敏感文件检查"]
  ];
  for (const [label, needle] of must) check(`提到：${label}`, text.includes(needle));
  check("指令里不含占位符残留", !/TODO|<[a-z-]+>/.test(text.replace("<当前分支名>", "")));
}

// ── 5. 连点不重复发送 / 忙碌态 ──
{
  console.log("\n5. 连点防抖");
  let release;
  const fixture = mountButton({ promptImpl: () => new Promise((resolve) => { release = resolve; }) });
  await fixture.click();
  check("忙碌时按钮禁用", fixture.disabled === true);
  check("忙碌时文案 = 提交中", fixture.label === "提交中");
  await fixture.click();
  await fixture.click();
  check("忙碌期间再点不会重复发送", fixture.calls.length === 1);
  release({ accepted: true });
  await settle();
  await settle();
  fixture.rerender();
  check("发送完成后恢复可点击", fixture.disabled === false);
  check("发送完成后文案回到 提交", fixture.label === "提交");
}

// ── 6. 每次请求的 requestId 都不同 ──
{
  console.log("\n6. requestId 唯一");
  const fixture = mountButton();
  await fixture.click();
  await fixture.click();
  const ids = fixture.calls.map((call) => call.request.requestId);
  check("两次点击都发送了", ids.length === 2);
  check("requestId 不重复", ids[0] !== ids[1]);
}

// ── 7. 失败要看得见 ──
{
  console.log("\n7. 失败提示");
  const fixture = mountButton({ promptImpl: async () => { throw new Error("agent-busy"); } });
  await fixture.click();
  check("显示「失败」徽标", fixture.badge === "失败");
  check("title 带真实错误", String(fixture.title).includes("agent-busy"));
  check("失败后按钮仍可再试", fixture.disabled === false);
}

// ── 8. 宿主没暴露 session.prompt 时降级填草稿 ──
{
  console.log("\n8. 降级填草稿");
  const fixture = mountButton({ promptImpl: null });
  await fixture.click();
  check("没有发任何 prompt", fixture.calls.length === 0);
  check("setDraft 被调用", fixture.drafts.length === 1);
  const filled = fixture.drafts[0] ?? "";
  check("保留原草稿并追加指令", filled.startsWith("已有草稿") && filled.includes("一键提交"));
  check("显示「已填入」提示", fixture.badge === "已填入");
  check("title 提示按回车发送", String(fixture.title).includes("按回车发送"));
}

// ── 9. 没有会话 / 被锁定时不可点 ──
{
  console.log("\n9. 不可点状态");
  const noSession = mountButton({ sessionId: null });
  check("没有 sessionId 时禁用", noSession.disabled === true);
  await noSession.click();
  check("没有 sessionId 时点击不发请求", noSession.calls.length === 0);

  const locked = mountButton({ locked: true });
  check("locked 时禁用", locked.disabled === true);
  await locked.click();
  check("locked 时点击不发请求", locked.calls.length === 0);
}

// ── 10. 宿主侧入口 ──
{
  console.log("\n10. 宿主半入口");
  const host = await import(pathToFileURL(path.join(here, "..", "lib", "index.js")).href);
  check("导出 name", host.name === "dsh-commit");
  check("不注入任何宿主能力", Array.isArray(host.inject) && host.inject.length === 0);
  check("apply 可调用且不抛错", (() => {
    try {
      host.apply();
      return true;
    } catch (error) {
      return false;
    }
  })());
}

report();