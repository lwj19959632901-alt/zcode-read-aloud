// validate-manifest.mjs — manifest 合法性断言（§十⑤）

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const MANIFEST_PATH = path.join(PLUGIN_ROOT, ".zcode-plugin", "plugin.json");

test("manifest：文件存在且是合法 JSON", () => {
  assert.ok(fs.existsSync(MANIFEST_PATH), "plugin.json 存在");
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.ok(manifest.name, "有 name");
  assert.ok(manifest.version, "有 version");
});

test("manifest：name=read-aloud, version=1.0.0", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.name, "read-aloud");
  assert.equal(manifest.version, "1.0.0");
});

test("manifest：userConfig 四字段齐全", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const uc = manifest.userConfig;
  assert.ok(uc, "有 userConfig");
  for (const key of ["pythonPath", "defaultVoice", "maxChars", "dbPath"]) {
    assert.ok(uc[key], "userConfig 含字段 " + key);
    assert.ok(uc[key].type, "字段 " + key + " 有 type");
    assert.ok(uc[key].title, "字段 " + key + " 有 title");
    assert.ok(uc[key].description, "字段 " + key + " 有 description");
  }
});

test("manifest：mcpServers 有 read-aloud", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.ok(manifest.mcpServers, "有 mcpServers");
  assert.ok(manifest.mcpServers["read-aloud"], "有 read-aloud server");
  const server = manifest.mcpServers["read-aloud"];
  assert.equal(server.type, "stdio");
  assert.equal(server.command, "node");
  assert.ok(server.args.indexOf("${ZCODE_PLUGIN_ROOT}/dist/server.mjs") >= 0, "args 引用 dist/server.mjs");
  assert.ok(server.env.RA_PYTHON_PATH, "env 有 RA_PYTHON_PATH");
  assert.ok(server.env.RA_DEFAULT_VOICE, "env 有 RA_DEFAULT_VOICE");
  assert.ok(server.env.RA_MAX_CHARS, "env 有 RA_MAX_CHARS");
  assert.ok(server.env.RA_DB_PATH, "env 有 RA_DB_PATH");
  assert.ok(server.env.ZCODE_PLUGIN_DATA, "env 有 ZCODE_PLUGIN_DATA");
});

test("manifest：ui.surfaces 引用 read-aloud server", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.ok(manifest.ui.surfaces, "有 ui.surfaces");
  assert.equal(manifest.ui.surfaces.length, 1);
  const surface = manifest.ui.surfaces[0];
  assert.equal(surface.id, "read-aloud");
  assert.equal(surface.server, "read-aloud");
  assert.equal(surface.resourceUri, "ui://read-aloud/panel.html");
  assert.equal(surface.availability, "session");
});

test("manifest：commands/skills 目录存在", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.ok(manifest.commands, "声明 commands");
  assert.ok(manifest.skills, "声明 skills");
  const commandsDir = path.join(PLUGIN_ROOT, manifest.commands);
  const skillsDir = path.join(PLUGIN_ROOT, manifest.skills);
  assert.ok(fs.existsSync(commandsDir), "commands 目录存在");
  assert.ok(fs.existsSync(skillsDir), "skills 目录存在");
  // 具体文件
  assert.ok(fs.existsSync(path.join(commandsDir, "read-aloud-panel.md")), "commands/read-aloud-panel.md 存在");
  assert.ok(fs.existsSync(path.join(skillsDir, "read-aloud-panel", "SKILL.md")), "skills/read-aloud-panel/SKILL.md 存在");
});

test("manifest：dist/server.mjs 存在", () => {
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, "dist", "server.mjs")), "dist/server.mjs 存在");
});

test("manifest：dist/core.mjs 存在", () => {
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, "dist", "core.mjs")), "dist/core.mjs 存在");
});

test("manifest：dist/panel.html 存在", () => {
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, "dist", "panel.html")), "dist/panel.html 存在");
});
