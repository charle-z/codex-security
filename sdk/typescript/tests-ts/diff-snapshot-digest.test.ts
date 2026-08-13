import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { runWorkbench } from "../src/runtime.js";
import { PLUGIN_ROOT } from "./plugin-root.js";

type JsonObject = Record<string, unknown>;

type Fixture = {
  python: string;
  repository: string;
  stateDir: string;
  scanDir: string;
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function runGit(repository: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function expectedImmutableDigest(
  kind: "commit" | "range",
  baseRevision: string,
  headRevision: string,
): string {
  const digest = createHash("sha256")
    .update("codex-security-diff/v1\0")
    .update(kind)
    .update("\0")
    .update(baseRevision)
    .update("\0")
    .update(headRevision)
    .digest("hex");
  return `codex-security-snapshot/v1:sha256:${digest}`;
}

async function createFixture(): Promise<
  Fixture & { root: string; first: string; second: string; third: string }
> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "codex-security-diff-digest-")),
  );
  temporaryDirectories.push(root);
  const repository = join(root, "repository");
  const scanDir = join(root, "scan");
  await mkdir(repository);
  await mkdir(scanDir, { mode: 0o700 });
  runGit(repository, ["init", "--quiet"]);
  runGit(repository, ["config", "user.name", "Codex Security"]);
  runGit(repository, [
    "config",
    "user.email",
    "codex-security@example.invalid",
  ]);
  await writeFile(join(repository, "app.ts"), "export const value = 1;\n");
  runGit(repository, ["add", "app.ts"]);
  runGit(repository, ["commit", "--quiet", "-m", "first"]);
  const first = runGit(repository, ["rev-parse", "HEAD"]);
  await writeFile(join(repository, "app.ts"), "export const value = 2;\n");
  runGit(repository, ["add", "app.ts"]);
  runGit(repository, ["commit", "--quiet", "-m", "second"]);
  const second = runGit(repository, ["rev-parse", "HEAD"]);
  await writeFile(join(repository, "app.ts"), "export const value = 3;\n");
  runGit(repository, ["add", "app.ts"]);
  runGit(repository, ["commit", "--quiet", "-m", "third"]);
  const third = runGit(repository, ["rev-parse", "HEAD"]);
  const python = Bun.which("python3") ?? Bun.which("python");
  expect(python).not.toBeNull();
  return {
    root,
    repository,
    scanDir,
    stateDir: join(root, "state"),
    python: python!,
    first,
    second,
    third,
  };
}

async function workbench(fixture: Fixture, args: readonly string[]) {
  return runWorkbench(
    {
      python: fixture.python,
      pluginRoot: PLUGIN_ROOT,
      environment: {
        PATH: process.env["PATH"],
        CODEX_SECURITY_STATE_DIR: fixture.stateDir,
      },
    },
    args,
  );
}

