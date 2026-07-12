const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BETA_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;

const version = process.argv[2];

if (STABLE_VERSION.test(version)) {
  process.stdout.write("npm_tag=latest\nprerelease=false\n");
} else if (BETA_VERSION.test(version)) {
  process.stdout.write("npm_tag=beta\nprerelease=true\n");
} else {
  process.stderr.write(`Unsupported release version: ${version}\n`);
  process.exitCode = 1;
}
