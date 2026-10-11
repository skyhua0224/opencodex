# GUI Service Controls

The desktop GUI's service lifecycle surfaces: the dashboard control that stops the proxy, and
the runtime provenance the running service reports about the Bun binary it was started with.
The surrounding management surface is described in
[GUI And Management API](gui-and-management-api.md).

## Sidebar stop button

The dashboard sidebar includes a stop button that calls `POST /api/stop`. The button shows a
confirmation prompt, then fires the request and accepts the connection drop (the proxy exits). The
endpoint restores native Codex config, stops any installed service to prevent respawn, and exits.
While the desktop app supervises the proxy it refuses a dashboard session with 409
`desktop_supervised` before touching anything, because the app would start the proxy again
([desktop shell](desktop-shell.md#keeping-the-runtime-alive)); the button reports the refusal.

## Bun runtime provenance

`GET /api/system/memory` may report `bunRuntimeSource` — one of `override`, `bundled`, or
`process` — describing how the **running service** obtained its Bun binary.

The value is stamped into the launched process's environment as a pair —
`OCX_BUN_RUNTIME_SOURCE` plus `OCX_BUN_RUNTIME_PATH`, the binary it was minted for — by whichever
launcher selected that binary: the npm Node launcher, the Windows Task Scheduler wrapper, the
native WinSW service, launchd, systemd, the Codex autostart shim, and the Windows tray host. Both
halves come from a single `durableBunRuntime()` resolution at each site, so the marker can never
describe a different binary than the one actually baked.

Launchers that re-exec `process.execPath` instead of resolving a binary — `ocx ensure`, GUI/Claude/
OpenCode start, `POST /api/system/restart`, and the update relaunch — go through
`withProcessRuntimeProvenance()`. An inherited marker is carried forward only when its recorded
path is the executable about to run, compared through `realpath` so symlinks, junctions, and
Windows case differences do not break a valid match. The recorded path is what settles this rather
than re-deriving the original selection: a service installed with a shell-local override keeps
neither that shell nor its `OPENCODEX_BUN_PATH`, so re-deriving would demote a correct `override`
to `process` on the first relaunch. A marker that describes some other binary — inheritance
travels down a process tree and can outlive the binary it was minted for — is dropped in favor of
what is actually executing.

The Codex shims scope the pair to their `ensure` invocation (an assignment prefix in `sh`,
`setlocal`/`endlocal` in `cmd`, save-and-restore in PowerShell) rather than exporting it. A shim
wraps the real `codex`, so an exported marker would be inherited by Codex and everything it
spawns.

**Trust rule: a reporting surface must never resolve provenance for itself.** Calling
`durableBunRuntime()` at report time answers "what would this process pick right now", which is
a different question from "what was the service started with" — and the two diverge exactly when
the answer matters, such as a `doctor` run in a shell whose `OPENCODEX_BUN_PATH` differs from the
installed service's. Read-back goes through `reportedBunRuntimeSource()`, which allowlists the
three values and returns `undefined` for anything else.

**Backward compatibility: absent is a real answer.** A service installed before this marker
existed reports no provenance, the endpoint omits the field, and consumers must say the origin is
unknown rather than infer one. `ocx doctor` relies on this to avoid its previous behavior of
telling a user to set `OPENCODEX_BUN_PATH` when the override was already active (#848). An
unrecognized wire value is treated as absent rather than passed through.

`bunRevision` remains informational and carries no capability meaning. Provenance does not feed
the eager-relay decision: the conservative `auto-known-bad` result for canary and otherwise
unvalidated Bun builds is unchanged (`src/lib/bun-stream-caps.ts`).
