import { expect, test } from "bun:test";
import { makeTempDirectory, startHost, urlOf, waitFor } from "./helpers";

test("concurrency is capped at 3", async () => {
  const host = await startHost();
  let running = 0;
  let peak = 0;
  let finished = 0;
  const release: (() => void)[] = [];
  for (let index = 0; index < 6; index++) {
    host.context.jobs.submit({ type: "cap" }, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running -= 1;
      finished += 1;
    });
  }
  await waitFor(() => release.length === 3);
  await Bun.sleep(50);
  expect(peak).toBe(3);
  expect(host.context.jobs.isRunning("cap")).toBe(true);
  while (finished < 6) {
    release.splice(0).forEach((resolve) => resolve());
    await Bun.sleep(10);
  }
  expect(peak).toBe(3);
  await waitFor(() => !host.context.jobs.isRunning("cap"));
  await host.stop();
});

test("errors and success set state; http listing works", async () => {
  const host = await startHost();
  const failing = host.context.jobs.submit({ type: "bad", sessionId: "s1" }, async () => {
    throw new Error("nope");
  });
  const passing = host.context.jobs.submit({ type: "good", sessionId: "s2" }, async () => {});
  await waitFor(() => host.context.jobs.list({ activeOnly: true }).length === 0);
  expect(host.context.jobs.get(failing.id)).toMatchObject({ state: "error", error: "nope" });
  expect(host.context.jobs.get(passing.id)?.state).toBe("done");

  const listed = await (await fetch(urlOf(host, "/api/jobs?sessionId=s1"))).json();
  expect(listed.map((job: any) => job.id)).toEqual([failing.id]);
  expect((await fetch(urlOf(host, "/api/jobs/missing"))).status).toBe(404);
  await host.stop();
});

test("running jobs become interrupted on next boot", async () => {
  const workspaceDirectory = makeTempDirectory();
  const first = await startHost(workspaceDirectory);
  const job = first.context.jobs.submit({ type: "hang" }, () => new Promise<void>(() => {}));
  await Bun.sleep(20);
  await first.stop();

  const second = await startHost(workspaceDirectory);
  expect(second.context.jobs.get(job.id)?.state).toBe("interrupted");
  await second.stop();
});

test("throttled progress is persisted at the end", async () => {
  const host = await startHost();
  const job = host.context.jobs.submit({ type: "progress", total: 100 }, async (handle) => {
    for (let done = 1; done <= 100; done++) {
      handle.progress(done);
    }
  });
  await waitFor(() => host.context.jobs.get(job.id)?.state === "done");
  const row = host.context.db.database.query("SELECT done, total, state FROM jobs WHERE id = ?").get(job.id);
  expect(row).toEqual({ done: 100, total: 100, state: "done" });
  await host.stop();
});
