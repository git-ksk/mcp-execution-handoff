import { spawn } from "node:child_process";
import { once } from "node:events";

await import("./container-acceptance.mjs");

const revision = process.env.GITHUB_SHA;
if (!revision || !/^[0-9a-f]{40}$/.test(revision)) {
  throw new Error("Issue #160 CI baseline requires exact GITHUB_SHA");
}

async function run(executable, args, env = process.env) {
  const child = spawn(executable, args, { stdio: "inherit", env });
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`${executable} exited with ${code}`);
}

await run("docker", [
  "build", "-f", "experiments/websocket-cloud-run/Dockerfile.managed",
  "-t", "handoff-managed-acceptance:baseline", "."
]);

for (let baselineRun = 1; baselineRun <= 3; baselineRun += 1) {
  process.stdout.write(`MANAGED_WSS_BASELINE_RUN_START:${baselineRun}\n`);
  await run(process.execPath, ["experiments/websocket-cloud-run/managed-container-latency.mjs"], {
    ...process.env,
    HANDOFF_BASELINE_RUN: String(baselineRun),
    HANDOFF_ACCEPTANCE_REVISION: revision,
    HANDOFF_MANAGED_ACCEPT_IMAGE: "handoff-managed-acceptance:baseline"
  });
}
