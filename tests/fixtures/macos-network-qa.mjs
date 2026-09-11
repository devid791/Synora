// Explicitly authorized temporary Mac QA isolation. Run as root, not shipped.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  chmod,
  lstat,
  rmdir,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const group = "synoraqa_20260909",
  gid = 64080,
  uid = 501;
const anchor = "com.apple/synoraqa_20260909";
const root = process.argv[3];
if (process.platform !== "darwin" || process.getuid() !== 0)
  throw Error("Root Mac QA operation required");
const cmd = (file, args, options = {}) =>
  execFileSync(file, args, {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
const processList = () =>
  cmd("/bin/ps", ["-axo", "pid=,gid=,lstart="])
    .trim()
    .split("\n")
    .map((line) => {
      const [, pid, actualGroup, started] =
        line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/) ?? [];
      return { pid: Number(pid), gid: Number(actualGroup), started };
    })
    .filter((row) => row.gid === gid && row.pid > 1);
async function cleanup(directory) {
  if (!/^\/private\/var\/tmp\/synora-network-[A-Za-z0-9]+$/.test(directory))
    throw Error("Unexpected QA state directory");
  const state = JSON.parse(
    await readFile(join(directory, "state.json"), "utf8"),
  );
  if (state.group !== group || state.gid !== gid || state.anchor !== anchor)
    throw Error("QA identity mismatch");
  try {
    await mkdir(join(directory, "cleanup.lock"));
  } catch (e) {
    if (e.code === "EEXIST") return;
    throw e;
  }
  try {
    try {
      await lstat(join(directory, "cleanup.json"));
      return;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const owned = processList();
    for (const row of owned)
      try {
        process.kill(row.pid, "SIGTERM");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const row of processList())
      if (
        owned.some((old) => old.pid === row.pid && old.started === row.started)
      ) {
        try {
          process.kill(row.pid, "SIGKILL");
        } catch (e) {
          if (e.code !== "ESRCH") throw e;
        }
      }
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (processList().length)
      throw Error("QA processes remain; retaining their egress protection");
    cmd("/sbin/pfctl", ["-a", anchor, "-F", "rules"]);
    if (state.pfToken) {
      cmd("/sbin/pfctl", ["-X", state.pfToken]);
      state.pfToken = null;
      await writeFile(join(directory, "state.json"), JSON.stringify(state), {
        mode: 0o600,
      });
    }
    const stored = cmd("/usr/bin/dscl", [
      ".",
      "-read",
      `/Groups/${group}`,
      "PrimaryGroupID",
    ]);
    if (stored.trim() !== `PrimaryGroupID: ${gid}`)
      throw Error("Refusing to remove a changed group");
    cmd("/usr/sbin/dseditgroup", ["-o", "delete", group]);
    if (cmd("/sbin/pfctl", ["-a", anchor, "-sr"]).trim())
      throw Error("Scoped QA anchor still contains rules");
    const after = {
      at: new Date().toISOString(),
      processesStopped: owned.map((p) => p.pid),
      pf: cmd("/sbin/pfctl", ["-s", "info"]),
      rules: cmd("/sbin/pfctl", ["-sr"]),
      removedGroup: group,
      globalRulesUnchanged: cmd("/sbin/pfctl", ["-sr"]) === state.baselineRules,
    };
    await writeFile(
      join(directory, "cleanup.json"),
      JSON.stringify(after, null, 2),
      { flag: "wx", mode: 0o644 },
    );
    console.log(
      JSON.stringify({
        cleanup: directory,
        processesStopped: owned.length,
        groupRemoved: true,
      }),
    );
    if (!after.globalRulesUnchanged)
      throw Error(
        "Global PF rules changed during QA; no automatic global repair attempted",
      );
  } finally {
    // A failed cleanup must remain retryable by the independent watchdog.
    await rmdir(join(directory, "cleanup.lock"));
  }
}
if (process.argv[2] === "watchdog") {
  await new Promise((resolve) => setTimeout(resolve, 480000));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await cleanup(root);
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
} else if (process.argv[2] === "cleanup") {
  await cleanup(root);
} else {
  const [host, tcp, udp, candidate, selectedConfig, ...extra] =
    process.argv.slice(2);
  if (extra.length || (!candidate && selectedConfig))
    throw Error("Unexpected QA arguments");
  let plan, verifyPlan;
  // Dynamic import only in Run mode: watchdog/cleanup are self-contained copies.
  if (candidate) {
    const { candidatePlan, verifyCandidateFiles } = await import(
      "./native-provider-candidate.mjs"
    );
    plan = candidatePlan(
      candidate,
      process.platform,
      process.cwd(),
      selectedConfig,
    );
    verifyPlan = () => verifyCandidateFiles(plan);
    await verifyPlan(); // No OS/process mutation until exact identity passes.
  }
  if (
    host !== "10.23.46.16" ||
    ![tcp, udp].every((p) => /^\d+$/.test(p) && +p > 1024 && +p < 65536)
  )
    throw Error("Unexpected QA probe address");
  const owner = cmd("/usr/bin/id", ["-u", "synora"]).trim();
  if (owner !== String(uid)) throw Error("QA GUI user identity changed");
  if (
    cmd("/usr/bin/dscl", [
      ".",
      "-search",
      "/Groups",
      "PrimaryGroupID",
      String(gid),
    ]).trim()
  )
    throw Error("QA group ID already used");
  try {
    cmd("/usr/bin/dscl", [".", "-read", `/Groups/${group}`]);
    throw Error("QA group already exists");
  } catch (e) {
    if (!/eDSRecordNotFound/.test(String(e.stdout) + String(e.stderr))) throw e;
  }
  const baselineRules = cmd("/sbin/pfctl", ["-sr"]);
  if (!baselineRules.includes('anchor "com.apple/*"'))
    throw Error(
      "No existing Apple anchor; refusing to rewrite global PF rules",
    );
  if (cmd("/sbin/pfctl", ["-a", anchor, "-sr"]).trim())
    throw Error("QA PF anchor is already populated");
  const directory = await mkdtemp("/private/var/tmp/synora-network-");
  await chmod(directory, 0o755);
  const rules = `block return out quick inet proto { tcp udp } from any to ! 127.0.0.0/8 group ${gid} label "synora_qa_ipv4"\nblock return out quick inet6 proto { tcp udp } from any to ! ::1 group ${gid} label "synora_qa_ipv6"\n`;
  await writeFile(join(directory, "rules.pf"), rules, {
    mode: 0o644,
    flag: "wx",
  });
  cmd("/sbin/pfctl", ["-a", anchor, "-nf", join(directory, "rules.pf")]);
  const state = {
    group,
    gid,
    anchor,
    baselineRules,
    baselinePf: cmd("/sbin/pfctl", ["-s", "info"]),
    pfToken: null,
  };
  cmd("/usr/sbin/dseditgroup", [
    "-o",
    "create",
    "-i",
    String(gid),
    "-r",
    "Synora temporary QA network identity",
    group,
  ]);
  await writeFile(join(directory, "state.json"), JSON.stringify(state), {
    mode: 0o600,
  });
  await copyFile(fileURLToPath(import.meta.url), join(directory, "guard.mjs"));
  await chmod(join(directory, "guard.mjs"), 0o600);
  const watchdog = spawn(
    process.execPath,
    [join(directory, "guard.mjs"), "watchdog", directory],
    { detached: true, stdio: "ignore" },
  );
  watchdog.unref();
  const evidence = {
    directory,
    uid,
    gid,
    baseline: state,
    tests: [],
    probes: [],
    ...(plan ? { candidate: plan } : {}),
  };
  // Root uses the OS child identity controls. No sudoers or user memberships
  // change; descendants retain the GUI UID and this test-only primary GID.
  const childEnvironment = {
    PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: "/Users/synora",
    USER: "synora",
    LOGNAME: "synora",
    TMPDIR: "/tmp",
    LANG: "en_US.UTF-8",
  };
  try {
    cmd("/sbin/pfctl", ["-a", anchor, "-f", join(directory, "rules.pf")]);
    const enabled = spawnSync("/sbin/pfctl", ["-E"], {
      encoding: "utf8",
      timeout: 10000,
    });
    state.pfToken =
      `${enabled.stdout}\n${enabled.stderr}`.match(/Token\s*:\s*(\d+)/)?.[1] ??
      null;
    await writeFile(join(directory, "state.json"), JSON.stringify(state), {
      mode: 0o600,
    });
    if (enabled.status !== 0 || !state.pfToken)
      throw Error("PF enable reference was not confirmed");
    const probe = (selectedGroup) =>
      JSON.parse(
        cmd(
          process.execPath,
          ["tests/fixtures/macos-qa-probe.mjs", host, tcp, udp],
          {
            uid,
            gid: selectedGroup === "staff" ? 20 : gid,
            env: childEnvironment,
          },
        ),
      );
    const before = probe("staff"),
      blocked = probe(group),
      after = probe("staff");
    evidence.probes.push(before, blocked, after);
    if ([before, after].some((p) => p.tcp !== "allowed" || p.udp !== "allowed"))
      throw Error("Non-QA reachability control failed");
    if (
      blocked.gid !== gid ||
      blocked.egid !== gid ||
      blocked.uid !== uid ||
      [blocked.tcp, blocked.udp].some(
        (v) =>
          ![
            "timeout",
            "EHOSTUNREACH",
            "ECONNREFUSED",
            "EACCES",
            "EPERM",
          ].includes(v),
      )
    )
      throw Error("QA egress was not blocked");
    evidence.activeRules = cmd("/sbin/pfctl", ["-a", anchor, "-vvsr"]);
    const proof = {
      schema: "synora.qa-network.v1",
      gid,
      uid,
      anchor,
      host,
      tcp: Number(tcp),
      udp: Number(udp),
      expires: Date.now() + 420000,
      rootPid: process.pid,
      before,
      blocked,
      after,
    };
    await writeFile(join(directory, "proof.json"), JSON.stringify(proof), {
      flag: "wx",
      mode: 0o444,
    });
    console.log(
      JSON.stringify({
        isolated: true,
        directory,
        gid,
        probes: evidence.probes,
      }),
    );
    for (const config of plan
      ? [plan.config]
      : [
          "playwright.openai-provider-desktop.config.ts",
          "playwright.xai-desktop.config.ts",
        ]) {
      const child = spawn(
        process.execPath,
        ["node_modules/@playwright/test/cli.js", "test", "--config", config],
        {
          stdio: "inherit",
          uid,
          gid,
          env: {
            ...childEnvironment,
            SYNORA_QA_NETWORK_PROOF: join(directory, "proof.json"),
            SYNORA_TEST_EXECUTABLE:
              plan?.executable ??
              join(
                process.cwd(),
                "out/production-qa-macos-9cfc8ac/mac-arm64/Synora Harness Desktop.app/Contents/MacOS/Synora Harness Desktop",
              ),
          },
        },
      );
      let expired = false,
        killTimer;
      const deadline = setTimeout(() => {
        expired = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      }, 240000);
      let code;
      try {
        code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
      } finally {
        clearTimeout(deadline);
        clearTimeout(killTimer);
      }
      evidence.tests.push({ config, exitCode: code });
      if (expired) throw Error(`Native QA deadline: ${config}`);
      if (code !== 0) throw Error(`Native QA failed: ${config}`);
    }
    evidence.finalRules = cmd("/sbin/pfctl", ["-a", anchor, "-vvsr"]);
    evidence.finalControl = probe("staff");
    if (
      evidence.finalControl.tcp !== "allowed" ||
      evidence.finalControl.udp !== "allowed"
    )
      throw Error("Final non-QA control failed");
  } catch (error) {
    evidence.error = String(error);
    throw error;
  } finally {
    let cleanupFailure;
    try {
      await cleanup(directory);
      watchdog.kill("SIGTERM");
    } catch (error) {
      cleanupFailure = error;
      evidence.cleanupError = String(error);
      // Retain the watchdog and the original failure receipt for recovery.
    }
    if (verifyPlan) {
      try {
        await verifyPlan();
        evidence.candidateRestored = true;
      } catch (error) {
        evidence.candidateRestored = false;
        evidence.identityError = String(error);
      }
    }
    await writeFile(
      join(directory, "evidence.json"),
      JSON.stringify(evidence, null, 2),
      { mode: 0o644 },
    );
    if (cleanupFailure) throw cleanupFailure;
    if (evidence.candidateRestored === false)
      throw Error("QA candidate identity changed; see preserved evidence");
  }
}
