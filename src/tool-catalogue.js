'use strict';
// The names the policy's tool lists can contain, read from the MCP server that will
// enforce them. Typing a tool name from memory is how a deny list ends up matching
// nothing, so the form offers the real names rather than asking the user to recall them.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

function candidates() {
  return [
    // Installed layout: the manifest sits beside the server entry point.
    path.join(path.dirname(paths.mcpEntry), 'toolManifest.js'),
    // Working copy: the unpacked base package used for building and testing.
    path.resolve(__dirname, '..', 'build', 'base-payload', 'app', 'vendor', 'node_modules', 'abap-adt-mcp', 'dist', 'toolManifest.js'),
  ];
}

let cached;
/**
 * Every tool the server can expose, with the toolset it belongs to and whether it can
 * change anything. Returns an empty catalogue rather than throwing when the manifest is
 * not there, so the form simply offers no suggestions instead of failing to open.
 */
function catalogue() {
  if (cached) return cached;
  for (const file of candidates()) {
    if (!fs.existsSync(file)) continue;
    try {
      const manifest = require(file);
      const toolsetOf = new Map();
      for (const [toolset, definition] of Object.entries(manifest.TOOLSETS || {})) {
        for (const handler of definition.handlers || []) {
          for (const tool of (manifest.TOOL_ROUTES || {})[handler] || []) toolsetOf.set(tool, toolset);
        }
      }
      if (!toolsetOf.size) continue;
      const readOnly = manifest.READ_ONLY_TOOLS instanceof Set ? manifest.READ_ONLY_TOOLS : new Set();
      cached = {
        tools: [...toolsetOf.keys()].sort().map(name => ({ name, toolset: toolsetOf.get(name) || '', writes: !readOnly.has(name) })),
        toolsets: [...new Set(toolsetOf.values())].sort(),
      };
      return cached;
    } catch (_) {
      // A manifest we cannot read is the same as one that is not there.
    }
  }
  cached = { tools: [], toolsets: [] };
  return cached;
}

module.exports = { catalogue };
