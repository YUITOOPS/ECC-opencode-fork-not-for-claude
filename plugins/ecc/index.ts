/**
 * ECC Plugin Hooks for OpenCode 2.x
 *
 * OpenCode 2 plugin entry point for the Everything Claude Code (ECC) harness,
 * ported from ECC's `.opencode/plugins/ecc-hooks.ts` (v2.2.3) to a plain
 * home-directory install:
 *
 *   ~/.config/opencode/plugins/ecc/   <- this directory (auto-discovered)
 *   ~/.config/opencode/scripts        <- ECC runtime payload (root probe)
 *   ~/.config/opencode/agents|commands|skills
 *
 * Differences from the upstream entry:
 * - No OpenCode 1 factory surface: only the V2 definition object is exported.
 * - No `@opencode-ai/plugin` / Zod imports: tool schemas come from the local
 *   JSON-Schema shim in `tools/tool.ts`, because this install has no
 *   `node_modules` and V2 tool definitions take JSON Schema directly.
 * - All eight ECC custom tools are registered through one transform, not only
 *   the two headings upstream registered.
 * - There is no per-directory registration guard: a second setup would stack a
 *   fresh set of hooks, so the dispose function returned here must remove every
 *   registration it created (OpenCode calls it before reloading the plugin).
 *
 * Hook Event Mapping (OpenCode 1 key -> V2 registration):
 * - tool.execute.before / after    -> ctx.tool.hook("execute.before"/"execute.after")
 * - file.edited                    -> completed write/edit in execute.after
 *                                     (V2 publishes no file.edited event)
 * - file.watcher / session.* / todo.updated
 *                                  -> ctx.event.subscribe() filtered by type
 * - shell.env                      -> ctx.shell.hook("create.before")
 * - experimental.session.compacting -> ctx.session.hook("compaction")
 * - permission.ask                 -> ctx.permission.hook("evaluate")
 *
 * Runtime controls stay the same as upstream:
 *   ECC_HOOK_PROFILE=minimal|standard|strict
 *   ECC_DISABLED_HOOKS=pre:bash:tmux-reminder,post:edit:typecheck
 */

import * as path from "path"
import { fileURLToPath } from "url"

import { createEccRuntime } from "./lib/ecc-runtime.ts"
import {
  ECC_ROOT_PROBES, appendEccLog, findEccRootDir, getECCVersion,
} from "./lib/ecc-runtime-support.ts"
import type { LooseRecord, ToolArgs, ToolInput } from "./lib/ecc-runtime-support.ts"
import { toInputSchema } from "./tools/tool.ts"

/** Directory of this module (ESM source of truth; `__dirname` is absent in ESM). */
function resolvePluginDir(): string {
  if (typeof __dirname === "string" && path.isAbsolute(__dirname)) return __dirname
  return path.dirname(fileURLToPath(import.meta.url))
}

const PLUGIN_DIR = resolvePluginDir()

/**
 * OpenCode creates one plugin instance per open location, but the V2 hook APIs
 * (tool, permission, session, shell, event) are server-global: every instance is
 * called for every event. Without this registry N open locations mean N prettier
 * runs, N compaction blocks and N copies of every log line.
 *
 * Rule:
 * - an event that carries a file path is handled by the instance whose location
 *   contains that path;
 * - an event without a path (shell calls, permissions, sessions) is handled by
 *   exactly one instance, the oldest live one ("primary").
 *
 * Identity is the per-setup token, not the directory, because a reload can leave
 * two setups for the same directory alive for a moment. When the primary
 * disposes, the next live instance becomes primary automatically: every instance
 * keeps its own registrations, so no re-registration is needed.
 *
 * The registry lives on `globalThis`, not in this module: OpenCode evaluates the
 * plugin entry once per location, so module-level state is not shared between
 * locations, while one server process is.
 */
