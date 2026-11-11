/**
 * dsh-commit 宿主半：本插件不需要任何宿主能力。
 *
 * 功能全部在浏览器半（lib/client.js）：按钮点击后用 `ctx.remote.session.prompt`
 * 代替用户发一条指令，由当前会话的 Agent 自己识别版本库、读差异、写提交信息、
 * 提交并推送。因此这里只提供一个空的 apply，让 bundle patch 里的那一行有宿主侧
 * 条目可以挂载。
 */

export const name = 'dsh-commit';

export const inject = [];

export function apply() {}