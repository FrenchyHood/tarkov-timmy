// Publishes the installer built by `electron-builder --publish never` as ONE GitHub release with all files,
// then checks they all arrived. (electron-builder's own publisher uploads in parallel and can split files
// across duplicate draft releases.) Needs the GitHub CLI signed in. Release notes come from release-notes.md.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const { owner, repo } = pkg.build.publish[0];
const version = pkg.version;
const tag = `v${version}`;
const dist = new URL("../dist/", import.meta.url);
const files = [`Tarkov-Timmy-Setup-${version}.exe`, `Tarkov-Timmy-Setup-${version}.exe.blockmap`, "latest.yml"];

for (const f of files) {
  if (!existsSync(new URL(f, dist))) throw new Error(`missing dist/${f}; run the build first`);
}
const notes = new URL("../release-notes.md", import.meta.url);
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

gh("release", "create", tag, ...files.map((f) => fileURLToPath(new URL(f, dist))),
  "--repo", `${owner}/${repo}`, "--title", `Tarkov Timmy ${version}`, "--latest",
  ...(existsSync(notes) ? ["--notes-file", fileURLToPath(notes)] : ["--generate-notes"]));

const assets = JSON.parse(gh("release", "view", tag, "--repo", `${owner}/${repo}`, "--json", "assets,isDraft"));
const missing = files.filter((f) => !assets.assets.some((a) => a.name === f));
if (assets.isDraft || missing.length) throw new Error(`release ${tag} incomplete: draft=${assets.isDraft} missing=${missing.join(", ")}`);
console.log(`Published ${tag} with ${files.join(", ")}`);
