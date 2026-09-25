export const MAX_CODEX_WS_SESSION_EXCHANGES = 32;

/** Owns one physical socket; request listeners belong to the exchange, not this object. */
export class CodexWsSession {
  readonly socket: WebSocket;
  opened = false;
  closed = false;
  busy = false;
  /**
   * True when this lease handed the socket to a LATER turn of the same conversation, not to a
   * resend inside the turn that opened it. Set by the pool at acquire time and never cleared: the
   * exchange uses it to bound how long it will wait for the first frame and to attribute the
   * outcome to the cross-turn experiment.
   */
  crossTurnReuse = false;
  /**
   * Evidence sink for the retained-socket lifecycle, owned by the pool (which decides whether the
   * operator asked for these rows). Every call is best-effort: diagnostics never affect a turn.
   */
  onLifecycle?: (event: Record<string, unknown>) => void;
  private owner?: (reason: Error) => void;
  private readonly completedIds = new Set<string>();

  constructor(url: string, headers: Record<string, string>, readonly retainable = false,
    private readonly changed: () => void = () => {}, proxy?: string) {
    this.socket = new WebSocket(url, { headers, ...(proxy ? { proxy } : {}) } as unknown as string[]);
    this.socket.addEventListener("open", this.onOpen);
    this.socket.addEventListener("message", this.onIdleMessage);
    this.socket.addEventListener("close", this.onClose);
    this.socket.addEventListener("error", this.onIdleError);
  }

  get reused(): boolean { return this.completedIds.size > 0; }
  hasCompleted(id: string): boolean { return this.completedIds.has(id); }
  markCrossTurnReuse(): void { this.crossTurnReuse = true; }

  reserve(): boolean {
    if (this.closed || this.busy || (this.opened && this.socket.readyState !== undefined && this.socket.readyState !== 1)) return false;
    this.busy = true;
    const socket = this.socket as WebSocket & { ref?: () => void };
    try { socket.ref?.(); } catch { /* optional keepalive hint */ }
    return true;
  }

  bindOwner(owner: (reason: Error) => void): () => void {
    if (!this.busy || this.closed || this.owner) throw new Error("codex websocket lease is unavailable");
    this.owner = owner;
    return () => { if (this.owner === owner) this.owner = undefined; };
  }

  release(completedId: string | null): void {
    this.owner = undefined;
    if (this.closed) return;
    if (!this.retainable || !completedId || !this.opened
      || (this.socket.readyState !== undefined && this.socket.readyState !== 1)) {
      this.note({
        event: "session-release", retained: false,
        reason: !this.retainable ? "not-retainable" : !completedId ? "no-completed-id"
          : !this.opened ? "never-opened" : "socket-not-open",
        readyState: this.socket.readyState,
      });
      this.dispose();
      return;
    }
    this.completedIds.add(completedId);
    if (this.completedIds.size >= MAX_CODEX_WS_SESSION_EXCHANGES) {
      this.note({ event: "session-release", retained: false, reason: "exchange-budget",
        exchanges: this.completedIds.size });
      this.dispose();
      return;
    }
    this.note({ event: "session-release", retained: true, exchanges: this.completedIds.size });
    this.busy = false;
    const socket = this.socket as WebSocket & { unref?: () => void };
    try { socket.unref?.(); } catch { /* optional hint; shutdown/expiry still owns cleanup */ }
    this.changed();
  }

  dispose(reason = new Error("codex websocket session disposed")): void {
    if (this.closed) return;
    this.closed = true;
    const owner = this.owner;
    this.owner = undefined;
    this.detach();
    try { owner?.(reason); } finally {
      this.note({ event: "session-dispose", reason: reason.message.slice(0, 60) });
      this.busy = false;
      this.completedIds.clear();
      try { this.socket.close(); } catch { /* already closing */ }
      if (this.retainable) {
        try { (this.socket as WebSocket & { terminate?: () => void }).terminate?.(); } catch { /* already closed */ }
      }
      this.changed();
    }
  }

  private note(event: Record<string, unknown>): void {
    try { this.onLifecycle?.(event); } catch { /* diagnostics must not affect a turn */ }
  }

  private onOpen = (): void => { this.opened = true; };
  private onIdleMessage = (): void => {
    if (!this.busy) this.dispose(new Error("codex websocket received unsolicited idle data"));
  };
  private onIdleError = (): void => { if (!this.busy) this.dispose(); };
  private onClose = (event?: { code?: number }): void => {
    this.note({ event: "session-close", code: typeof event?.code === "number" ? event.code : null,
      busy: this.busy, exchanges: this.completedIds.size });
    this.closed = true;
    this.busy = false;
    this.completedIds.clear();
    this.detach();
    this.changed();
    // The active exchange's close listener retains pre-send fallback semantics.
  };
  private detach(): void {
    this.socket.removeEventListener("open", this.onOpen);
    this.socket.removeEventListener("message", this.onIdleMessage);
    this.socket.removeEventListener("close", this.onClose);
    this.socket.removeEventListener("error", this.onIdleError);
  }
}