async function inspectDiff(
  fixture: Fixture,
  kind: "commit" | "range" | "working_tree",
  baseRevision?: string,
  headRevision?: string,
) {
  return workbench(fixture, [
    "inspect-setup",
    "--target-path",
    fixture.repository,
    "--scope",
    ".",
    "--mode",
    "diff",
    "--diff-target-kind",
    kind,
    ...(baseRevision === undefined
      ? []
      : ["--diff-base-revision", baseRevision]),
    ...(headRevision === undefined
      ? []
      : ["--diff-head-revision", headRevision]),
  ]);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

describe("diff snapshot digests", () => {
  test("derives deterministic identities for commit, range, and working-tree targets", async () => {
    const fixture = await createFixture();
    const commit = await inspectDiff(
      fixture,
      "commit",
      fixture.second,
      fixture.third,
    );
    const range = await inspectDiff(
      fixture,
      "range",
      fixture.second,
      fixture.third,
    );
    const widerRange = await inspectDiff(
      fixture,
      "range",
      fixture.first,
      fixture.third,
    );
    const repeatedRange = await inspectDiff(
      fixture,
      "range",
      fixture.second,
      fixture.third,
    );
    const commitTarget = commit["diffTarget"] as JsonObject;
    const rangeTarget = range["diffTarget"] as JsonObject;
    const widerRangeTarget = widerRange["diffTarget"] as JsonObject;

    expect(commitTarget["contentDigest"]).toBe(
      expectedImmutableDigest("commit", fixture.second, fixture.third),
    );
    expect(rangeTarget["contentDigest"]).toBe(
      expectedImmutableDigest("range", fixture.second, fixture.third),
    );
    expect(repeatedRange["diffTarget"]).toEqual(rangeTarget);
    expect(commitTarget["contentDigest"]).not.toBe(
      rangeTarget["contentDigest"],
    );
    expect(widerRangeTarget["contentDigest"]).not.toBe(
      rangeTarget["contentDigest"],
    );

    await writeFile(join(fixture.repository, "app.ts"), "export const value = 4;\n");
    const workingTree = await inspectDiff(fixture, "working_tree");
    const repeatedWorkingTree = await inspectDiff(fixture, "working_tree");
    const workingTreeTarget = workingTree["diffTarget"] as JsonObject;
    expect(workingTreeTarget["contentDigest"]).toMatch(
      /^codex-security-snapshot\/v1:sha256:[a-f0-9]{64}$/,
    );
    expect(repeatedWorkingTree["diffTarget"]).toEqual(workingTreeTarget);
    await writeFile(join(fixture.repository, "app.ts"), "export const value = 5;\n");
    const changedWorkingTree = await inspectDiff(fixture, "working_tree");
    expect(
      (changedWorkingTree["diffTarget"] as JsonObject)["contentDigest"],
    ).not.toBe(workingTreeTarget["contentDigest"]);
  });

  test("preserves a range digest through CLI registration and completion", async () => {
    const fixture = await createFixture();
    const expectedDigest = expectedImmutableDigest(
      "range",
      fixture.first,
      fixture.third,
    );
    const registration = await workbench(fixture, [
      "register-cli-scan",
      "--repository",
      fixture.repository,
      "--scan-dir",
      fixture.scanDir,
      "--recipe-json",
      JSON.stringify({
        config: {},
        mode: "standard",
        repository: fixture.repository,
        target: {
          kind: "refs",
          paths: [],
          base: fixture.first,
          head: fixture.third,
        },
      }),
    ]);
    const contract = registration["contract"] as {
      diffTarget: { contentDigest?: string };
    };
    expect(contract.diffTarget.contentDigest).toBe(expectedDigest);

    const scanId = String(registration["scanId"]);
    await cp(
      join(PLUGIN_ROOT, "examples", "completed-scan"),
      fixture.scanDir,
      { recursive: true },
    );
    const manifestPath = join(fixture.scanDir, "scan-manifest.json");
    const manifest = await readJson<{
      scan: {
        id: string;
        target: { kind: string };
        sealedAt?: string;
        artifacts?: unknown[];
      };
    }>(manifestPath);
    manifest.scan.id = scanId;
    manifest.scan.target.kind = "git_diff";
    delete manifest.scan.sealedAt;
    delete manifest.scan.artifacts;
    await writeJson(manifestPath, manifest);
    for (const name of ["findings.json", "coverage.json"] as const) {
      const path = join(fixture.scanDir, name);
      const document = await readJson<{ scanId: string }>(path);
      document.scanId = scanId;
      await writeJson(path, document);
    }
    await writeFile(join(fixture.scanDir, "report.md"), "# Draft report\n");

    await workbench(fixture, [
      "prepare-scan-completion",
      "--scan-id",
      scanId,
    ]);
    const preparedManifest = await readJson<{
      scan: { target: { snapshotDigest?: string } };
    }>(manifestPath);
    expect(preparedManifest.scan.target.snapshotDigest).toBe(expectedDigest);
    const completed = await workbench(fixture, [
      "complete-scan",
      "--scan-id",
      scanId,
    ]);
    expect(
      (completed["scan"] as { progress: { status: string } }).progress.status,
    ).toBe("complete");
  });
});