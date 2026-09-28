import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
    expect(workflow).toContain("release_channel:");
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
    expect(workflow).toContain(
      'expected_channel="$(node scripts/release-channel.mjs "$version"',
    );
    expect(workflow).toContain(
      'RELEASE_CHANNEL" != "$expected_channel"',
    );
    expect(workflow).toContain(
      'clawhub_tags="$(node scripts/release-channel.mjs "$version"',
    );
    expect(workflow).toContain(
      'echo "clawhub_tags=$clawhub_tags" >> "$GITHUB_OUTPUT"',
    );
  });

  it("builds a prebuilt package for pull-request validation", () => {
    expect(workflow).toMatch(
      /pull-request-package:\n(?:.|\n)*?npm ci(?:.|\n)*?npm run build(?:.|\n)*?npm pack --pack-destination "\$RUNNER_TEMP\/clawhub-pr-package"/,
    );
    expect(workflow).toMatch(
      /dry-run:\n\s+needs: pull-request-package(?:.|\n)*?package_artifact_name: clawhub-pr-package/,
    );
  });

  it.each([
    ["refs/tags/v1.1.1", "a".repeat(40), 0],
    ["refs/heads/main", "a".repeat(40), 1],
    ["refs/tags/v1.1.0", "a".repeat(40), 1],
    ["refs/tags/v1.1.1", "b".repeat(40), 1],
    ["a".repeat(40), "a".repeat(40), 1],
  ])("checks OIDC workflow identity %s at %s", (ref, sha, status) => {
    // Execute the workflow's guard so rejected identities cannot pass by string matching.
    const guard = workflow.match(/          if \[ "\$GITHUB_REF"[\s\S]*?          fi/);
    expect(guard).not.toBeNull();
    const result = spawnSync("bash", ["-euc", guard![0]], {
      env: {
        ...process.env,
        RELEASE_TAG: "v1.1.1",
        source_sha: "a".repeat(40),
        GITHUB_REF: ref,
        GITHUB_SHA: sha,
      },
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(status);
  });

  it("exports the verified workflow ref before publishing", () => {
    expect(workflow).toContain("source_ref: ${{ steps.identity.outputs.source_ref }}");
    expect(workflow).toContain('echo "source_ref=$GITHUB_REF" >> "$GITHUB_OUTPUT"');
    expect(workflow.indexOf('if [ "$GITHUB_REF"')).toBeLessThan(
      workflow.indexOf('npm view "$package_name@$version"'),
    );
    expect(workflow).not.toContain("source_ref: ${{ needs.release-preflight.outputs.source_sha }}");
  });

  it("publishes the exact npm tarball through ClawHub", () => {
    expect(workflow).toContain(
      'npm pack "$package_name@$version" --pack-destination "$RUNNER_TEMP/clawhub-release-package"',
    );
    expect(workflow.match(/package\/dist\/index\.js/g)).toHaveLength(2);
    expect(workflow).toMatch(
      /name: Upload exact npm package tarball(?:.|\n)*?name: clawhub-release-package/,
    );
    expect(workflow.match(/package_artifact_name: clawhub-release-package/g)).toHaveLength(2);
    expect(
      workflow.match(
        /tags: \$\{\{ needs\.release-preflight\.outputs\.clawhub_tags \}\}/g,
      ),
    ).toHaveLength(2);
  });

  it("binds manual validation and publication to the verified commit and workflow ref", () => {
    for (const jobName of ["release-dry-run", "publish"]) {
      // Limit assertions to one job so one correct call cannot mask a broken sibling.
      const job = workflow.split(`\n  ${jobName}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
      expect(job).toBeDefined();
      expect(job).toContain("needs: release-preflight");
      expect(job).toContain("source: ${{ github.repository }}");
      expect(job).toContain("\n      ref: ${{ needs.release-preflight.outputs.source_sha }}");
      expect(job).toContain("source_repo: ${{ github.repository }}");
      expect(job).toContain("source_commit: ${{ needs.release-preflight.outputs.source_sha }}");
      expect(job).toContain("source_ref: ${{ needs.release-preflight.outputs.source_ref }}");
    }
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
    expect(releasing).toMatch(/exact published npm\s+tarball/);
  });

  it("dispatches a real ClawHub publish after the npm release completes", () => {
    expect(npmPublishWorkflow).toMatch(
      /permissions:\n(?:.|\n)*?actions: write/,
    );
    expect(npmPublishWorkflow).toContain(
      "actions/workflows/clawhub-publish.yml/dispatches",
    );
    expect(npmPublishWorkflow).toContain(
      "WORKFLOW_REF: v${{ steps.package.outputs.version }}",
    );
    expect(npmPublishWorkflow).toContain(
      'RELEASE_TAG: v${{ steps.package.outputs.version }}',
    );
    expect(npmPublishWorkflow).toContain(
      "RELEASE_CHANNEL: ${{ steps.package.outputs.npm_tag }}",
    );
    expect(npmPublishWorkflow).toContain(
      "inputs: {release_tag: $release_tag, release_channel: $release_channel, dry_run: false}",
    );
    expect(npmPublishWorkflow.indexOf("Create GitHub release")).toBeLessThan(
      npmPublishWorkflow.indexOf("Dispatch ClawHub publish"),
    );
  });

  it("publishes npm releases through the configured OIDC trust", () => {
    expect(npmPublishWorkflow).toContain("id-token: write");
    expect(npmPublishWorkflow).toContain(
      "npm install --global npm@11.19.0",
    );
    expect(npmPublishWorkflow).toContain(
      'npm publish --provenance --tag "${{ steps.package.outputs.npm_tag }}"',
    );
    expect(npmPublishWorkflow).not.toContain("NODE_AUTH_TOKEN");
    expect(npmPublishWorkflow).not.toContain("secrets.NPM_TOKEN");
  });
});