const LIVE_INSTANCES_KEY = Symbol.for("ecc.opencode.liveInstances")
type LiveInstance = { directory: string; token: object; at: number }
const globalScope = globalThis as unknown as Record<symbol, LiveInstance[] | undefined>
const liveInstances: LiveInstance[] = (globalScope[LIVE_INSTANCES_KEY] ??= [])

/** Drop leases left behind by a crashed or never-disposed instance. */
function pruneLiveInstances(): void {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (let index = liveInstances.length - 1; index >= 0; index -= 1) {
    if (liveInstances[index].at < cutoff) liveInstances.splice(index, 1)
  }
}

export default {
  id: "ecc-hooks",
  async setup(ctx: any): Promise<() => Promise<void>> {
    const directory: string = ctx?.location?.directory ?? process.cwd()
    const instanceToken = {}
    pruneLiveInstances()
    liveInstances.push({ directory, token: instanceToken, at: Date.now() })
    const isPrimary = () => liveInstances[0]?.token === instanceToken
    const forgetInstance = () => {
      const index = liveInstances.findIndex((entry) => entry.token === instanceToken)
      if (index >= 0) liveInstances.splice(index, 1)
    }

    const eccVersion = getECCVersion(findEccRootDir(PLUGIN_DIR, ECC_ROOT_PROBES.root), PLUGIN_DIR)
    const profile = process.env.ECC_HOOK_PROFILE ?? "standard"
    appendEccLog(
      `setup v${eccVersion} opencode=${ctx?.app?.version ?? "?"} profile=${profile} directory=${directory}`,
    )

    const runtime = await createEccRuntime({ directory, worktree: directory }, PLUGIN_DIR)
    const { hooks, worktreePath } = runtime

    // Normalize a V2 tool-hook event into the V1 ToolInput shape so the shared
    // runtime keeps one implementation. OpenCode 2 renamed the V1 `bash` tool
    // to `shell` and passes `{ path }` to `write`/`edit`.
    const toToolInput = (event: LooseRecord): ToolInput => {
      const rawTool = String(event.tool ?? event.name ?? "")
      const tool = rawTool === "shell" ? "bash" : rawTool
      let args = (event.input ?? event.args) as ToolArgs | undefined
      if (
        (tool === "write" || tool === "edit") &&
        args && typeof args === "object" &&
        typeof args.filePath !== "string" && typeof args.path === "string"
      ) {
        args = { ...args, filePath: args.path }
      }
      return { tool, callID: event.callID ?? event.id, args }
    }

    // V2 has no `file.edited` event, so the post-edit hook (formatter,
    // console.log warning, idle audit input) is driven from the completed
    // write/edit tool call instead.
    const editedPath = (input: ToolInput): string | null => {
      if (input.tool !== "write" && input.tool !== "edit") return null
      const p = input.args?.filePath ?? input.args?.path
      return typeof p === "string" && p.trim() ? p : null
    }

    const worktreeRoot = path.resolve(worktreePath)
    const isInsideWorktree = (candidate: string): boolean => {
      const absolute = path.resolve(candidate)
      return absolute === worktreeRoot || absolute.startsWith(`${worktreeRoot}${path.sep}`)
    }

    // A write/edit belongs to the location that contains the file; a shell call
    // carries no path, so exactly one instance may handle it.
    const ownsToolEvent = (input: ToolInput): boolean => {
      const p = editedPath(input) ?? (typeof input.args?.path === "string" ? input.args.path : null)
      return p ? isInsideWorktree(p) : isPrimary()
    }

    const registrations: { dispose?: () => Promise<void> | void }[] = []
    const controller = new AbortController()

    const safe =
      <T extends (...args: any[]) => any>(label: string, fn: T) =>
      async (...args: Parameters<T>) => {
        try {
          return await fn(...args)
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          console.debug(`[ecc] ${label} hook failed: ${errorMessage}`)
          return undefined
        }
      }

    const registerDomains = async (): Promise<void> => {
      // --- Tool hooks -------------------------------------------------------
      if (typeof ctx?.tool?.hook === "function") {
        registrations.push(
          await ctx.tool.hook(
            "execute.before",
            safe("execute.before", (event: LooseRecord) => {
              const input = toToolInput(event)
              if (!ownsToolEvent(input)) return
              return hooks["tool.execute.before"](input, {})
            }),
          ),
        )
        registrations.push(
          await ctx.tool.hook(
            "execute.after",
            safe("execute.after", async (event: LooseRecord) => {
              const input = toToolInput(event)
              if (!ownsToolEvent(input)) return
              // Hand the shared handler the tool output object directly: the
              // skill tracker reads error fields off the response itself.
              await hooks["tool.execute.after"](input, event.status === "error"
                ? { is_error: true }
                : event.result ?? event.output)
              const edited = event.status === "error" ? null : editedPath(input)
              if (edited) await hooks["file.edited"]({ path: edited })
            }),
          ),
        )
      }

      // --- Shell environment ------------------------------------------------
      if (typeof ctx?.shell?.hook === "function") {
        registrations.push(
          await ctx.shell.hook(
            "create.before",
            safe("shell.env", async (event: LooseRecord) => {
              // Per-command hook: the instance that owns the working directory
              // injects, so PROJECT_ROOT and language detection match the
              // project the command runs in.
              if (typeof event.cwd !== "string" || !isInsideWorktree(event.cwd)) return
              const output = { env: { ...(event.env ?? {}) } as Record<string, string> }
              await hooks["shell.env"]({ cwd: worktreePath }, output)
              event.env = output.env
            }),
          ),
        )
      }

      // --- Compaction -------------------------------------------------------
      if (typeof ctx?.session?.hook === "function") {
        registrations.push(
          await ctx.session.hook(
            "compaction",
            safe("compaction", (event: LooseRecord) => {
              if (!isPrimary()) return
              event.system = event.system ?? []
              event.system.push({ type: "text", text: runtime.buildCompactionContext() })
            }),
          ),
        )
      }

      // --- Permissions ------------------------------------------------------
      if (typeof ctx?.permission?.hook === "function") {
        registrations.push(
          await ctx.permission.hook(
            "evaluate",
            safe("permission.evaluate", async (event: LooseRecord) => {
              if (!isPrimary()) return
              const action = String(event.action ?? "")
              const resource = String(event.resources?.[0] ?? "")
              const decision = await hooks["permission.ask"]({ tool: action, args: resource })
              // approved === true -> allow; otherwise keep the configured decision
              // (never a hard deny on drift).
              if (decision?.approved === true) {
                event.effect = "allow"
                event.message = `ECC: ${decision.reason}`
              }
            }),
          ),
        )
      }

      // --- Custom tools -----------------------------------------------------
      // Registered lazily-loaded definitions from tools/: a broken tools/ install
      // only removes the affected tool instead of failing plugin startup.
      const definitions = (runtime.tool ?? {}) as Record<string, any>
      const toolNames = Object.keys(definitions)
      if (typeof ctx?.tool?.transform === "function" && toolNames.length > 0) {
        registrations.push(
          await ctx.tool.transform((editor: any) => {
            for (const name of toolNames) {
              const definition = definitions[name]
              // OpenCode's tool-module loader already normalized ECC's
              // `{ description, args, execute }` into `{ name, description,
              // input, run }` with `input` as real JSON Schema. Raw shapes are
              // still supported as a fallback so a different loader version
              // cannot silently drop the parameter schema.
              const hasNormalizedInput =
                definition?.input &&
                typeof definition.input === "object" &&
                (definition.input as any).type === "object"
              const run =
                typeof definition?.run === "function" ? definition.run : definition?.execute
              const inputSchema = hasNormalizedInput
                ? definition.input
                : toInputSchema(definition?.args)
              if (Object.keys(inputSchema?.properties ?? {}).length === 0) {
                // A zero-argument schema hides the real parameters from the model,
                // so surface it instead of shipping a silently crippled tool.
                appendEccLog(
                  `tool ${name} registered without parameters (args=${Boolean(definition?.args)}, input=${Boolean(definition?.input)})`,
                )
              }
              editor.add({
                name,
                description: String(definition?.description ?? name),
                input: inputSchema,
                execute: async (input: any, context: any) => {
                  if (typeof run !== "function") {
                    throw new Error(`ECC tool ${name} has no executable entrypoint`)
                  }
                  // Two call shapes:
                  //  - OpenCode's loader normalizes `{ description, args,
                  //    execute }` into `{ name, description, input, run }`,
                  //    where `run(input, cwd)` takes the project directory as a
                  //    plain string.
                  //  - A raw ECC definition (execute) still expects the V1
                  //    `{ directory, worktree, sessionID, agent, signal }`
                  //    context, which is also supplied for compatibility.
                  const result =
                    typeof definition?.run === "function"
                      ? await definition.run(input ?? {}, worktreePath)
                      : await definition.execute(input ?? {}, {
                        directory: worktreePath,
                        worktree: worktreePath,
                        sessionID: context?.sessionID,
                        agent: context?.agent,
                        signal: context?.signal,
                      })
                  return { content: String(result) }
                },
              })
            }
          }),
        )
      }

      // --- Event-driven hooks -----------------------------------------------
      if (typeof ctx?.event?.subscribe === "function") {
        void (async () => {
          try {
            for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
              const type: string = event?.type ?? ""
              const props: LooseRecord = event?.properties ?? event ?? {}
              try {
                switch (type) {
                  case "file.edited": {
                    const p = props.file ?? props.path ?? props.filePath
                    if (typeof p === "string" && isInsideWorktree(p)) await hooks["file.edited"]({ path: p })
                    break
                  }
                  case "file.watcher.updated": {
                    const p = props.file ?? props.path
                    if (typeof p === "string" && isInsideWorktree(p)) {
                      await hooks["file.watcher.updated"]({ path: p, type: String(props.type ?? "") })
                    }
                    break
                  }
                  case "session.created":
                    if (isPrimary()) await hooks["session.created"]()
                    break
                  case "session.idle":
                    if (isPrimary()) await hooks["session.idle"]()
                    break
                  case "session.deleted":
                    // Every instance clears its own pending tool changes.
                    await hooks["session.deleted"]()
                    break
                  case "todo.updated":
                    if (isPrimary()) await hooks["todo.updated"]({ todos: Array.isArray(props.todos) ? props.todos : [] })
                    break
                  default:
                    break
                }
              } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : String(error)
                console.debug(`[ecc] event ${type} handler failed: ${errorMessage}`)
              }
            }
          } catch (error: unknown) {
            // A normal unload abort is expected during disposal.
            if (controller.signal.aborted) return
            const errorMessage = error instanceof Error ? error.message : String(error)
            console.warn(`[ecc] event subscription failed (hooks still registered): ${errorMessage}`)
          }
        })()
      }
    }

    // If any registration throws, dispose what was registered before surfacing
    // the error, so a later load attempt starts from a clean slate.
    try {
      await registerDomains()
    } catch (error: unknown) {
      controller.abort()
      forgetInstance()
      await disposeRegistrations(registrations)
      appendEccLog(`setup failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }

    appendEccLog(
      `registered ${Object.keys((runtime.tool ?? {}) as Record<string, unknown>).length} tools, ${registrations.length} hook registrations, primary=${isPrimary()}`,
    )

    return async () => {
      controller.abort()
      forgetInstance()
      await disposeRegistrations(registrations)
      appendEccLog(`cleanup (directory=${directory})`)
    }
  },
}

/** Dispose every registration, awaiting promises so no rejection is unhandled. */
async function disposeRegistrations(
  registrations: { dispose?: () => Promise<void> | void }[],
): Promise<void> {
  for (const registration of registrations) {
    try {
      await Promise.resolve().then(() => registration?.dispose?.())
    } catch {
      // Best-effort dispose.
    }
  }
}
