// src/provider.mjs
import { randomUUID as randomUUID2 } from "node:crypto";
import { isAbsolute as isAbsolute2 } from "node:path";

// src/zcode-cli.mjs
import { execFile } from "node:child_process";
import { access, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
var COMMAND_VARIABLE = "GECKIT_ZCODE_COMMAND";
var NODE_AT_LEAST = [22, 19, 0];
var runnable = (path) => access(path, constants.X_OK).then(() => true, () => false);
async function candidates(environment) {
  const found = [];
  const override = environment[COMMAND_VARIABLE]?.trim();
  if (override) found.push({ path: override, from: "GECKIT_ZCODE_COMMAND" });
  for (const folder of (environment.PATH ?? "").split(delimiter)) {
    if (folder !== "") found.push({ path: join(folder, "zcode"), from: "PATH" });
  }
  const nvm = join(homedir(), ".nvm", "versions", "node");
  const versions = await readdir(nvm).catch(() => []);
  versions.sort((a, b) => compareVersions(parseVersion(b), parseVersion(a)));
  for (const version of versions) found.push({ path: join(nvm, version, "bin", "zcode"), from: "npm (nvm)" });
  for (const fnm of fnmDirectories(environment)) {
    found.push({ path: join(fnm, "aliases", "default", "bin", "zcode"), from: "npm (fnm default)" });
    const installed = await readdir(join(fnm, "node-versions")).catch(() => []);
    installed.sort((a, b) => compareVersions(parseVersion(b), parseVersion(a)));
    for (const version of installed) {
      found.push({ path: join(fnm, "node-versions", version, "installation", "bin", "zcode"), from: "npm (fnm)" });
    }
  }
  for (const folder of ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), join(homedir(), ".npm-global", "bin")]) {
    found.push({ path: join(folder, "zcode"), from: "npm" });
  }
  return found;
}
function fnmDirectories(environment) {
  const bases = [];
  const add = (dir) => {
    if (dir && !bases.includes(dir)) bases.push(dir);
  };
  if (environment.FNM_DIR?.trim()) add(environment.FNM_DIR.trim());
  if (environment.XDG_DATA_HOME?.trim()) add(join(environment.XDG_DATA_HOME.trim(), "fnm"));
  add(join(homedir(), ".local", "share", "fnm"));
  return bases;
}
var parseVersion = (text) => {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return match === null ? void 0 : match.slice(1, 4).map(Number);
};
function compareVersions(a, b) {
  if (a === void 0 || b === void 0) return a === b ? 0 : a === void 0 ? -1 : 1;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
function runOnce(command, args, { env, cwd, timeoutMs = 15e3 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { env, cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) rejectPromise(Object.assign(new Error(`${String(stderr).trim() || error.message}`), { code: error.code }));
      else resolvePromise(String(stdout));
    });
  });
}
async function nodeBeside(bin, environment) {
  const folder = dirname(bin);
  const node = join(folder, "node");
  const command = await runnable(node) ? node : "node";
  const env = { ...environment, PATH: `${folder}${delimiter}${environment.PATH ?? ""}` };
  const version = parseVersion(await runOnce(command, ["--version"], { env }).catch(() => ""));
  return { folder, version, command };
}
async function findZcode(environment = process.env) {
  let tooOld;
  const seen = /* @__PURE__ */ new Set();
  for (const candidate of await candidates(environment)) {
    if (!await runnable(candidate.path)) continue;
    const path = await realpath(candidate.path).catch(() => candidate.path);
    if (seen.has(path)) continue;
    seen.add(path);
    const node = await nodeBeside(candidate.path, environment);
    if (compareVersions(node.version, NODE_AT_LEAST) < 0) {
      tooOld ??= { ...candidate, node: node.version?.join(".") };
      continue;
    }
    return { command: candidate.path, path, from: candidate.from, nodeFolder: node.folder, node: node.command };
  }
  if (tooOld !== void 0) {
    return { unusable: `zcode at ${tooOld.path} runs under Node ${tooOld.node ?? "unknown"}; it needs Node ${NODE_AT_LEAST.join(".")} or newer.` };
  }
  return { unusable: "zcode is not installed. Install it with `npm install -g zcode-app-cli` and sign in with `zcode login`." };
}
function zcodeEnvironment(found, environment = process.env, extra = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!key.startsWith("GECKIT_")) clean[key] = value;
  }
  clean.PATH = `${found.nodeFolder}${delimiter}${clean.PATH ?? ""}`;
  return { ...clean, ...extra };
}
function parseProgram(stdout) {
  const cli = /zcode-app-cli\s+(\S+)/.exec(stdout ?? "");
  const runtime = /zcode-runtime\s+(\S+)/.exec(stdout ?? "");
  if (cli === null && runtime === null) return void 0;
  return { version: cli?.[1] ?? runtime[1], ...runtime === null ? {} : { runtime: runtime[1] } };
}
async function zcodeProgram(found, environment = process.env) {
  if (found.unusable !== void 0) return void 0;
  const stdout = await runOnce(found.command, ["--version"], { env: zcodeEnvironment(found, environment) }).catch(() => void 0);
  const program = parseProgram(stdout);
  return program === void 0 ? void 0 : { version: program.version, from: found.from, path: found.path };
}

// src/zcode-driver.mjs
import { spawn } from "node:child_process";
import { mkdtemp as mkdtemp2, rm as rm3, writeFile as writeFile3 } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join4 } from "node:path";

