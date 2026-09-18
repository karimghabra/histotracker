/**
 * A vitest reporter for a reader who pays per token: one line when green; per failure,
 * file:line, the test name and the first lines of the assertion message. Everything
 * else (full messages, stacks, console output) goes to $COMPACT_LOG, never to stdout.
 */
import type { File, Reporter, Task } from "vitest";
import { appendFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const LOG = process.env.COMPACT_LOG ?? "/dev/null";

function leaves(tasks: Task[]): Task[] {
  return tasks.flatMap((t) => ("tasks" in t && t.tasks ? leaves(t.tasks) : [t]));
}

export default class CompactReporter implements Reporter {
  private started = Date.now();

  onInit() {
    writeFileSync(LOG, "");
  }

  onUserConsoleLog(log: { content: string }) {
    appendFileSync(LOG, log.content);
  }

  onFinished(files: File[] = [], errors: unknown[] = []) {
    const tests = leaves(files.flatMap((f) => f.tasks));
    const failed = tests.filter((t) => t.result?.state === "fail");
    const passed = tests.filter((t) => t.result?.state === "pass").length;
    const secs = ((Date.now() - this.started) / 1000).toFixed(1);
    const status = failed.length || errors.length ? "FAILED" : "PASSED";
    console.log(`${process.env.COMPACT_LABEL ?? "vitest"} ${status}: ${passed}/${tests.length} passed, ${failed.length} failed, ${secs}s`);
    for (const t of failed) {
      const file = relative(process.cwd(), t.file?.filepath ?? "");
      const line = t.location?.line ?? 0;
      const err = t.result?.errors?.[0];
      const msg = strip(err?.message ?? "no message").split("\n").filter((l) => l.trim());
      console.log(`FAIL ${file}:${line} › ${t.name}`);
      for (const l of msg.slice(0, 6)) console.log(`  ${l.slice(0, 220)}`);
      appendFileSync(LOG, `\n=== ${file}:${line} ${t.name}\n${strip(err?.stack ?? err?.message ?? "")}\n`);
    }
    for (const e of errors) {
      const text = strip(String((e as Error)?.stack ?? e));
      console.log(`ERROR ${text.split("\n")[0].slice(0, 220)}`);
      appendFileSync(LOG, `\n=== unhandled\n${text}\n`);
    }
    if (failed.length) console.log(`  full log: ${LOG}`);
  }
}
