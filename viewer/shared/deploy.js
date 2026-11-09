/**
 * Deploy the agent-behaviors skills into the AgentsMonitor folder, shared by
 * the VS Code extension and the Electron app.
 *
 * <AgentsMonitor>/                      (default ~/.agent-behaviors)
 *   README.md                           technical README: viewers and skills architecture
 *   skills/
 *     README.md                         generated skills registry, read by agents (and
 *                                       printed by the Claude Code start-up hook) so they
 *                                       register the skills; nothing else
 *     LICENSE
 *     coding/ ...  session-status/ ...  the skills themselves
 *     .cantica-agent-status-version     version that deployed them
 *
 * Copies once per version, overwriting the files it ships and keeping any
 * others. A skills folder that is a link (e.g. to a checkout of
 * agent-behaviors) is never written to.
 */

const fs = require("fs");
const path = require("path");

/** Marker file in <AgentsMonitor>/skills holding the version that deployed it. */
const DEPLOY_MARKER = ".cantica-agent-status-version";
/** Folders never searched for skills. */
const SKIP = new Set(["node_modules", ".git"]);

/**
 * Read a SKILL.md's front matter fields ``name`` and ``description``.
 * @param {string} file Path of a SKILL.md.
 * @returns {{name: string|null, description: string}} Fields (description "" when absent).
 */
function frontMatter(file) {
  const out = { name: null, description: "" };
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * The skills under ``root``: folders (two levels down at most) holding a SKILL.md.
 * @param {string} root A deployed skills folder.
 * @returns {{name: string, description: string, file: string, dir: string}[]} Sorted by name.
 */
function listSkills(root) {
  const out = [];
  const walk = (dir, depth) => {
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (!it.isDirectory() || it.name.startsWith(".") || SKIP.has(it.name)) continue;
      const full = path.join(dir, it.name);
      const file = path.join(full, "SKILL.md");
      if (fs.existsSync(file)) {
        const fm = frontMatter(file);
        out.push({ name: fm.name || it.name, description: fm.description, file, dir: full });
      } else if (depth < 1) {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The skills registry written to <AgentsMonitor>/skills/README.md: what an
 * agent needs to register the skills, and nothing else.
 * @param {string} skillsDir The deployed skills folder (absolute).
 * @returns {string} Markdown.
 */
function skillsReadme(skillsDir) {
  const skills = listSkills(skillsDir);
  const rows = skills.map((s) => `- **${s.name}**: ${s.description}\n  Follow \`${s.file}\` when this applies.`);
  return `# Agent skills

These skills are for every coding agent on this machine (Claude Code,
GitHub Copilot, Codex, Gemini CLI, Mistral Vibe, and others). Register each
one: load it as a skill if your agent loads skill folders, otherwise follow
its \`SKILL.md\` whenever its description applies.

${rows.join("\n")}

Run a skill's scripts with their interpreter, from this folder, e.g.
\`python3 ${path.join(skillsDir, "session-status", "scripts", "board.py")} …\`.
Never run anything else stored under \`${path.dirname(skillsDir)}\`.
`;
}

/**
 * Deploy into <folder>: the skill folders and LICENSE under skills/, the
 * generated skills README, and the technical README at the folder's root.
 * @param {object} opts What to deploy.
 * @param {string} opts.folder AgentsMonitor folder (absolute).
 * @param {string} opts.version Version deploying (decides whether to copy again).
 * @param {{name: string, from: string}[]} opts.skills Skill folders to copy, by name under skills/.
 * @param {string} opts.license LICENSE file to copy into skills/.
 * @param {string} opts.architecture Technical README copied to <folder>/README.md.
 * @returns {{status: "deployed"|"current"|"linked"|"error", target: string, error?: string}} The outcome.
 */
function deploy(opts) {
  const target = path.join(opts.folder, "skills");
  try {
    for (const s of opts.skills) if (!fs.existsSync(s.from)) return { status: "error", target, error: `missing ${s.from}` };
    fs.mkdirSync(opts.folder, { recursive: true });
    let linked = false;
    try {
      linked = fs.lstatSync(target).isSymbolicLink();
    } catch {
      /* not there yet */
    }
    const marker = path.join(target, DEPLOY_MARKER);
    const current = !linked && fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === opts.version;
    if (current) return { status: "current", target };
    if (opts.architecture && fs.existsSync(opts.architecture)) {
      fs.copyFileSync(opts.architecture, path.join(opts.folder, "README.md"));
    }
    if (linked) return { status: "linked", target };
    fs.mkdirSync(target, { recursive: true });
    for (const s of opts.skills) {
      fs.cpSync(s.from, path.join(target, s.name), {
        recursive: true,
        force: true,
        filter: (src) => !src.includes(`${path.sep}__pycache__`) && !src.endsWith(".pyc") && !src.endsWith(".DS_Store"),
      });
    }
    if (opts.license && fs.existsSync(opts.license)) fs.copyFileSync(opts.license, path.join(target, "LICENSE"));
    fs.writeFileSync(path.join(target, "README.md"), skillsReadme(target));
    fs.writeFileSync(marker, `${opts.version}\n`);
    return { status: "deployed", target };
  } catch (err) {
    return { status: "error", target, error: err.message };
  }
}

module.exports = { DEPLOY_MARKER, frontMatter, listSkills, skillsReadme, deploy };
