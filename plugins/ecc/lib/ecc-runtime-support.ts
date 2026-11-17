/** Shared filesystem, process and lazy-tool helpers for the OpenCode runtime. */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawn } from "child_process"
import { pathToFileURL } from "url"

/**
 * Durable plugin log.
 *
 * A plugin's `console.*` output does not reach OpenCode's own log file, so this
 * file next to OpenCode's logs is the only place startup, registration and
 * tool-load diagnostics survive. Appending is best-effort by design: a missing
 * or read-only log directory must never fail plugin startup.
 */
const ECC_LOG_FILE = path.join(os.homedir(), ".local", "share", "opencode", "log", "ecc-hooks.log")

/** Rotate once past this size, keeping `ECC_LOG_GENERATIONS` previous files. */
const ECC_LOG_MAX_BYTES = 1024 * 1024
const ECC_LOG_GENERATIONS = 2

/** The log directory is created at most once per process, not on every append. */
let logDirReady = false

/** Shift `log`, `log.1`, `log.2` and drop the oldest generation. */
function rotateEccLog(): void {
  try {
    if (fs.statSync(ECC_LOG_FILE).size <= ECC_LOG_MAX_BYTES) return
  } catch {
    return // No log file yet.
  }
  for (let generation = ECC_LOG_GENERATIONS; generation > 1; generation -= 1) {
    const target = `${ECC_LOG_FILE}.${generation}`
    try {
      fs.rmSync(target, { force: true })
      fs.renameSync(`${ECC_LOG_FILE}.${generation - 1}`, target)
    } catch {
      // That generation does not exist yet.
    }
  }
  try {
    fs.renameSync(ECC_LOG_FILE, `${ECC_LOG_FILE}.1`)
  } catch {
    // Another process rotated first; appending continues either way.
  }
}

function writeEccLogLine(message: string): void {
  if (!logDirReady) {
    fs.mkdirSync(path.dirname(ECC_LOG_FILE), { recursive: true })
    logDirReady = true
  }
  rotateEccLog()
  fs.appendFileSync(ECC_LOG_FILE, `${new Date().toISOString()} [ECC] ${message}\n`)
}

export function appendEccLog(message: string): void {
  try {
    writeEccLogLine(message)
  } catch {
    // The log directory can disappear under a long-lived process. Reset the
    // flag and retry once so logging recovers instead of staying dead for the
    // rest of the process.
    logDirReady = false
    try {
      writeEccLogLine(message)
    } catch {
      // Logging must never break the plugin.
    }
  }
}


export type HookProfile = "minimal" | "standard" | "strict"

/** Loose aliases: the runtime ctx/event shapes come from the server, not the pinned SDK. */
export type LooseRecord = Record<string, any>

export interface ToolArgs {
  filePath?: string
  file_path?: string
  path?: string
  command?: string
  [key: string]: unknown
}

export interface ToolInput {
  tool: string
  callID?: string
  args?: ToolArgs
}

export interface PermissionEvent {
  tool: string
  args: unknown
}

/**
 * Artifacts that identify an ECC root, one per capability this plugin needs.
 *
 * These are required runtime files, never optional content: `skills/` belongs to
 * the optional `workflow-quality` module, so probing for a skill rejected
 * supported modular installs (e.g. `platform-configs` + `hooks-runtime` without
 * `workflow-quality`) that still ship both the plugin and the tracker — silently
 * disabling skill telemetry and the shell root export for those users.
 *
 * Each probe is the exact artifact the caller is about to use, so detection is
 * layout detection rather than an authenticity control: a directory only
 * qualifies because it contains what we are going to read.
 */
export const ECC_ROOT_PROBES = {
  // scripts/lib/utils.js is the shared library every scripts/ module requires.
  root: [path.join("scripts", "lib", "utils.js")],
  // What the skill-run telemetry hook imports at runtime.
  skillTracker: [path.join("scripts", "hooks", "skill-run-tracker.js")],
  // What the resolver embedded in commands requires once they read
  // CLAUDE_PLUGIN_ROOT, and the version lookup for shell.env.
  resolver: [path.join("scripts", "lib", "resolve-ecc-root.js")],
} as const

/**
 * Walk upwards from `startDir` looking for an ancestor that contains every
 * relative path in `probes`.
 *
 * The plugin ships in three layouts — `<root>/plugins` (installed), `<root>/dist/plugins`
 * (compiled) and `<repo>/.opencode/plugins` (repo checkout) — so the number of
 * levels back to the root is not fixed. Probing beats a hardcoded `..`: a wrong
 * root would make every command resolve against a directory that has no scripts.
 *
 * The walk is bounded to 5 levels so it cannot wander into unrelated ancestors.
 *
 * Returns null when no ancestor qualifies, so callers can leave the capability
 * disabled instead of advertising a root that does not hold the artifact.
 */
