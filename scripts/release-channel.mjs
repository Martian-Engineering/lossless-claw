import { readFileSync } from "node:fs";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BETA_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;

function parseVersion(version) {
  const stable = STABLE_VERSION.exec(version);
  if (stable) {
    return {
      channel: "latest",
      parts: stable.slice(1).map(BigInt),
      prerelease: false,
    };
  }

  const beta = BETA_VERSION.exec(version);
  if (beta) {
    return {
      channel: "beta",
      parts: beta.slice(1).map(BigInt),
      prerelease: true,
    };
  }

  return null;
}

function compareParts(candidate, current) {
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] > current[index]) return 1;
    if (candidate[index] < current[index]) return -1;
  }
  return 0;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function isValidRollback(candidateVersion, rollbackVersion) {
  const candidate = parseVersion(candidateVersion);
  const rollback = parseVersion(rollbackVersion);

  return Boolean(
    candidate &&
      rollback &&
      rollback.channel === "latest" &&
      compareParts(candidate.parts.slice(0, 3), rollback.parts) > 0,
  );
}

if (process.argv[2] === "--read-rollback") {
  const candidateVersion = process.argv[3];
  const lines = readFileSync(0, "utf8").split(/\r?\n/);
  const heading = `## ${candidateVersion}`;
  const headingIndexes = lines.flatMap((line, index) =>
    line === heading ? [index] : [],
  );
  const start = headingIndexes[0];
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## "),
  );
  const section =
    headingIndexes.length === 1
      ? lines.slice(start + 1, end === -1 ? lines.length : end)
      : [];
  const markers = section.flatMap((line) => {
    const match = /^<!-- release-rollback-version: ([^ ]+) -->$/.exec(line);
    return match ? [match[1]] : [];
  });

  if (
    markers.length !== 1 ||
    !isValidRollback(candidateVersion, markers[0])
  ) {
    fail(`Expected exactly one valid rollback marker for ${candidateVersion}`);
  } else {
    process.stdout.write(`${markers[0]}\n`);
  }
} else if (process.argv[2] === "--assert-rollback") {
  const candidateVersion = process.argv[3];
  const rollbackVersion = process.argv[4];

  if (!isValidRollback(candidateVersion, rollbackVersion)) {
    fail(
      `Rollback version ${rollbackVersion} must be a stable version older than ${candidateVersion}`,
    );
  }
} else if (process.argv[2] === "--assert-newer") {
  const candidateVersion = process.argv[3];
  const currentVersion = process.argv[4];
  const candidate = parseVersion(candidateVersion);
  const current = parseVersion(currentVersion);

  if (
    !candidate ||
    !current ||
    candidate.channel !== current.channel ||
    compareParts(candidate.parts, current.parts) <= 0
  ) {
    fail(
      `Release version ${candidateVersion} must be newer than ${currentVersion} on the same channel`,
    );
  }
} else {
  const version = process.argv[2];
  const release = parseVersion(version);

  if (release) {
    process.stdout.write(
      `npm_tag=${release.channel}\nprerelease=${release.prerelease}\n`,
    );
  } else {
    fail(`Unsupported release version: ${version}`);
  }
}