// src/zcode-approval.mjs
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir as homedir2, tmpdir } from "node:os";
import { join as join2 } from "node:path";
var SOCKET_VARIABLE = "GECKIT_ZCODE_APPROVAL_SOCKET";
var HOOK_TIMEOUT_MS = 60 * 6e4;
var HOOK_SOURCE = `import { connect } from 'node:net'
const socket = process.env.${SOCKET_VARIABLE}
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const say = (decision, reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }))
}
let asked
try { asked = JSON.parse(input) } catch { process.exit(0) }
if (!socket || asked.hookEventName !== 'PreToolUse' || asked.mode === 'plan' || asked.sideEffectScope === 'none') process.exit(0)
const request = { toolName: asked.toolName, toolInput: asked.toolInput, toolCallId: asked.toolCallId, riskLevel: asked.riskLevel, sessionId: asked.sessionId }
await new Promise((done) => {
  let answer = ''
  const client = connect(socket, () => client.write(JSON.stringify(request) + '\\n'))
  client.setEncoding('utf8')
  client.on('data', (chunk) => { answer += chunk })
  client.on('end', () => {
    try {
      const parsed = JSON.parse(answer)
      say(parsed.decision === 'allow' ? 'allow' : 'deny', String(parsed.reason ?? ''))
    } catch { say('deny', 'GeckIt did not answer the approval.') }
    done()
  })
  client.on('error', () => { say('deny', 'GeckIt is not reachable for approvals, so this was not allowed.'); done() })
})
`;
async function personSettings(environment = process.env) {
  const own = environment.ZCODE_CLI_SETTINGS_FILE?.trim();
  const path = own || join2(homedir2(), ".zcode", "cli", "setting.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function settingsWithHook(settings, hookCommand) {
  const hooks = settings.hooks ?? {};
  const theirs = hooks.enabled === false ? {} : hooks.events ?? {};
  const ours = { hooks: [{ type: "command", command: hookCommand, timeoutMs: HOOK_TIMEOUT_MS, onError: "deny" }] };
  return {
    ...settings,
    hooks: {
      ...hooks,
      enabled: true,
      events: { ...theirs, PreToolUse: [...theirs.PreToolUse ?? [], ours] }
    }
  };
}
var quoted = (path) => `'${path.replaceAll("'", "'\\''")}'`;
async function openApprovals({ decide, node, environment = process.env, log = () => {
} }) {
  const folder = await mkdtemp(join2(tmpdir(), "gz-"));
  await chmod(folder, 448);
  const socket = join2(folder, "ask.sock");
  const hook = join2(folder, "pretooluse.mjs");
  await writeFile(hook, HOOK_SOURCE, { mode: 384 });
  const server = createServer((connection) => answer(connection, decide, log));
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(socket, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  await chmod(socket, 384);
  const settingsFolder = join2(folder, "settings");
  await mkdir(settingsFolder, { mode: 448 });
  const settingsFile = join2(settingsFolder, "setting.json");
  const hookCommand = `${node === "node" ? "node" : quoted(node)} ${quoted(hook)}`;
  return {
    /** Rewritten before every turn, so a change the person made since is in. */
    async prepare() {
      const settings = settingsWithHook(await personSettings(environment), hookCommand);
      await writeFile(settingsFile, JSON.stringify(settings, null, 2), { mode: 384 });
      return { ZCODE_CLI_SETTINGS_FILE: settingsFile, [SOCKET_VARIABLE]: socket };
    },
    async close() {
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
      await rm(folder, { recursive: true, force: true });
    }
  };
}
function answer(connection, decide, log) {
  let received = "";
  connection.setEncoding("utf8");
  connection.on("data", async (chunk) => {
    received += chunk;
    const newline = received.indexOf("\n");
    if (newline < 0) return;
    let request;
    try {
      request = JSON.parse(received.slice(0, newline));
    } catch {
      connection.end(JSON.stringify({ decision: "deny", reason: "Unreadable approval request." }));
      return;
    }
    const decided = await Promise.resolve(decide({ ...request, ask: `zcode-ask:${request.toolCallId ?? randomUUID()}` })).catch(() => ({ decision: "deny", reason: "GeckIt could not decide." }));
    log("info", "approval.decided", { decision: decided.decision });
    connection.end(JSON.stringify(decided));
  });
  connection.on("error", () => {
  });
}

// src/zcode-events.mjs
import { isAbsolute, relative } from "node:path";
var DETAIL_LIMIT = 8e3;
var WRITE_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
var SHELL_TOOLS = /* @__PURE__ */ new Set(["Bash", "Shell", "BashOutput"]);
var shorten = (text, limit = DETAIL_LIMIT) => text.length > limit ? `${text.slice(0, limit)}
\u2026` : text;
var firstLine = (text) => String(text ?? "").split("\n")[0].slice(0, 200);
function shownPath(root, path) {
  if (typeof path !== "string" || path === "") return void 0;
  if (!isAbsolute(path)) return path;
  const inside = relative(root, path);
  return inside === "" || inside.startsWith("..") || isAbsolute(inside) ? path : inside;
}
var fileOf = (input) => typeof input?.file_path === "string" ? input.file_path : typeof input?.path === "string" ? input.path : void 0;
function describeTool(root, name, input = {}) {
  if (SHELL_TOOLS.has(name) && typeof input.command === "string") return `${name} ${firstLine(input.command)}`;
  const file = fileOf(input);
  if (file !== void 0) return `${name} ${shownPath(root, file)}`;
  if (typeof input.url === "string") return `${name} ${input.url}`;
  for (const key of ["pattern", "query", "description", "prompt"]) {
    if (typeof input[key] === "string") return `${name} ${firstLine(input[key])}`;
  }
  return name;
}
function wantedOf(name, input = {}) {
  if (SHELL_TOOLS.has(name) && typeof input.command === "string") return { kind: "command", command: input.command };
  const file = fileOf(input);
  if (WRITE_TOOLS.has(name) && file !== void 0) return { kind: "write", paths: [file] };
  if (name === "Read" && file !== void 0) return { kind: "read", path: file };
  if (typeof input.url === "string" && /^https?:\/\//.test(input.url)) return { kind: "web", url: input.url };
  return { kind: "other", tool: name, detail: shorten(JSON.stringify(input, null, 2), 4e3) };
}
function endingOf(text) {
  const said = String(text ?? "");
  if (/\b(401|403)\b|unauthori[sz]ed|not (signed|logged) in|sign in|log ?in again|credential|token (expired|invalid)/i.test(said)) return "signedOut";
  if (/\b429\b|rate.?limit|quota|usage limit|too many requests|insufficient (balance|credit)/i.test(said)) return "limit";
  return "failed";
}
var errorText = (error) => [error?.message, error?.detail, error?.code, error?.type].filter((part) => typeof part === "string" && part !== "").join(" \xB7 ");
function turnReader(root) {
  const texts = /* @__PURE__ */ new Map();
  const thoughts = /* @__PURE__ */ new Map();
  const tools = /* @__PURE__ */ new Map();
  const state = { session: void 0, model: void 0, completed: false, failure: void 0, result: void 0, denied: [], askedUser: false };
  const theirs = (id, at) => ({ kind: "theirs", id: `zcode:${id}`, text: texts.get(id), ...at === void 0 ? {} : { at } });
  function streamed(payload, at, out) {
    const id = payload.assistantMessageId;
    if (payload.kind === "text_delta" && typeof payload.delta === "string" && payload.delta !== "") {
      texts.set(id, `${texts.get(id) ?? ""}${payload.delta}`);
      out.items.push(theirs(id, at));
    } else if (payload.kind === "reasoning_delta" && typeof payload.delta === "string" && payload.delta !== "") {
      thoughts.set(id, `${thoughts.get(id) ?? ""}${payload.delta}`);
      out.items.push({ kind: "thought", id: `zcode:${id}:thinking`, text: thoughts.get(id) });
    } else if (payload.kind === "tool_call") {
      const file = fileOf(payload.input);
      const tool = { name: payload.toolName, input: payload.input ?? {} };
      tools.set(payload.toolCallId, tool);
      out.items.push(didItem(payload.toolCallId, tool, true));
      if (WRITE_TOOLS.has(tool.name) && file !== void 0) out.signals.push({ kind: "writing", paths: [file] });
    }
  }
  function didItem(id, tool, live, detail) {
    const file = fileOf(tool.input);
    const path = file === void 0 ? void 0 : shownPath(root, file);
    return {
      kind: "did",
      id: `zcode:${id}`,
      what: describeTool(root, tool.name, tool.input),
      live,
      ...detail === void 0 ? {} : { detail },
      ...path === void 0 || isAbsolute(path) ? {} : { path }
    };
  }
  function toolResult(payload, out) {
    const tool = tools.get(payload.toolCallId);
    if (tool === void 0) return;
    const result = payload.result ?? {};
    const content = typeof result.content === "string" ? result.content : typeof result.error === "string" ? result.error : void 0;
    out.items.push(didItem(payload.toolCallId, tool, false, content === void 0 ? void 0 : shorten(content)));
    const file = fileOf(tool.input);
    if (result.success === true && WRITE_TOOLS.has(tool.name) && file !== void 0) {
      out.items.push({ kind: "wrote", id: `zcode:${payload.toolCallId}:wrote`, paths: [file] });
    }
  }
  function sessionUpdated(payload, out) {
    if (typeof payload.providerId === "string" && typeof payload.modelId === "string" && state.model === void 0) {
      state.model = `${payload.providerId}/${payload.modelId}`;
    }
    if (payload.status === "tool_started" && typeof payload.toolName === "string") {
      out.signals.push({ kind: "doing", what: describeTool(root, payload.toolName, payload.input) });
    }
    const usage = payload.usage;
    if (Number.isFinite(payload.contextWindow) && Number.isFinite(usage?.inputTokens) && Number.isFinite(usage?.outputTokens)) {
      out.signals.push({ kind: "spend", used: usage.inputTokens + usage.outputTokens, window: payload.contextWindow });
    }
  }
  function feed(event) {
    const out = { items: [], signals: [] };
    if (event === null || typeof event !== "object") return out;
    if (typeof event.sessionId === "string" && event.sessionId.startsWith("sess_")) state.session ??= event.sessionId;
    const payload = event.payload ?? {};
    const at = Number.isFinite(event.timestamp) ? event.timestamp : void 0;
    switch (event.type) {
      case "model.streaming":
        streamed(payload, at, out);
        break;
      case "tool.updated":
        if (payload.kind === "result") toolResult(payload, out);
        break;
      case "session.updated":
        sessionUpdated(payload, out);
        break;
      case "permission.resolved":
        if (payload.decision === "deny") state.denied.push(payload.reason ?? "");
        break;
      case "userInput.requested":
        state.askedUser = true;
        break;
      case "turn.completed":
        state.completed = true;
        break;
      case "turn.failed":
        state.failure = errorText(payload.error) || "ZCode reported a failed turn.";
        break;
      case "result":
        state.result = event;
        resultSpend(event, out);
        break;
      default:
        break;
    }
    return out;
  }
  function resultSpend(event, out) {
    const projection = event.projection ?? {};
    if (Number.isFinite(projection.contextUsed) && Number.isFinite(projection.contextWindow)) {
      out.signals.push({ kind: "spend", used: projection.contextUsed, window: projection.contextWindow });
    }
  }
  function finish({ code, signal, stopped, stderr }) {
    if (stopped || code === 130 || code === 143 || signal === "SIGINT" || signal === "SIGTERM") {
      return { kind: "ended", how: "stopped" };
    }
    if (code === 0 && state.result !== void 0 && state.failure === void 0) return { kind: "ended", how: "done" };
    const said = state.failure ?? firstLine(stderr).trim() ?? "";
    const text = said !== "" ? said : `zcode exited with ${code ?? signal} before finishing the turn.`;
    return { kind: "ended", how: endingOf(text), text };
  }
  function finalAnswer(record) {
    if (typeof record?.sessionId === "string") state.session ??= record.sessionId;
    state.result = record;
    if (typeof record?.response !== "string" || record.response === "") return [];
    texts.set("final", record.response);
    return [{ kind: "theirs", id: `zcode:${record.traceId ?? "final"}`, text: record.response }];
  }
  return { feed, finish, finalAnswer, state };
}

// src/zcode-journal.mjs
import { chmod as chmod2, mkdir as mkdir2, readdir as readdir2, readFile as readFile2, rename, rm as rm2, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname2, join as join3 } from "node:path";
var NATIVE_ID = /^sess_[A-Za-z0-9-]+$/;
var KEEP_ITEMS = 4e3;
function journalFolder(logPath) {
  if (typeof logPath === "string" && logPath !== "") return join3(dirname2(dirname2(logPath)), "provider-data", "plugin-zcode");
  return join3(homedir3(), ".geckit-zcode");
}
var titleOf = (text) => {
  const line = String(text ?? "").split("\n").find((one) => one.trim() !== "") ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}\u2026` : line;
};
var lastSaid = (items) => {
  const said = items.findLast((item) => item.kind === "theirs" || item.kind === "mine");
  return said === void 0 ? "" : titleOf(said.text);
};
var Journal = class {
  constructor(folder) {
    this.folder = folder;
    this.records = /* @__PURE__ */ new Map();
    this.ready = void 0;
  }
  async prepare() {
    this.ready ??= mkdir2(this.folder, { recursive: true, mode: 448 }).then(() => chmod2(this.folder, 448));
    return this.ready;
  }
  fileOf(id) {
    if (!NATIVE_ID.test(id)) throw new Error("Not a ZCode session id.");
    return join3(this.folder, `${id}.json`);
  }
  async get(id) {
    if (!NATIVE_ID.test(id)) return void 0;
    const kept = this.records.get(id);
    if (kept !== void 0) return kept;
    try {
      const record = JSON.parse(await readFile2(this.fileOf(id), "utf8"));
      this.records.set(id, record);
      return record;
    } catch {
      return void 0;
    }
  }
  /** The record for a session, made on first sight. */
  async open(id, root, firstText) {
    const had = await this.get(id);
    if (had !== void 0) return had;
    const now = Date.now();
    const record = { id, root, title: titleOf(firstText) || "ZCode conversation", created: now, at: now, items: [] };
    this.records.set(id, record);
    return record;
  }
  /** Items upserted by id, in the order they were first seen. */
  note(record, items) {
    for (const item of items) {
      const at = record.items.findIndex((one) => one.id === item.id);
      if (at >= 0) record.items[at] = item;
      else record.items.push(item);
    }
    if (record.items.length > KEEP_ITEMS) record.items.splice(0, record.items.length - KEEP_ITEMS);
    record.at = Date.now();
  }
  async save(record) {
    await this.prepare();
    const file = this.fileOf(record.id);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile2(temporary, JSON.stringify(record), { mode: 384 });
    await rename(temporary, file);
  }
  async all() {
    await this.prepare();
    const names = await readdir2(this.folder).catch(() => []);
    const records = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await this.get(name.slice(0, -5));
      if (record !== void 0) records.push(record);
    }
    return records;
  }
  async list(roots) {
    const wanted = new Set(roots);
    return (await this.all()).filter((record) => wanted.has(record.root)).map((record) => ({
      id: record.id,
      root: record.root,
      title: record.title,
      stands: lastSaid(record.items),
      at: record.at,
      created: record.created,
      driven: true,
      ...record.model === void 0 ? {} : { model: record.model },
      ...record.used === void 0 ? {} : { used: record.used },
      ...record.window === void 0 ? {} : { window: record.window }
    }));
  }
  async search(roots, asked) {
    const words = asked.toLowerCase().split(/\s+/).filter((word) => word !== "");
    if (words.length === 0) return [];
    const wanted = new Set(roots);
    const found = [];
    for (const record of await this.all()) {
      if (!wanted.has(record.root)) continue;
      const said = record.items.filter((item) => (item.kind === "mine" || item.kind === "theirs") && words.every((word) => item.text.toLowerCase().includes(word)));
      const titled = words.every((word) => record.title.toLowerCase().includes(word));
      if (said.length === 0 && !titled) continue;
      found.push({ id: record.id, root: record.root, title: record.title, said: titleOf(said.at(-1)?.text ?? record.title), at: record.at, count: Math.max(1, said.length) });
    }
    return found;
  }
  async forget(id) {
    this.records.delete(id);
    await rm2(this.fileOf(id), { force: true });
  }
};

// src/zcode-driver.mjs
var ZCODE_MODE = { manual: "build", auto: "build", plan: "plan" };
var IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
var STOP_GRACE_MS = 5e3;
var joined = (text, before = []) => [...before, text].filter((part) => part !== "").join("\n\n");
async function imageFiles(images) {
  if (images.length === 0) return { paths: [], folder: void 0 };
  const folder = await mkdtemp2(join4(tmpdir2(), "gz-img-"));
  const paths = [];
  for (const [index, image] of images.entries()) {
    const extension = IMAGE_TYPES[image.media];
    if (extension === void 0) throw new Error(`ZCode cannot attach ${image.media}.`);
    const data = Buffer.from(image.data, "base64");
    if (data.byteLength === 0) throw new Error("An attached image is empty.");
    const path = join4(folder, `image-${index + 1}.${extension}`);
    await writeFile3(path, data, { mode: 384 });
    paths.push(path);
  }
  return { paths, folder };
}
function batch() {
  const items = /* @__PURE__ */ new Map();
  const signals = [];
  return {
    add(out) {
      for (const item of out.items) items.set(item.id, item);
      signals.push(...out.signals);
    },
    take() {
      const taken = { items: [...items.values()], gone: [], signals: signals.splice(0) };
      items.clear();
      return taken;
    }
  };
}
var ZcodeConversation = class {
  constructor(options, deps, hear, left) {
    this.options = options;
    this.root = options.root;
    this.deps = deps;
    this.hear = hear;
    this.left = left;
    this.native = options.resume === true && NATIVE_ID.test(options.id) ? options.id : void 0;
    this.mode = options.mode ?? "manual";
    this.run = void 0;
    this.queue = [];
    this.asks = /* @__PURE__ */ new Map();
    this.approvals = void 0;
    this.record = void 0;
    this.knowing = void 0;
    this.model = void 0;
    this.started = false;
    this.ended = false;
  }
  log(level, event, fields = {}) {
    this.deps.log(level, event, { session: this.native ?? this.options.id, ...fields });
  }
  say(heard) {
    if (heard.items.length > 0 || heard.gone.length > 0 || heard.signals.length > 0) this.hear(heard);
  }
  signal(signal) {
    this.say({ items: [], gone: [], signals: [signal] });
  }
  /** The native session, once zcode has named it: recorded, and said once as `started`. */
  known(session) {
    if (this.native === void 0) this.native = session;
    this.knowing ??= (async () => {
      this.record ??= await this.deps.journal.open(this.native, this.root, this.run?.prompt);
      if (this.started) return;
      this.started = true;
      this.signal({ kind: "started", session: this.native, key: false, mode: this.mode });
    })();
    return this.knowing;
  }
  decide(request) {
    if (this.mode === "auto") return { decision: "allow", reason: "Allowed in Auto mode." };
    return new Promise((resolvePromise) => {
      this.asks.set(request.ask, resolvePromise);
      const wanted = wantedOf(request.toolName, request.toolInput ?? {});
      this.log("info", "approval.asked", { tool: String(request.toolName ?? "") });
      this.signal({ kind: "asks", ask: request.ask, wanted, ...request.toolCallId === void 0 ? {} : { line: `zcode:${request.toolCallId}` } });
    });
  }
  settle(ask, decided) {
    const resolvePromise = this.asks.get(ask);
    if (resolvePromise === void 0) return;
    this.asks.delete(ask);
    resolvePromise(decided);
    this.signal({ kind: "resolved", ask });
  }
  settleAll(decided) {
    for (const ask of [...this.asks.keys()]) this.settle(ask, decided);
  }
  async launch(run) {
    this.approvals ??= await openApprovals({ decide: (request) => this.decide(request), node: this.deps.found.node, environment: this.deps.environment, log: this.deps.log });
    const extra = await this.approvals.prepare();
    const files = await imageFiles(run.images);
    run.imageFolder = files.folder;
    const model = this.options.model;
    const args = [
      "-p",
      run.prompt,
      ...this.native === void 0 ? [] : ["--resume", this.native],
      "--mode",
      ZCODE_MODE[this.mode] ?? "build",
      ...model === void 0 || model === "" ? [] : ["--model", model],
      ...files.paths.flatMap((path) => ["--attach", path]),
      "--output-format",
      "stream-json"
    ];
    return (this.deps.spawnProcess ?? spawn)(this.deps.found.command, args, {
      cwd: this.root,
      env: zcodeEnvironment(this.deps.found, this.deps.environment, extra),
      stdio: ["ignore", "pipe", "pipe"]
    });
  }
  read(run, child) {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const pending = batch();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        this.line(run, buffer.slice(0, newline), pending);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      this.say(pending.take());
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      run.stderr = `${run.stderr}${chunk}`.slice(-4e3);
    });
    child.once("error", (error) => {
      run.stderr = `${run.stderr}
${error.message}`;
      void this.finish(run, { code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      if (buffer.trim() !== "") run.unparsed += buffer;
      void this.finish(run, { code, signal });
    });
  }
  line(run, text, pending) {
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      run.unparsed += `${text}
`;
      return;
    }
    if (event?.type === "turn.started" && typeof event.payload?.input === "string") {
      run.mine.push({ kind: "mine", id: `zcode:${event.payload.messageId}`, text: event.payload.input, at: event.timestamp });
    }
    const out = run.reader.feed(event);
    const session = this.native ?? run.reader.state.session;
    if (session !== void 0) void this.known(session).catch((error) => this.log("warn", "journal.failed", { errorKind: error?.name ?? "Error" }));
    const model = run.reader.state.model;
    if (model !== void 0 && model !== this.model) {
      this.model = model;
      out.signals.push({ kind: "model", model });
    }
    run.seen.push(...out.items);
    for (const signal of out.signals) if (signal.kind === "spend") run.spend = signal;
    pending.add(out);
  }
  async finish(run, exit) {
    if (run.finished) return;
    run.finished = true;
    this.settleAll({ decision: "deny", reason: "The turn ended before this was answered." });
    const late = [];
    if (run.reader.state.result === void 0 && run.unparsed.trim() !== "") {
      try {
        late.push(...run.reader.finalAnswer(JSON.parse(run.unparsed)));
      } catch {
      }
    }
    const session = this.native ?? run.reader.state.session;
    if (session !== void 0) await this.known(session).catch(() => {
    });
    run.seen.push(...late);
    const ended = run.reader.finish({ ...exit, stopped: run.stopped, stderr: run.stderr });
    this.log(ended.how === "done" || ended.how === "stopped" ? "info" : "warn", "turn.ended", { outcome: ended.how, kind: run.kind });
    await this.remember(run).catch((error) => this.log("warn", "journal.failed", { errorKind: error?.name ?? "Error" }));
    if (run.imageFolder !== void 0) await rm3(run.imageFolder, { recursive: true, force: true });
    this.say({ items: late, gone: [], signals: [ended] });
    this.run = void 0;
    run.resolveDone();
    this.next();
    const usage = await this.deps.quota?.afterTurn().catch(() => void 0);
    if (usage?.quotas !== void 0) this.signal({ kind: "usage", usage });
  }
  async remember(run) {
    const record = this.record;
    if (record === void 0) return;
    this.deps.journal.note(record, [...run.mine, ...run.seen]);
    if (run.reader.state.model !== void 0) record.model = run.reader.state.model;
    if (run.spend !== void 0) Object.assign(record, { used: run.spend.used, window: run.spend.window });
    await this.deps.journal.save(record);
  }
  start(run) {
    let resolveDone;
    const done = new Promise((resolvePromise) => {
      resolveDone = resolvePromise;
    });
    const current = { ...run, reader: turnReader(this.root), stderr: "", unparsed: "", seen: [], mine: [], stopped: false, finished: false, done, resolveDone };
    this.run = current;
    this.log("info", "turn.started", { kind: run.kind });
    if (run.kind === "goal") this.signal({ kind: "begun" });
    this.launch(current).then((child) => {
      current.child = child;
      if (current.stopped) child.kill("SIGINT");
      this.read(current, child);
    }, (error) => {
      current.stderr = error?.message ?? "zcode could not be started.";
      void this.finish(current, { code: null, signal: null });
    });
  }
  /** A run now, or after the one in progress. */
  enqueue(run) {
    if (this.run !== void 0) this.queue.push(run);
    else this.start(run);
  }
  next() {
    if (this.run !== void 0 || this.ended) return;
    const queued = this.queue.shift();
    if (queued !== void 0) this.start(queued);
  }
  stopRun(run) {
    run.stopped = true;
    this.settleAll({ decision: "deny", reason: "Stopped." });
    if (run.child === void 0) return;
    run.child.kill("SIGINT");
    const term = setTimeout(() => {
      if (!run.finished) run.child.kill("SIGTERM");
    }, STOP_GRACE_MS);
    const kill = setTimeout(() => {
      if (!run.finished) run.child.kill("SIGKILL");
    }, STOP_GRACE_MS * 2);
    term.unref?.();
    kill.unref?.();
  }
  async end() {
    if (this.ended) return;
    this.ended = true;
    this.queue.length = 0;
    const run = this.run;
    if (run !== void 0) {
      this.stopRun(run);
      await run.done;
    }
    await this.approvals?.close().catch(() => {
    });
    this.left();
  }
};
function holdZcode(options, deps, hear, left) {
  const held = new ZcodeConversation(options, deps, hear, left);
  const driver = {
    send: (text, images = [], before = []) => held.enqueue({ kind: "message", prompt: joined(text, before), images }),
    answer(ask, answer2) {
      if (answer2 === "once" || answer2 === "session") held.settle(ask, { decision: "allow", reason: "Allowed in GeckIt." });
      else if (answer2 === "no") held.settle(ask, { decision: "deny", reason: "The person declined this in GeckIt." });
      else held.settle(ask, { decision: "deny", reason: `The person answered instead: ${answer2}` });
    },
    permit(mode) {
      held.mode = mode;
      if (mode === "auto") held.settleAll({ decision: "allow", reason: "Allowed in Auto mode." });
    },
    stop() {
      held.queue.length = 0;
      if (held.run !== void 0) held.stopRun(held.run);
    },
    startGoal(objective) {
      if (held.record !== void 0) held.record.goal = { condition: objective };
      held.enqueue({ kind: "goal", prompt: `/goal ${objective}`, images: [] });
    },
    sessionId: () => held.native,
    end: () => held.end(),
    leave: () => {
      void held.end();
    }
  };
  return driver;
}

// src/links.mjs
var NAMED = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
var BARE = /https?:\/\/[^\s<>"'`)\]]+/g;
var TRAILING = /[.,;:!?]+$/;
function linksIn(items) {
  const found = /* @__PURE__ */ new Map();
  for (const said of [...items].reverse()) {
    if (said.kind !== "mine" && said.kind !== "theirs") continue;
    for (const [, text = "", url = ""] of said.text.matchAll(NAMED)) {
      const had = found.get(url);
      if (had === void 0 || had.text === void 0) found.set(url, text === url ? { url } : { url, text });
    }
    for (const [bare] of said.text.matchAll(BARE)) {
      const url = bare.replace(TRAILING, "");
      if (!found.has(url)) found.set(url, { url });
    }
  }
  return [...found.values()];
}

