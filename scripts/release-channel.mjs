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

if (process.argv[2] === "--assert-newer") {
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
