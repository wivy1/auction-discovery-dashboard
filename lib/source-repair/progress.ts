const PROGRESS_REFRESH_INTERVAL = 250;
const NON_TTY_HEARTBEAT_INTERVAL = 30_000;

/** A single stderr surface; stdout remains a JSON result channel. */
export class RepairProgress {
  private readonly started = performance.now();
  private readonly tty = Boolean(process.stderr.isTTY);
  private readonly timer: ReturnType<typeof setInterval>;
  private phase = "diagnostics";
  private stage = 1;
  private last = "";
  private lastOutputAt = 0;
  private ended = false;
  constructor(private readonly quiet = false) {
    this.timer = setInterval(() => this.render(false), this.tty ? PROGRESS_REFRESH_INTERVAL : NON_TTY_HEARTBEAT_INTERVAL);
    this.timer.unref();
  }
  update(phase: string): void {
    this.phase = phase;
    this.stage = ({ diagnostics: 1, eligibility: 2, proposal: 3, "isolated tests": 4 } as Record<string, number>)[phase] ?? this.stage;
    this.render(true);
  }
  finish(failed = false): void {
    if (this.ended) return;
    this.ended = true; clearInterval(this.timer);
    if (this.quiet) return;
    const elapsed = Math.floor((performance.now() - this.started) / 1_000);
    const line = failed ? `${this.stage}/5: failed during ${this.phase} (${elapsed}s)` : `5/5: done in ${elapsed}s`;
    process.stderr.write(`${this.tty ? "\r\u001b[K" : ""}${this.fit(line)}\n`);
  }
  private fit(value: string): string {
    const width = process.stderr.columns ?? 100;
    return value.length < width ? value : value.slice(0, Math.max(1, width - 2)) + "…";
  }
  private render(force: boolean): void {
    if (this.quiet || this.ended) return;
    const now = performance.now();
    const line = this.fit(`${this.stage}/5: ${this.phase} · ${Math.floor((now - this.started) / 1_000)}s elapsed`);
    if (!force && (now - this.lastOutputAt < (this.tty ? PROGRESS_REFRESH_INTERVAL : NON_TTY_HEARTBEAT_INTERVAL) || line === this.last)) return;
    if (this.tty) process.stderr.write(`\r\u001b[K${line}`);
    else process.stderr.write(`${force ? "start" : "active"}: ${line}\n`);
    this.last = line; this.lastOutputAt = now;
  }
}
