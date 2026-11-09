/**
 * Unit tests of shared/agent-skills.js: finding the skills, detecting the
 * installed agents, and linking the missing skills into their folders,
 * on a temporary home folder.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmp } = require("./helpers");
const skills = require("../shared/agent-skills");

/**
 * A skills source with two skills, plus folders that must be ignored.
 * @param {import("node:test").TestContext} t Test context.
 * @returns {string} Its path.
 */
function source(t) {
  const root = tmp(t);
  for (const dir of ["session-status", "coding/markdown", "viewer/x", "coding/notaskill", "node_modules/y"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const dir of ["session-status", "coding/markdown", "viewer/x", "node_modules/y"]) {
    fs.writeFileSync(path.join(root, dir, "SKILL.md"), "---\nname: x\n---\n");
  }
  return root;
}

test("findSkills: folders with a SKILL.md, two levels deep, skipping viewer and node_modules", (t) => {
  assert.deepEqual(skills.findSkills(source(t)).map((s) => s.name), ["markdown", "session-status"]);
  assert.deepEqual(skills.findSkills(path.join(tmp(t), "missing")), []);
});

test("plan: installed agents only, with what each lacks", (t) => {
  const root = source(t);
  const home = tmp(t);
  fs.mkdirSync(path.join(home, ".claude", "skills", "session-status"), { recursive: true });
  fs.mkdirSync(path.join(home, ".vibe"));
  const p = skills.plan(root, home);
  assert.deepEqual(p.map((e) => e.agent.id), ["claude", "vibe"], "Codex, Copilot, Gemini not installed");
  const claude = p.find((e) => e.agent.id === "claude");
  assert.deepEqual(claude.missing.map((s) => s.name), ["markdown"]);
  assert.deepEqual(claude.present, ["session-status"]);
  assert.equal(p.find((e) => e.agent.id === "vibe").skillsDir, path.join(home, ".vibe", "skills"));
  assert.deepEqual(skills.missing(root, home).map((e) => e.missing.length), [1, 2]);
  assert.equal(skills.summary(skills.missing(root, home)), "Claude Code (1 skill), Mistral Vibe (2 skills)");
});

test("install: links the missing skills, creates the folder, replaces nothing", (t) => {
  const root = source(t);
  const home = tmp(t);
  fs.mkdirSync(path.join(home, ".vibe"));
  fs.mkdirSync(path.join(home, ".claude", "skills", "markdown"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "skills", "markdown", "mine.md"), "keep");
  for (const e of skills.missing(root, home)) skills.install(e);
  const link = path.join(home, ".vibe", "skills", "session-status");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(root, "session-status")));
  assert.equal(fs.readFileSync(path.join(home, ".claude", "skills", "markdown", "mine.md"), "utf8"), "keep");
  assert.equal(fs.lstatSync(path.join(home, ".claude", "skills", "markdown")).isSymbolicLink(), false);
  assert.deepEqual(skills.missing(root, home), [], "nothing left to add");
});

test("install: reports errors instead of throwing", (t) => {
  const root = source(t);
  const home = tmp(t);
  fs.mkdirSync(path.join(home, ".vibe"));
  fs.writeFileSync(path.join(home, ".vibe", "skills"), "a file where the folder should be");
  const [entry] = skills.missing(root, home);
  const r = skills.install(entry);
  assert.deepEqual(r.added, []);
  assert.equal(r.errors.length, 1);
});
