import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  selectRecoveryRelease,
  verifyRecoveryPackage,
} from "../../../scripts/ci/release-recovery.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const sourceSha = "a".repeat(40);
const job = (name: string, conclusion = "success") => ({
  name,
  status: "completed",
  conclusion,
  steps: [],
});
const selection = () => ({
  repository: "fixture/rea",
  version: "6.5.0",
  tagSha: sourceSha,
  run: {
    id: 123,
    run_attempt: 1,
    path: ".github/workflows/release.yml",
    event: "pull_request",
    status: "completed",
    repository: { full_name: "fixture/rea" },
    head_repository: { full_name: "fixture/rea" },
  },
  release: {
    tag_name: "rea-agents-6.5.0",
    draft: false,
    published_at: "2026-10-14T12:32:45Z",
  },
  jobs: [
    job("Release reviewed main merge"),
    job("Qualify exact release revision / CI required"),
    {
      ...job("Publish to npm", "failure"),
      steps: [{ name: "Publish", conclusion: "success" }],
    },
  ],
});

it("recovers a failed post-publication run using its successful original qualification", () => {
  expect(selectRecoveryRelease(selection())).toEqual({
    version: "6.5.0",
    source_sha: sourceSha,
    run_id: 123,
    run_attempt: 1,
  });
});

it("recovers a byte-verified existing version when the npm write was skipped", () => {
  const input = selection();
  input.jobs[2]!.steps[0]!.conclusion = "skipped";
  input.jobs[2]!.steps.push({
    name: "Verify published npm bytes and dist-tag",
    conclusion: "success",
  });
  expect(selectRecoveryRelease(input)).toMatchObject({
    version: "6.5.0",
    run_id: 123,
  });
});

it.each(["failure", "skipped", "cancelled"])(
  "refuses recovery when original qualification was %s",
  (conclusion) => {
    const input = selection();
    input.jobs[1]!.conclusion = conclusion;
    expect(() => selectRecoveryRelease(input)).toThrow("did not pass");
  },
);

it("refuses absent or ambiguous qualification and unsuccessful npm publication", () => {
  const missing = selection();
  missing.jobs.splice(1, 1);
  expect(() => selectRecoveryRelease(missing)).toThrow(
    "Expected one completed",
  );
  const duplicate = selection();
  duplicate.jobs.push(job("Qualify exact release revision / CI required"));
  expect(() => selectRecoveryRelease(duplicate)).toThrow(
    "Expected one completed",
  );
  const unpublished = selection();
  unpublished.jobs[2]!.steps[0]!.conclusion = "failure";
  expect(() => selectRecoveryRelease(unpublished)).toThrow(
    "publication did not succeed",
  );
});

it("refuses foreign runs, unrelated workflows and unpublished releases", () => {
  const foreign = selection();
  foreign.run.head_repository.full_name = "outside/rea";
  expect(() => selectRecoveryRelease(foreign)).toThrow();
  const unrelated = selection();
  unrelated.run.path = ".github/workflows/ci.yml";
  expect(() => selectRecoveryRelease(unrelated)).toThrow();
  const draft = selection();
  draft.release.draft = true;
  expect(() => selectRecoveryRelease(draft)).toThrow();
  const wrongTag = selection();
  wrongTag.release.tag_name = "rea-agents-6.6.0";
  expect(() => selectRecoveryRelease(wrongTag)).toThrow();
});

it("requires npm bytes to match the retained archive and original source/run", async () => {
  const directory = await createTestTempDirectory("rea-release-recovery-");
  const archive = "original qualified archive";
  await writeFile(join(directory, "package.tgz"), archive);
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceSha,
      runId: 123,
      runAttempt: 1,
      platform: "linux",
      architecture: "x64",
      packageVersion: "6.5.0",
      nodeVersion: process.version,
      sha256: createHash("sha256").update(archive).digest("hex"),
    }),
  );
  const input = {
    directory,
    sourceSha,
    runId: 123,
    runAttempt: 1,
    version: "6.5.0",
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
  };
  await expect(verifyRecoveryPackage(input)).resolves.toMatchObject({
    version: "6.5.0",
    sourceSha,
  });
  await expect(
    verifyRecoveryPackage({ ...input, integrity: "sha512-wrong" }),
  ).rejects.toThrow("npm integrity differs");
  await expect(
    verifyRecoveryPackage({ ...input, sourceSha: "b".repeat(40) }),
  ).rejects.toThrow("source SHA mismatch");
  await expect(verifyRecoveryPackage({ ...input, runId: 456 })).rejects.toThrow(
    "workflow run ID mismatch",
  );
});
