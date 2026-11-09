/**
 * Unit tests of shared/deploy.js: deploying the skills into the
 * AgentsMonitor folder, the generated skills README (the registry agents
 * read) and the technical README, on temporary folders.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmp } = require("./helpers");
const d = require("../shared/deploy");

/**
 * A source with two skills, a LICENSE and an architecture README.
 * @param {import("node:test").TestContext} t Test context.
 * @returns {object} deploy() options without folder and version.
 */
function source(t) {
  const root = tmp(t);
  const skill = (dir, name, description) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  };
  skill("session-status", "session-status", "Publish your status.");
  skill("coding/markdown", "markdown", "Lint Markdown with mado.");
  fs.mkdirSync(path.join(root, "session-status", "scripts", "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(root, "session-status", "scripts", "board.py"), "print(1)");
  fs.writeFileSync(path.join(root, "session-status", "scripts", "__pycache__", "board.pyc"), "x");
  fs.writeFileSync(path.join(root, "LICENSE"), "Apache License");
  fs.writeFileSync(path.join(root, "architecture.md"), "# Architecture\n");
  return {
    skills: [{ name: "coding", from: path.join(root, "coding") }, { name: "session-status", from: path.join(root, "session-status") }],
    license: path.join(root, "LICENSE"),
    architecture: path.join(root, "architecture.md"),
  };
}

test("frontMatter reads name and description; tolerates missing files and front matter", (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "a.md"), "---\nname: 'x'\ndescription: \"does y\"\nother: z\n---\nbody");
  assert.deepEqual(d.frontMatter(path.join(dir, "a.md")), { name: "x", description: "does y" });
  fs.writeFileSync(path.join(dir, "b.md"), "# no front matter");
  assert.deepEqual(d.frontMatter(path.join(dir, "b.md")), { name: null, description: "" });
  assert.deepEqual(d.frontMatter(path.join(dir, "missing.md")), { name: null, description: "" });
});

test("deploy: skills, LICENSE, generated skills README, technical README, marker", (t) => {
  const folder = path.join(tmp(t), "monitor");
  const r = d.deploy({ folder, version: "1.0.0", ...source(t) });
  assert.equal(r.status, "deployed");
  const skills = path.join(folder, "skills");
  assert.ok(fs.existsSync(path.join(skills, "coding", "markdown", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(skills, "session-status", "scripts", "board.py")));
  assert.equal(fs.existsSync(path.join(skills, "session-status", "scripts", "__pycache__")), false, "caches not deployed");
  assert.equal(fs.readFileSync(path.join(skills, "LICENSE"), "utf8"), "Apache License");
  assert.equal(fs.readFileSync(path.join(folder, "README.md"), "utf8"), "# Architecture\n", "technical README at the root");
  assert.equal(fs.readFileSync(path.join(skills, d.DEPLOY_MARKER), "utf8").trim(), "1.0.0");
  const readme = fs.readFileSync(path.join(skills, "README.md"), "utf8");
  assert.match(readme, /^# Agent skills/);
  assert.match(readme, /- \*\*markdown\*\*: Lint Markdown with mado\.\n {2}Follow `.*coding\/markdown\/SKILL\.md` when this applies\./);
  assert.match(readme, /- \*\*session-status\*\*: Publish your status\./);
  assert.ok(readme.indexOf("markdown") < readme.indexOf("session-status"), "sorted by name");
  assert.match(readme, new RegExp(`python3 ${path.join(skills, "session-status", "scripts", "board.py").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
  assert.match(readme, /Never run anything else stored under/);
});

test("deploy: once per version; a new version overwrites shipped files and keeps others", (t) => {
  const folder = path.join(tmp(t), "monitor");
  const src = source(t);
  d.deploy({ folder, version: "1.0.0", ...src });
  const readme = path.join(folder, "skills", "README.md");
  fs.writeFileSync(readme, "edited");
  fs.writeFileSync(path.join(folder, "skills", "mine.txt"), "keep");
  assert.equal(d.deploy({ folder, version: "1.0.0", ...src }).status, "current");
  assert.equal(fs.readFileSync(readme, "utf8"), "edited", "same version: untouched");
  assert.equal(d.deploy({ folder, version: "1.1.0", ...src }).status, "deployed");
  assert.match(fs.readFileSync(readme, "utf8"), /^# Agent skills/, "regenerated");
  assert.equal(fs.readFileSync(path.join(folder, "skills", "mine.txt"), "utf8"), "keep");
});

test("deploy: a skills folder that is a link is never written to (the technical README still is)", (t) => {
  const folder = path.join(tmp(t), "monitor");
  const checkout = tmp(t);
  fs.writeFileSync(path.join(checkout, "README.md"), "the repository README");
  fs.mkdirSync(folder);
  fs.symlinkSync(checkout, path.join(folder, "skills"));
  const r = d.deploy({ folder, version: "1.0.0", ...source(t) });
  assert.equal(r.status, "linked");
  assert.equal(fs.readFileSync(path.join(checkout, "README.md"), "utf8"), "the repository README");
  assert.deepEqual(fs.readdirSync(checkout), ["README.md"]);
  assert.equal(fs.readFileSync(path.join(folder, "README.md"), "utf8"), "# Architecture\n");
});

test("deploy: a missing skill source is an error, nothing copied", (t) => {
  const folder = path.join(tmp(t), "monitor");
  const src = source(t);
  src.skills.push({ name: "gone", from: path.join(folder, "nope") });
  const r = d.deploy({ folder, version: "1.0.0", ...src });
  assert.equal(r.status, "error");
  assert.match(r.error, /missing/);
  assert.equal(fs.existsSync(path.join(folder, "skills")), false);
});
