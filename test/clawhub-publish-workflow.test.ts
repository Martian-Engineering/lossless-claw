import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const workflow = readFileSync(
  `${repositoryRoot}/.github/workflows/clawhub-publish.yml`,
  "utf8",
);
const releasing = readFileSync(`${repositoryRoot}/RELEASING.md`, "utf8");
const clawhubWorkflowCommit =
  "a230d962db64019462c2c8ee400755eb92169908";

describe("ClawHub publish workflow", () => {
  it("pins every reusable workflow call to the reviewed commit", () => {
    const refs = Array.from(
      workflow.matchAll(
        /openclaw\/clawhub\/.github\/workflows\/package-publish\.yml@([^\s]+)/g,
      ),
      (match) => match[1],
    );

    expect(refs).toEqual([clawhubWorkflowCommit, clawhubWorkflowCommit]);
  });

  it("requires the selected release tag to match the npm commit", () => {
    expect(workflow).toContain("release-preflight:");
    expect(workflow).toContain('GITHUB_REF_TYPE" != "tag"');
    expect(workflow).toContain('GITHUB_REF_NAME" != "$expected_tag"');
    expect(workflow).toContain(
      'npm view "$package_name@$version" version gitHead --json',
    );
    expect(workflow).toContain('published_sha" != "$GITHUB_SHA"');
    expect(workflow).toMatch(/publish:\n\s+needs: release-preflight/);
  });

  it("serializes real publishes without cancelling an active release", () => {
    expect(workflow).toMatch(
      /publish:\n(?:.|\n)*?concurrency:\n\s+group: clawhub-publish\n\s+cancel-in-progress: false/,
    );
  });

  it("documents npm-first publication from the matching release tag", () => {
    expect(releasing).toContain("Publish to npm first");
    expect(releasing).toContain("matching `vX.Y.Z` tag");
    expect(releasing).toContain("npm `gitHead`");
  });
});
