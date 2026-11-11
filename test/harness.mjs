// 离线回归测试骨架：让浏览器半（lib/client.js）能在 Node 里跑起来并断言状态机。
//
// 三块桩件：
//   1. React 桩 —— 带真实 hook 语义（useState 的 setter 触发重渲染、useEffect 在提交后执行）
//   2. SlotCore 桩 —— 按 DSH 的真实语义实现槽位注册（single 按 priority 去重、
//      list/keyed 按 id/key 去重、list 按 priority→order 排序）
//   3. 浏览器环境桩 —— window.__ModuleLoader__ / localStorage / document
//
// 不依赖从 app.asar 抽出来的产物，因此在任何机器上 `node test/offline-regression.mjs`
// 都能跑。真正的高保真验证（拿官方 SlotCore 跑）另有脚本，见各包 README。
import fs from "node:fs";

/** 带真实 hook 语义的极简 React 桩。 */
export function createReactStub() {
  let hooks = [];
  let cursor = 0;
  let pending = null;
  let rerender = null;

  return {
    createElement: (...args) => ({ type: args[0], props: args[1] ?? {}, children: args.slice(2) }),

    useState(initial) {
      const index = cursor++;
      if (hooks.length <= index) hooks[index] = { value: typeof initial === "function" ? initial() : initial };
      const slot = hooks[index];
      const setter = (next) => {
        const value = typeof next === "function" ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        if (rerender) rerender();
      };
      return [slot.value, setter];
    },

    useEffect(fn, deps) {
      const index = cursor++;
      const prev = hooks[index];
      const changed = prev === undefined || deps === undefined || deps.length === 0
        || prev.deps.length !== deps.length
        || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        hooks[index] = { deps: deps ?? null, cleanup: undefined };
        if (pending) pending.push({ index, fn });
      }
    },

    useRef(initial) {
      const index = cursor++;
      if (hooks.length <= index) hooks[index] = { current: initial };
      return hooks[index];
    },

    /** 测试驱动：丢弃全部 hook 状态（模拟"重新挂载一个全新组件实例"）。 */
    __reset() {
      hooks = [];
      cursor = 0;
      pending = null;
      rerender = null;
    },

    /** 测试驱动：渲染一次并冲刷本次渲染中变化的 effects。 */
    __mount(component, props) {
      rerender = null;
      cursor = 0;
      pending = [];
      const element = component(props);
      const queued = pending;
      pending = null;
      for (const { index, fn } of queued) {
        const cleanup = fn();
        if (typeof cleanup === "function" && hooks[index]) hooks[index].cleanup = cleanup;
      }
      return element;
    },

    /** 测试驱动：执行一次动作并处理它引起的重渲染。 */
    __act(action) {
      let rounds = 0;
      const flush = () => {
        if (rounds++ > 20) return;
        rerender = flush;
      };
      rerender = flush;
      action();
      rerender = null;
      return rounds;
    },
  };
}

/**
 * 槽位注册表桩：语义照 DSH 的真实规则。
 *   - single：同一 priority 只允许一个注册者，第二个直接抛错（"lowest renders"）
 *   - list / keyed：按 id / key 去重，同 id 视为替换那一个格子
 *   - list 渲染顺序：priority 升序 → order 升序 → 注册先后
 */
export function createSlotsCore() {
  const specs = new Map();
  const seats = new Map();

  const seatList = (name) => {
    if (!seats.has(name)) seats.set(name, []);
    return seats.get(name);
  };

  return {
    register(options, component) {
      if (options && options.children !== undefined) {
        for (const [child, spec] of Object.entries(options.children)) specs.set(child, { name: child, ...spec });
        return () => {};
      }
      const name = options?.name;
      const spec = specs.get(name);
      if (spec === undefined) throw new Error(`slot "${name}" is not declared`);
      const list = seatList(name);
      if (spec.kind === "single") {
        const priority = options.priority ?? 0;
        if (list.some((seat) => (seat.options.priority ?? 0) === priority)) {
          throw new Error(
            `single slot "${name}" already has a registration at priority ${priority}`
            + " — register at a different priority to shadow it (lowest renders)",
          );
        }
      } else {
        const key = spec.kind === "keyed" ? options.key : options.id;
        const index = list.findIndex((seat) => (spec.kind === "keyed" ? seat.options.key : seat.options.id) === key);
        if (index !== -1) list.splice(index, 1);
      }
      list.push({ options, component });
      return () => {
        const index = list.indexOf(list.find((seat) => seat.component === component && seat.options === options));
        if (index !== -1) list.splice(index, 1);
      };
    },

    spec: (name) => specs.get(name),

    entries(name) {
      const list = [...seatList(name)];
      if (specs.get(name)?.kind === "single") {
        return list.sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0));
      }
      return list.sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0)
        || (a.options.order ?? 0) - (b.options.order ?? 0));
    },
  };
}