export function findEccRootDir(startDir: string, probes: readonly string[]): string | null {
  let current = startDir
  for (let depth = 0; depth < 5; depth += 1) {
    if (probes.every((probe) => fs.existsSync(path.join(current, probe)))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/**
 * Read the ECC version from package.json.
 *
 * Candidates are tried in order — the resolved ECC root first, then the two
 * plausible parent depths of the plugin — because the layout differs between an
 * installed root (`<root>/plugins`), the compiled bundle (`<root>/dist/plugins`)
 * and a repo checkout (`<repo>/.opencode/plugins`). Falls back to a default if
 * no package.json can be read.
 */
export function getECCVersion(eccRootDir: string | null | undefined, pluginDir: string): string {
  const candidates = [
    eccRootDir,
    pluginDir,
    path.resolve(pluginDir, ".."),
    path.resolve(pluginDir, "..", ".."),
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf-8"))
      if (typeof packageJson.version === "string" && packageJson.version) {
        return packageJson.version
      }
    } catch {
      // Try the next candidate.
    }
  }

  return "2.0.0"
}

/**
 * On Windows, npx/npm/pnpm/yarn/bun are `.cmd` shims that CreateProcess
 * cannot launch directly from a bare command name. Node's own guidance for
 * this case is to spawn the exact `.cmd` file through `cmd.exe /d /s /c`
 * with `windowsVerbatimArguments` and quoted args — NOT `shell: true`,
 * which concatenates the command and arguments into one string that shell
 * metacharacters (&, |, ;) in any argument (e.g. a file path) could inject
 * into. The command is fixed here (never user input); only known package
 * managers get the cmd-shim treatment, and their arguments stay separated.
 */
function spawnCommand(
  command: string,
  args: string[],
): { file: string; spawnArgs: string[]; verbatim: boolean } {
  if (
    process.platform === "win32" &&
    /^(npx|npm|pnpm|yarn|bun)(\.cmd)?$/i.test(command)
  ) {
    // R2-2: cmd.exe expands %VAR% and honours embedded quotes even inside
    // "double quotes", so backslash-escaping a quote here is not safe. Reject
    // any argument carrying a quote, percent sign, or line break outright
    // (line breaks would also terminate the /c command string). Legitimate
    // package-manager invocations never need these characters; callers already
    // surface the rejection through run()'s rejection path.
    const unsafe = args.find((value) => /["%\r\n]/.test(value))
    if (unsafe !== undefined) {
      throw new Error(
        `Refusing to launch package-manager shim with unsafe argument: ${JSON.stringify(unsafe)}`,
      )
    }
    const shim = `${command.replace(/\.cmd$/i, "")}.cmd`
    const quote = (value: string) => `"${value}"`
    // Canonical `/s` form: wrap the whole command string in one outer pair of
    // quotes. cmd strips exactly that outer pair and executes the remainder
    // verbatim, so the quoted shim path resolves instead of being re-split.
    const inner = [shim, ...args].map(quote).join(" ")
    return {
      file: process.env.ComSpec || "cmd.exe",
      spawnArgs: ["/d", "/s", "/c", `"${inner}"`],
      verbatim: true,
    }
  }
  return { file: command, spawnArgs: args, verbatim: false }
}

/** Run a command, resolving with its output regardless of exit code. */
export function run(
  command: string,
  args: string[],
  options: { cwd?: string; detached?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const resolved = spawnCommand(command, args)
    const child = spawn(resolved.file, resolved.spawnArgs, {
      cwd: options.cwd,
      shell: false,
      windowsVerbatimArguments: resolved.verbatim,
      windowsHide: true,
      detached: options.detached === true,
      stdio: options.detached === true ? "ignore" : ["ignore", "pipe", "pipe"],
    })
    // T03: the error listener must exist before any early return below, so a
    // missing binary (ENOENT) rejects this promise instead of surfacing as an
    // unhandled 'error' event that can crash the host process.
    let settled = false
    child.on("error", (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    if (options.detached === true) {
      child.unref()
      settled = true
      resolve({ code: 0, stdout: "", stderr: "" })
      return
    }
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)))
    child.on("close", (code) => {
      if (settled) return
      settled = true
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

/** Count console.log occurrences in a file with fs+regex (cross-platform grep replacement). */
export async function countConsoleLogs(filePath: string): Promise<number> {
  const content = await fs.promises.readFile(filePath, "utf-8")
  return (content.match(/console\.log\s*\(/g) ?? []).length
}

/**
 * The custom tool definitions V1 exposed through `plugin.tool` and V2 exposes
 * through ctx.tool.transform. Loaded lazily and cached per name: this file is
 * OpenCode's startup entry point, and a static top-level import of a missing
 * tools/ module used to crash the whole session before any hook could load
 * (#2530). A failed load degrades to an execute-time error message instead.
 */
const toolModuleCache = new Map<string, Promise<any>>()

/**
 * Locate the tool definition inside a loaded module namespace.
 *
 * The definition is the one object that carries an `execute()` function; every
 * loader interop shape (definition itself, `{ default }`, CJS double-wrap,
 * named export of the default binding) is covered by a bounded recursive scan.
 */
function findToolDefinition(value: any, depth = 0): { execute?: (args: any, context: any) => Promise<unknown>; run?: (args: any, context: any) => Promise<unknown> } | undefined {
  if (!value || depth > 3) return undefined
  if (typeof value !== "object" && typeof value !== "function") return undefined
  const record = value as any
  if (typeof record.execute === "function") return record
  // OpenCode's own tool-module loader normalizes a default-exported
  // `{ description, args, execute }` into `{ name, description, input, run }`.
  if (typeof record.run === "function" && typeof record.input === "object") return record
  for (const nested of Object.values(record)) {
    const found = findToolDefinition(nested, depth + 1)
    if (found) return found
  }
  return undefined
}

/**
 * Resolve a tool module by URL rather than by a literal specifier: tsc only
 * rewrites `.ts` extensions in statically-analyzable specifiers, and the
 * compiled layout ships `.js` while a repo/source install ships `.ts`.
 */
export async function loadToolModule(name: string, pluginDir: string): Promise<{ description: string; args: any; execute: (args: any, context: any) => Promise<unknown> }> {
  let pending = toolModuleCache.get(name)
  if (!pending) {
    // Layout detection: ECC's own checkout keeps `tools/` beside `plugins/`,
    // while this home install keeps both under the single plugin directory.
    // Try the sibling layout first so a shared/upstream tree still resolves.
    const toolsDirs = [path.resolve(pluginDir, "..", "tools"), path.resolve(pluginDir, "tools")]
    const candidates = toolsDirs.flatMap((toolsDir) => [
      path.join(toolsDir, `${name}.js`),
      path.join(toolsDir, `${name}.ts`),
    ])
    pending = (async () => {
      let lastError: unknown
      for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue
        try {
          // Node caches ES modules by URL for the whole process, so a plugin
          // reload picked up plugin code but kept executing the *old* tool
          // modules until the server restarted. The mtime makes every edited
          // file a new URL, so `location/reload` now loads the current code.
          const url = pathToFileURL(candidate)
          url.searchParams.set("v", String(fs.statSync(candidate).mtimeMs))
          return await import(url.href)
        } catch (error) {
          lastError = error
        }
      }
      throw lastError ?? new Error(`neither ${name}.js nor ${name}.ts found under ${toolsDirs.join(" or ")}`)
    })()
      .then((mod: any) => {
        // Interop differs by loader: a source-layout TS file can arrive as the
        // definition itself, as `{ default }`, CJS-wrapped, or — as OpenCode's
        // own TS loader does — with `export default foo` surfaced as a *named*
        // export of the binding. Search the namespace recursively (bounded) for
        // the one value that carries an `execute()`, instead of guessing a
        // single shape.
        const definition = findToolDefinition(mod)
        if (definition) return definition
        const shape = mod && typeof mod === "object"
          ? Object.entries(mod).map(([key, value]) => {
            const type = typeof value
            const keys = value && typeof value === "object" ? Object.keys(value).slice(0, 8).join("|") : ""
            return `${key}=${type}${keys ? `{${keys}}` : ""}`
          }).join("; ") || "(none)"
          : typeof mod
        throw new Error(`${name}: module exposes no tool definition with an execute() (shape: ${shape})`)
      })
      .catch((error: unknown) => {
        toolModuleCache.delete(name)
        throw new Error(
          `${name} tool: could not load ECC tool module. Run \`ecc repair --target opencode\` to restore the missing files. (${
            error instanceof Error ? error.message : String(error)
          })`,
        )
      })
    toolModuleCache.set(name, pending)
  }
  return pending
}