// src/zcode-quota.mjs
import { execFile as execFile2 } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { readFile as readFile3 } from "node:fs/promises";
import { homedir as homedir4 } from "node:os";
import { join as join5 } from "node:path";
var SERVICE = "ZCode Credential Encryption";
var TOKEN_KEY = "oauth:zai:access_token";
var QUOTA_PATH = "/api/monitor/usage/quota/limit";
var FRESH_MS = 10 * 6e4;
var UNAVAILABLE = "ZCode did not report the plan quota.";
var credentialsPath = (environment) => join5(environment.ZCODE_DATA_BASE_DIR?.trim() || homedir4(), ".zcode", "v2", "credentials.json");
var quotaUrl = (environment) => `${(environment.ZCODE_BASE_URL?.trim() || "https://api.z.ai").replace(/\/+$/, "")}${QUOTA_PATH}`;
function readKey(path, run) {
  const account = createHash("sha256").update(path).digest("hex");
  return new Promise((resolvePromise, rejectPromise) => {
    run("security", ["find-generic-password", "-w", "-s", SERVICE, "-a", account], (error, stdout) => {
      if (error !== null) {
        rejectPromise(new Error("keychain"));
        return;
      }
      const key = Buffer.from(String(stdout).trim(), "base64url");
      if (key.length !== 32) {
        rejectPromise(new Error("key"));
        return;
      }
      resolvePromise(key);
    });
  });
}
function decryptValue(value, key) {
  const parts = String(value).split(":");
  if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v2" || parts[2] !== "os") throw new Error("shape");
  const [iv, tag, ct] = parts[4].split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
function quotaRow(limit) {
  if (limit === null || typeof limit !== "object") return void 0;
  const window = Number.isFinite(limit.unit) && Number.isFinite(limit.number) ? limit.unit === 3 && limit.number === 5 ? { id: "five-hour", name: "5-hour" } : limit.unit === 6 && limit.number === 1 ? { id: "weekly", name: "Weekly" } : void 0 : void 0;
  const named = window ?? (limit.type === "TIME_LIMIT" ? { id: "mcp", name: "MCP" } : { id: `${limit.type ?? "limit"}-${limit.unit ?? 0}-${limit.number ?? 0}`, name: String(limit.type ?? "Limit") });
  const part = Number.isFinite(limit.percentage) ? Math.max(0, Math.min(1, limit.percentage / 100)) : Number.isFinite(limit.currentValue) && Number.isFinite(limit.usage) && limit.usage > 0 ? Math.max(0, Math.min(1, limit.currentValue / limit.usage)) : void 0;
  if (part === void 0) return void 0;
  return {
    ...named,
    part,
    ...Number.isFinite(limit.nextResetTime) ? { resetsAt: limit.nextResetTime } : {}
  };
}
function parseQuota(body, measuredAt) {
  const limits = body?.data?.limits ?? body?.limits;
  if (!Array.isArray(limits)) return { unavailableReason: UNAVAILABLE, measuredAt };
  const quotas = limits.map(quotaRow).filter((row) => row !== void 0);
  if (quotas.length === 0) return { unavailableReason: UNAVAILABLE, measuredAt };
  return { quotas, measuredAt };
}
var Quota = class {
  constructor({ environment = process.env, run = execFile2, fetch: doFetch = fetch, now = Date.now, readToken, log = () => {
  } } = {}) {
    this.environment = environment;
    this.run = run;
    this.fetch = doFetch;
    this.now = now;
    this.readToken = readToken ?? (() => this.decryptToken());
    this.log = log;
    this.cached = void 0;
    this.flight = void 0;
  }
  async decryptToken() {
    if (this.environment.GECKIT_ZCODE_NO_QUOTA === "1") throw new Error("disabled");
    if (process.platform !== "darwin") throw new Error("platform");
    const path = credentialsPath(this.environment);
    const store = JSON.parse(await readFile3(path, "utf8"));
    if (typeof store[TOKEN_KEY] !== "string") throw new Error("token");
    const key = await readKey(path, this.run);
    return decryptValue(store[TOKEN_KEY], key);
  }
  async fetchOnce() {
    const measuredAt = this.now();
    let token;
    try {
      token = await this.readToken();
    } catch {
      return { unavailableReason: UNAVAILABLE, measuredAt };
    }
    try {
      const response = await this.fetch(quotaUrl(this.environment), { headers: { Authorization: token, "X-ZCode-App-Version": "0.17.1", Accept: "application/json" } });
      const body = await response.json().catch(() => void 0);
      if (!response.ok || !(body?.code === 0 || body?.code === 200)) return { unavailableReason: body?.msg ? `ZCode quota: ${body.msg}` : UNAVAILABLE, measuredAt };
      return parseQuota(body, measuredAt);
    } catch {
      return { unavailableReason: UNAVAILABLE, measuredAt };
    } finally {
      token = void 0;
    }
  }
  /** The quota, fresh within ten minutes, concurrent reads coalesced. */
  async read() {
    if (this.cached !== void 0 && this.now() - this.cached.measuredAt < FRESH_MS) return this.cached;
    this.flight ??= this.fetchOnce().then((usage) => {
      this.cached = usage;
      this.flight = void 0;
      return usage;
    }, (error) => {
      this.flight = void 0;
      throw error;
    });
    return this.flight;
  }
  /** After a turn: refresh unless a read just happened, for a live usage signal. */
  async afterTurn() {
    this.cached = void 0;
    return this.read().catch(() => void 0);
  }
};

// src/model-overrides.mjs
var modelOverrides = /* @__PURE__ */ new Map();

// src/provider.mjs
var FAMILY = "plugin:zcode";
var PROVISIONAL = /^new-[0-9a-f-]{36}$/;
var PLAN_UNAVAILABLE = "ZCode does not report plan quota to other programs; check it in ZCode Desktop.";
var nativeId = (id) => {
  if (typeof id !== "string" || !id.startsWith(`${FAMILY}:`)) throw new Error("This conversation does not belong to ZCode.");
  const native = id.slice(FAMILY.length + 1);
  if (!NATIVE_ID.test(native) && !PROVISIONAL.test(native)) throw new Error("Not a ZCode conversation id.");
  return native;
};
var mine = (id) => `${FAMILY}:${id}`;
var INFO = {
  id: FAMILY,
  family: FAMILY,
  name: "ZCode",
  shortName: "ZCode",
  icon: "zcode",
  loginCommand: "zcode login",
  planName: "Z.ai Coding Plan",
  resumeCommand: "zcode --resume {id}",
  available: true,
  localOnly: true,
  subscriptionOnly: true,
  images: true,
  remoteControl: false,
  nativeGoals: true,
  idleMs: 10 * 6e4,
  waitForExit: true
};
function programMembers(zcode, quota) {
  return {
    account: async () => {
      const found = await zcode();
      if (found.unusable !== void 0) return { provider: FAMILY, here: false, signedIn: void 0, usage: { unavailableReason: found.unusable } };
      const program = await zcodeProgram(found);
      const usage = await quota.read().catch(() => ({ unavailableReason: PLAN_UNAVAILABLE }));
      return { provider: FAMILY, here: program !== void 0, signedIn: void 0, ...program === void 0 ? {} : { program }, usage };
    },
    program: async () => zcodeProgram(await zcode()),
    // zcode has no public command that lists its models; it runs the one the person chose in ZCode.
    models: async () => void 0,
    limits: async (models) => {
      const usage = await quota.read().catch(() => ({ unavailableReason: PLAN_UNAVAILABLE }));
      return {
        windows: new Map(models.map((model) => [model, modelOverrides.get(model)?.contextWindow])),
        ...usage.quotas === void 0 ? { unavailableReason: usage.unavailableReason ?? PLAN_UNAVAILABLE } : { quotas: usage.quotas }
      };
    }
  };
}
function journalMembers(journal, log) {
  return {
    list: async (roots) => (await journal.list(roots.filter((root) => isAbsolute2(root)))).map((row) => ({ ...row, id: mine(row.id) })),
    search: async (roots, asked) => (await journal.search(roots, asked)).map((found) => ({ ...found, id: mine(found.id) })),
    hidden: async () => [],
    create: async () => mine(`new-${randomUUID2()}`),
    fork: async () => {
      throw new Error("ZCode conversations cannot be forked from GeckIt.");
    },
    has: async (_root, id) => await journal.get(nativeId(id)) !== void 0,
    read: async (_root, id) => {
      const record = await journal.get(nativeId(id));
      if (record === void 0) return void 0;
      return {
        items: record.items,
        tasks: [],
        ...record.window === void 0 ? {} : { window: record.window },
        ...record.goal === void 0 ? {} : { goal: { condition: record.goal.condition, checks: 0 } }
      };
    },
    links: async (_root, id) => linksIn((await journal.get(nativeId(id)))?.items ?? []),
    rename: async (id, name) => {
      const record = await journal.get(nativeId(id));
      if (record === void 0) return;
      record.title = name;
      await journal.save(record);
    },
    delete: async (_root, id) => {
      const native = nativeId(id);
      if (await journal.get(native) === void 0) return false;
      await journal.forget(native);
      log("info", "session.forgotten", { session: native });
      return true;
    }
  };
}
function goalMembers(journal, drivers, log) {
  const goals = /* @__PURE__ */ new Map();
  const heldFor = (native) => [...drivers.values()].find((driver) => driver.sessionId() === native) ?? drivers.get(native);
  return {
    goal: async (_root, id) => {
      const native = nativeId(id);
      const condition = goals.get(native) ?? (await journal.get(native))?.goal?.condition;
      return condition === void 0 ? void 0 : { goal: { condition, checks: 0 } };
    },
    setGoal: async (id, objective) => {
      const native = nativeId(id);
      const held = heldFor(native);
      if (held === void 0) throw new Error("Open the ZCode conversation to give it a goal.");
      goals.set(native, objective);
      held.startGoal(objective);
      log("info", "goal.started", { session: native });
      return { goal: { condition: objective, checks: 0 }, status: "active" };
    },
    clearGoal: async (id) => {
      const native = nativeId(id);
      goals.delete(native);
      const record = await journal.get(native);
      if (record?.goal === void 0) return;
      delete record.goal;
      await journal.save(record);
    }
  };
}
function holdMember({ zcode, journal, drivers, quota, log }) {
  return (options, hear, left) => {
    const native = nativeId(options.id);
    const forward = (heard) => hear({ ...heard, signals: heard.signals.map((signal) => signal.kind === "started" ? { ...signal, session: mine(signal.session) } : signal) });
    const leave = () => {
      drivers.delete(native);
      log("info", "session.closed", { session: native });
      left();
    };
    const ready = zcode().then((found) => {
      if (found.unusable !== void 0) throw new Error(found.unusable);
      return holdZcode({ ...options, id: native }, { found, journal, quota, log }, forward, leave);
    });
    let held;
    void ready.then((one) => {
      held = one;
    }, () => {
    });
    const later = (use) => {
      void ready.then(use, () => {
      });
    };
    const driver = {
      send: (...args) => {
        log("info", "message.send.requested", { session: native });
        void ready.then((one) => one.send(...args), (error) => hear({ items: [], gone: [], signals: [{ kind: "ended", how: "failed", text: error.message }] }));
      },
      answer: (...args) => later((one) => one.answer(...args)),
      permit: (...args) => later((one) => one.permit(...args)),
      stop: () => later((one) => one.stop()),
      startGoal: (objective) => later((one) => one.startGoal(objective)),
      sessionId: () => held?.sessionId() ?? (NATIVE_ID.test(native) ? native : void 0),
      end: async () => {
        const one = await ready.catch(() => void 0);
        if (one === void 0) leave();
        else await one.end();
      },
      leave: () => {
        void driver.end();
      }
    };
    drivers.set(native, driver);
    return driver;
  };
}
function create(context = {}) {
  const log = (level, event, fields) => {
    try {
      context.log?.write(level, event, fields);
    } catch {
    }
  };
  const journal = new Journal(journalFolder(context.log?.path));
  const drivers = /* @__PURE__ */ new Map();
  const quota = new Quota({ log: (level, event, fields) => log(level, event, fields) });
  let finding;
  const zcode = () => {
    finding ??= findZcode().then((found) => {
      if (found.unusable !== void 0) finding = void 0;
      return found;
    });
    return finding;
  };
  log("info", "provider.created");
  return {
    ...INFO,
    ...programMembers(zcode, quota),
    ...journalMembers(journal, log),
    ...goalMembers(journal, drivers, log),
    hold: holdMember({ zcode, journal, drivers, quota, log }),
    remote: async () => {
      throw new Error("ZCode does not support Remote Control.");
    },
    mcp: async () => void 0,
    browsers: async () => void 0,
    correct: async () => ({ ok: false, error: "ZCode has no isolated text correction." }),
    // zcode takes no extra system prompt from the command line, and the person's own files are not edited.
    setInstructions: async () => {
    },
    dispose: () => {
      log("info", "provider.disposed");
      for (const driver of drivers.values()) void driver.end();
      drivers.clear();
    }
  };
}
export {
  create
};
