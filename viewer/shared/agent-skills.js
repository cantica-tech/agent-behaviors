/**
 * Add the agent-behaviors skills to every coding agent installed on this
 * machine, shared by the VS Code extension and the Electron app.
 *
 * A skill is a folder holding a SKILL.md (session-status, coding/docstrings,
 * coding/markdown, coding/toml). Each agent loads skills from its own folder;
 * a skill is added by linking its folder there under its name, so later
 * updates of the source (a new deployment, a git pull) reach every agent.
 * Nothing that already exists in an agent's folder is ever replaced.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Agents with a skills folder: id, display name, the folder whose presence
 * means the agent is installed, and its global skills folder (both relative
 * to the home folder).
 */
const AGENTS = [
  { id: "claude", name: "Claude Code", home: ".claude", skills: ".claude/skills" },
  { id: "copilot", name: "GitHub Copilot", home: ".copilot", skills: ".copilot/skills" },
  { id: "codex", name: "Codex", home: ".codex", skills: ".codex/skills" },
  { id: "gemini", name: "Gemini CLI", home: ".gemini", skills: ".gemini/skills" },
  { id: "vibe", name: "Mistral Vibe", home: ".vibe", skills: ".vibe/skills" },
  { id: "agents", name: "Agent Skills (~/.agents)", home: ".agents", skills: ".agents/skills" },
];
/** Folders never searched for skills. */
const SKIP = new Set(["node_modules", "viewer", ".git", "setup", "test"]);

/**
 * Find the skills under ``root``: folders (up to two levels down) that hold
 * a SKILL.md, named after their folder.
 * @param {string} root Skills source (a deployed <AgentsMonitor>/skills, or the repository).
 * @returns {{name: string, dir: string}[]} Skills, sorted by name.
 */
function findSkills(root) {
  const out = [];
  const walk = (dir, depth) => {
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (!(it.isDirectory() || it.isSymbolicLink()) || it.name.startsWith(".") || SKIP.has(it.name)) continue;
      const full = path.join(dir, it.name);
      if (fs.existsSync(path.join(full, "SKILL.md"))) out.push({ name: it.name, dir: full });
      else if (depth < 1) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * For each installed agent, which skills it lacks.
 * @param {string} root Skills source.
 * @param {string} [home] Home folder.
 * @returns {{agent: object, skillsDir: string, missing: object[], present: string[]}[]}
 *   One entry per installed agent; `present` names the skills it already has
 *   (whatever they point to).
 */
function plan(root, home = os.homedir()) {
  const skills = findSkills(root);
  return AGENTS.filter((a) => fs.existsSync(path.join(home, a.home))).map((agent) => {
    const skillsDir = path.join(home, agent.skills);
    const has = (name) => {
      try {
        fs.lstatSync(path.join(skillsDir, name));
        return true;
      } catch {
        return false;
      }
    };
    return {
      agent,
      skillsDir,
      missing: skills.filter((s) => !has(s.name)),
      present: skills.filter((s) => has(s.name)).map((s) => s.name),
    };
  });
}

/**
 * Link the missing skills into one agent's folder (a junction on Windows,
 * which needs no special rights); never replaces anything.
 * @param {{skillsDir: string, missing: object[]}} entry An entry of plan().
 * @returns {{added: string[], errors: string[]}} What was linked, and what failed.
 */
function install(entry) {
  const added = [];
  const errors = [];
  try {
    fs.mkdirSync(entry.skillsDir, { recursive: true });
  } catch (err) {
    return { added, errors: [`${entry.skillsDir}: ${err.message}`] };
  }
  for (const s of entry.missing) {
    const link = path.join(entry.skillsDir, s.name);
    try {
      fs.symlinkSync(s.dir, link, process.platform === "win32" ? "junction" : "dir");
      added.push(s.name);
    } catch (err) {
      errors.push(`${s.name}: ${err.message}`);
    }
  }
  return { added, errors };
}

/**
 * Plan entries that lack at least one skill.
 * @param {string} root Skills source.
 * @param {string} [home] Home folder.
 * @returns {object[]} Entries of plan() with missing skills.
 */
function missing(root, home) {
  return plan(root, home).filter((e) => e.missing.length);
}

/**
 * One-line summary of what is missing, for an offer to the user.
 * @param {object[]} entries Entries of missing().
 * @returns {string} e.g. "Mistral Vibe (4 skills), Codex (1 skill)".
 */
function summary(entries) {
  return entries.map((e) => `${e.agent.name} (${e.missing.length} skill${e.missing.length === 1 ? "" : "s"})`).join(", ");
}

module.exports = { AGENTS, findSkills, plan, install, missing, summary };