/** 把 SlotCore 包成 ctx.slots：inject 立即回调（槽位已声明的前提下）。 */
export function makeSlots(core) {
  return {
    spec: (name) => core.spec(name),
    register: (options, component) => core.register(options, component),
    inject: (_name, callback) => {
      const dispose = callback();
      return () => { if (typeof dispose === "function") dispose(); };
    },
  };
}

/** 声明一个只含 conversation.input.right / conversation.input.plan 的根槽位。 */
export function declareComposerSeats(core) {
  core.register({
    name: "root",
    children: {
      "conversation.input.right": { kind: "list", scope: "session" },
      "conversation.input.plan": { kind: "single", scope: "session" },
    },
  }, "ROOT");
}

/**
 * 在桩件环境里执行一个浏览器半插件，返回它的 exports。
 *
 * @param clientFile - lib/client.js 的绝对路径。
 * @param extraModules - 额外的 require 桩（如 remote 服务）。
 * @returns 插件 exports，并附带 `react` 字段供测试驱动。
 */
export function loadClientPlugin(clientFile, extraModules = {}) {
  const reactStub = createReactStub();
  const store = new Map();
  let captured = null;

  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    __ModuleLoader__: {
      load({ factory }) {
        captured = factory((id) => {
          if (id === "react") return reactStub;
          if (Object.hasOwn(extraModules, id)) return extraModules[id];
          throw new Error("unexpected require: " + id);
        });
      },
    },
  };
  globalThis.localStorage = globalThis.window.localStorage;
  // 记录注入的 <style> 节点，便于对 CSS 本身做断言（如"菜单背景必须不透明"）。
  const styleNodes = [];
  globalThis.document = {
    getElementById: () => null,
    createElement: () => {
      const node = { id: "", textContent: "" };
      styleNodes.push(node);
      return node;
    },
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  new Function(fs.readFileSync(clientFile, "utf8"))();
  if (captured === null) throw new Error("插件没有向模块加载器注册自己");
  captured.react = reactStub;
  captured.__styleText = () => styleNodes.map((node) => node.textContent).join("\n");
  return captured;
}

/**
 * 挂载组件并反复渲染到收敛。每次调用都从空 hook 状态开始（= 全新组件实例），
 * 这样夹具之间不会互相继承 useState；跨挂载要保留的状态必须走 localStorage。
 *
 * @param reactStub - React 桩。
 * @param component - 槽位组件。
 * @param props - 首次渲染的 props。
 * @returns `{ element, setProps }`。
 */
export function mount(reactStub, component, props) {
  reactStub.__reset();
  let currentProps = props;
  let element;
  const renderStable = () => {
    for (let i = 0; i < 12; i += 1) element = reactStub.__mount(component, currentProps);
    return element;
  };
  element = renderStable();
  return {
    get element() { return element; },
    setProps(next) {
      currentProps = { ...currentProps, ...next };
      element = renderStable();
      return element;
    },
  };
}

/**
 * 与真实 `ctx.skills.registerProvider` 一样严格的桩。
 *
 * 真实签名是 `registerProvider(create: (control) => SkillProvider)` —— 收的是**工厂函数**。
 * 桩如果把参数直接当 provider 对象用，就会掩盖"传了对象而不是函数"这类契约错误
 * （真踩过：真实宿主里报 `TypeError: create is not a function`，被 apply 的 try/catch
 * 吞成一条 warn，表现成"技能静默消失"，而离线测试全绿）。
 *
 * @param assign - 收到实例化后的 provider 时调用。
 * @returns 可直接放进假 ctx.skills 的 registerProvider。
 */
export function registerSkillProviderFake(assign) {
  return (create) => {
    if (typeof create !== "function") throw new TypeError("create is not a function");
    const provider = create({ signal: new AbortController().signal, invalidate: () => {} });
    if (provider === null || typeof provider !== "object") throw new TypeError("create() must return a skill provider");
    if (typeof provider.name !== "string" || typeof provider.list !== "function" || typeof provider.get !== "function") {
      throw new TypeError("a skill provider must expose name, list() and get()");
    }
    assign(provider);
  };
}

/** 断言收集器：全部跑完统一报告并给退出码。 */
export function createChecker() {
  const failures = [];
  return {
    check(label, condition) {
      console.log((condition ? "  PASS  " : "  FAIL  ") + label);
      if (!condition) failures.push(label);
    },
    report() {
      console.log("\n" + (failures.length === 0 ? "全部通过 ✅" : "失败项：" + failures.join(" | ")));
      process.exit(failures.length === 0 ? 0 : 1);
    },
  };
}
