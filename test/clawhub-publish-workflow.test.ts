import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const workflow = readFileSync(
  `${repositoryRoot}/.github/workflows/clawhub-publish.yml`,
  "utf8",
);
const npmPublishWorkflow = readFileSync(
  `${repositoryRoot}/.github/workflows/publish.yml`,
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

    expect(refs).toEqual([
      clawhubWorkflowCommit,
      clawhubWorkflowCommit,
      clawhubWorkflowCommit,
    ]);
  });

  it("resolves the requested release tag to the npm commit", () => {
    expect(workflow).toContain("release_tag:");
    expect(workflow).toContain("release-preflight:");
    expect(workflow).toContain("ref: ${{ inputs.release_tag }}");
    expect(workflow).toContain(
      'git fetch --no-tags origin "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"',
    );
    expect(workflow).toContain(
      'tag_sha="$(git rev-list -n 1 "refs/tags/$RELEASE_TAG")"',
    );
    expect(workflow).toContain('source_sha" != "$tag_sha"');
    expect(workflow).toContain(
      'npm view "$package_name@$version" version gitHead --json',
    );
    expect(workflow).toContain('published_sha" != "$source_sha"');
    expect(workflow).toContain('echo "source_sha=$source_sha" >> "$GITHUB_OUTPUT"');
  });

  it("binds manual validation and publication to the verified commit", () => {
    expect(workflow).toMatch(
      /release-dry-run:\n\s+needs: release-preflight(?:.|\n)*?source: \$\{\{ github\.repository \}\}(?:.|\n)*?ref: \$\{\{ needs\.release-preflight\.outputs\.source_sha \}\}(?:.|\n)*?source_ref: refs\/tags\/\$\{\{ inputs\.release_tag \}\}/,
    );
    expect(workflow).toMatch(
      /publish:\n\s+needs: release-preflight(?:.|\n)*?source: \$\{\{ github\.repository \}\}(?:.|\n)*?ref: \$\{\{ needs\.release-preflight\.outputs\.source_sha \}\}(?:.|\n)*?source_ref: refs\/tags\/\$\{\{ inputs\.release_tag \}\}/,
    );
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

  it("dispatches a real ClawHub publish after the npm release completes", () => {
    expect(npmPublishWorkflow).toMatch(
      /permissions:\n(?:.|\n)*?actions: write/,
    );
    expect(npmPublishWorkflow).toContain(
      "actions/workflows/clawhub-publish.yml/dispatches",
    );
    expect(npmPublishWorkflow).toContain(
      "WORKFLOW_REF: ${{ github.event.repository.default_branch }}",
    );
    expect(npmPublishWorkflow).toContain(
      'RELEASE_TAG: v${{ steps.package.outputs.version }}',
    );
    expect(npmPublishWorkflow).toContain(
      "inputs: {release_tag: $release_tag, dry_run: false}",
    );
    expect(npmPublishWorkflow.indexOf("Create GitHub release")).toBeLessThan(
      npmPublishWorkflow.indexOf("Dispatch ClawHub publish"),
    );
  });
});
