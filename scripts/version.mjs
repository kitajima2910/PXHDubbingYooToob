import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Dem tong so commit, tinh minor tu dong: moi 100 commit = +1 minor
const totalCommits = parseInt(execSync("git rev-list --count HEAD", { encoding: "utf8", cwd: root }).trim(), 10);
const minor = Math.floor((totalCommits - 1) / 100) + 1;
const patch = totalCommits % 100;
const newVersion = `0.${minor}.${patch}`;

// Cap nhat package.json
const pkgPath = resolve(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const oldVersion = pkg.version;
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// Cap nhat manifest.json
const manifestPath = resolve(root, "public", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = newVersion;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const nextMilestone = ((minor) * 100);
console.log(`Version: ${oldVersion} -> ${newVersion} (${totalCommits} commits, next minor at ${nextMilestone} commits -> 0.${minor + 1}.0)`);
