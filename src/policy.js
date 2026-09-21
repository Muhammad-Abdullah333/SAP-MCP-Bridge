'use strict';
// Safety policy shaping for the manager. The policy stored here is handed to the bundled
// MCP server, which enforces it before a tool call reaches SAP. Everything this module
// accepts must correspond to a gate the server actually applies; anything it cannot
// enforce belongs in warnings(), not in a field that quietly does nothing.

/**
 * The three levels are about one question: what may be changed. They map onto the two
 * gates the server enforces, readOnly and customOnly.
 */
const LEVELS = [
  {
    level: 0,
    readOnly: true,
    customOnly: false,
    name: 'Read only',
    detail: 'Nothing can be changed. Standard and custom objects can both be read.',
  },
  {
    level: 1,
    readOnly: false,
    customOnly: true,
    name: 'Custom can be changed, standard is read only',
    detail: 'Standard programs, classes, packages and tables can be read but not changed. Changes are confined to the customer namespace: Z*, Y*, $* and /namespace/ packages. Choosing this also denies the debugger, abapGit and running ABAP snippets or classes; they are listed under Fine-tune with lists, where they can be removed.',
  },
  {
    level: 2,
    readOnly: false,
    customOnly: false,
    name: 'Standard and custom can both be changed',
    detail: 'Changes are allowed anywhere this SAP account is authorised, standard objects included.',
  },
];

/**
 * The reading question. "Ad-hoc SQL" is the engine's own name for it and means nothing to
 * anyone else, so the choices describe what actually differs: naming a table, versus
 * composing a statement. The second matters for more than reach — when a table is named
 * outright the table lists match it exactly, where a query has to be parsed out of text.
 */
const READ_LEVELS = [
  {
    level: 0,
    allowFreeSql: false,
    name: 'Tables only, no SQL of its own',
    detail: 'It can open a table you name, one at a time. Because the table is named outright, the table lists below match it exactly.',
  },
  {
    level: 1,
    allowFreeSql: true,
    name: 'Tables, and its own SQL queries',
    detail: 'It can also write SQL that joins and filters across tables in one request. Table lists still apply, but they have to be read out of the query text.',
  },
];

/**
 * Risk is scored from the whole policy, not from the level alone, so the reading moves as
 * lists are tightened or opened up. Each dimension contributes what it leaves unguarded.
 *
 *   change scope   0 read only | 4 custom only | 8 standard writable
 *   own SQL        2 when the connection may compose its own SQL
 *   tables         1 when no table list narrows what can be read
 *   tools          1 when no tool list narrows what can be called
 *   transports     1 when changes are possible under any transport
 *
 * The level anchors sit at 0, 4 and 8, which is exactly what the change scope contributes,
 * so a level reads off the scale directly and everything else moves the rating within it.
 */
const RISK_WEIGHTS = { scope: [0, 4, 8], sql: 2, tables: 1, tools: 1, transports: 1 };
const RISK_MAX = RISK_WEIGHTS.scope[2] + RISK_WEIGHTS.sql + RISK_WEIGHTS.tables + RISK_WEIGHTS.tools + RISK_WEIGHTS.transports;
// Three ratings, and the chosen level is a floor under them. Without the floor a
// connection that may change standard objects could report less than High just because
// its lists happen to be tight, which reads as safer than it is. Lists can raise the
// rating above the floor; nothing can take it below.
const RISKS = [
  { upTo: 3, name: 'Low', tone: 'safe' },
  { upTo: 8, name: 'Medium', tone: 'caution' },
  { upTo: RISK_MAX, name: 'High', tone: 'danger' },
];

const LIST_FIELDS = ['allowedPackages', 'allowedTables', 'allowedTools', 'allowedTransports', 'deniedTables', 'deniedTools'];
const MAX_ENTRIES = 200;
const MAX_PATTERN = 64;
// Wildcards are the engine's globs: * for any run, ? for one character. Not full regex,
// so the form must not imply otherwise.
const SHAPES = {
  allowedPackages: /^[A-Za-z0-9_$*?/-]+$/,
  allowedTables: /^[A-Za-z0-9_*?/-]+$/,
  allowedTransports: /^[A-Za-z0-9_*?-]+$/,
  deniedTables: /^[A-Za-z0-9_*?/-]+$/,
  allowedTools: /^(toolset:)?[A-Za-z0-9_*?-]+$/,
  deniedTools: /^(toolset:)?[A-Za-z0-9_*?-]+$/,
};
const LABELS = {
  allowedPackages: 'Allowed packages',
  allowedTables: 'Allowed tables',
  allowedTools: 'Allowed tools',
  allowedTransports: 'Allowed transports',
  deniedTables: 'Denied tables',
  deniedTools: 'Denied tools',
};
/** Customer namespace, as the server judges it. */
const CUSTOM_PREFIX = /^[ZY$/]/i;

/** One entry per line; commas and semicolons still work, so older policies survive. */
function parseList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,;\r\n]+/);
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const text = String(entry).trim();
    if (!text) continue;
    const key = text.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * A list of nothing but asterisks matches everything, so it restricts nothing. An empty
 * list is the same. Saying so out loud matters: a form showing "Allowed tables: *" looks
 * configured while permitting every table.
 */
function isOpenList(entries) {
  const list = entries || [];
  return list.length === 0 || list.some(entry => /^\*+$/.test(entry));
}

/** Does this package list already confine changes to the customer namespace? */
function restrictsToCustom(entries) {
  const list = entries || [];
  return list.length > 0 && !isOpenList(list) && list.every(entry => CUSTOM_PREFIX.test(entry));
}

function checkList(field, entries) {
  if (entries.length > MAX_ENTRIES) throw new Error(`${LABELS[field]}: keep the list to ${MAX_ENTRIES} entries or fewer.`);
  for (const entry of entries) {
    if (entry.length > MAX_PATTERN) throw new Error(`${LABELS[field]}: "${entry.slice(0, 20)}…" is too long; keep each entry under ${MAX_PATTERN} characters.`);
    if (!SHAPES[field].test(entry)) {
      throw new Error(
        field === 'allowedTools' || field === 'deniedTools'
          ? `${LABELS[field]}: "${entry}" is not a tool name. Use a tool name, a wildcard such as transport*, or toolset:<name>.`
          : `${LABELS[field]}: "${entry}" is not a valid name. Use letters, digits, _ - / $ and the wildcards * and ?.`,
      );
    }
  }
  return entries;
}

/**
 * Where the policy actually stands, which is not always what was picked. An
 * allowed-packages list of Z* confines changes to the customer namespace whatever the
 * choice says, so the reading has to come from the whole policy rather than one field.
 */
function levelOf(policy = {}) {
  if (policy.readOnly) return 0;
  if (policy.customOnly || restrictsToCustom(policy.allowedPackages)) return 1;
  return 2;
}

/** What each dimension of this policy leaves unguarded, itemised. */
function riskParts(policy = {}) {
  const level = levelOf(policy);
  const writable = level > 0;
  const openTables = isOpenList(policy.allowedTables) && !(policy.deniedTables || []).length;
  const openTools = isOpenList(policy.allowedTools) && !(policy.deniedTools || []).length;
  return [
    { key: 'scope', points: RISK_WEIGHTS.scope[level], of: RISK_WEIGHTS.scope[2], label: LEVELS[level].name },
    { key: 'sql', points: policy.allowFreeSql === false ? 0 : RISK_WEIGHTS.sql, of: RISK_WEIGHTS.sql, label: 'SQL the connection writes itself' },
    { key: 'tables', points: openTables ? RISK_WEIGHTS.tables : 0, of: RISK_WEIGHTS.tables, label: 'unrestricted table access' },
    { key: 'tools', points: openTools ? RISK_WEIGHTS.tools : 0, of: RISK_WEIGHTS.tools, label: 'unrestricted tool access' },
    { key: 'transports', points: writable && isOpenList(policy.allowedTransports) ? RISK_WEIGHTS.transports : 0, of: RISK_WEIGHTS.transports, label: 'changes under any transport' },
  ];
}

/** The score behind the rating, from 0 to RISK_MAX. */
function riskOf(policy = {}) {
  return riskParts(policy).reduce((total, part) => total + part.points, 0);
}

function ratingOf(score, level = 0) {
  const banded = RISKS.findIndex(r => score <= r.upTo);
  return RISKS[Math.max(level, banded < 0 ? RISKS.length - 1 : banded)];
}

/**
 * Build the stored policy. `input.level` drives readOnly and customOnly together; an
 * input that sets those directly (a legacy record, or an imported backup) still works.
 */
function normalise(input = {}, previous = {}) {
  const base = { ...previous, ...input };
  const policy = {};
  if (input.level !== undefined) {
    const chosen = LEVELS.find(l => l.level === Number(input.level));
    if (!chosen) throw new Error('Choose a safety level between 0 and 2.');
    policy.readOnly = chosen.readOnly;
    policy.customOnly = chosen.customOnly;
  } else {
    policy.readOnly = Boolean(base.readOnly);
    policy.customOnly = Boolean(base.customOnly);
  }
  if (input.readLevel !== undefined) {
    const chosen = READ_LEVELS.find(l => l.level === Number(input.readLevel));
    if (!chosen) throw new Error('Choose what this connection may read.');
    policy.allowFreeSql = chosen.allowFreeSql;
  } else {
    policy.allowFreeSql = base.allowFreeSql !== false;
  }
  for (const field of LIST_FIELDS) policy[field] = checkList(field, parseList(base[field]));
  return policy;
}

/** Level, risk score, rating and the wording the form shows, all from one place. */
function describe(policy = {}) {
  const level = levelOf(policy);
  const risk = riskOf(policy);
  const rating = ratingOf(risk, level);
  const parts = riskParts(policy);
  const notes = [];
  if (!policy.readOnly && !policy.customOnly && restrictsToCustom(policy.allowedPackages)) {
    notes.push('Allowed packages already confines changes to the customer namespace, so this connection sits at the middle choice whatever is picked above. Clear that list, or add a standard package to it, to move higher.');
  }
  // Name what is actually adding to the score, so the number is never just a number.
  const adding = parts.filter(part => part.points > 0 && part.key !== 'scope').map(part => part.label);
  if (adding.length) notes.push('Adding to the rating beyond the level itself: ' + adding.join(', ') + '. Narrowing those lists, or letting it read named tables only, lowers it.');
  for (const field of ['allowedPackages', 'allowedTables', 'allowedTools', 'allowedTransports']) {
    const list = policy[field] || [];
    if (list.length && isOpenList(list)) notes.push(`${LABELS[field]} contains only *, which matches everything. That list is restricting nothing.`);
  }
  return {
    level,
    risk,
    max: RISK_MAX,
    // The form renders its choices from these, so the wording lives in one place.
    levels: LEVELS.map(({ level: value, name, detail }) => ({ level: value, name, detail })),
    readLevel: policy.allowFreeSql === false ? 0 : 1,
    readLevels: READ_LEVELS.map(({ level: value, name, detail }) => ({ level: value, name, detail })),
    name: LEVELS[level].name,
    detail: LEVELS[level].detail,
    rating: rating.name,
    tone: rating.tone,
    parts,
    notes,
  };
}

/**
 * What the package gate never weighs: toolsets whose tools act on something other than
 * an object, and tools that run code. Found by running every write tool of the shipped
 * server through its engine with a standard target; these are the groups that matter.
 */
const UNGATED_GROUPS = [
  { toolset: 'transports', label: 'transport control' },
  { toolset: 'debugger', label: 'the debugger' },
  { toolset: 'git', label: 'abapGit' },
  { toolset: 'atc', label: 'ATC exemptions' },
  // Code the AI writes and then runs acts with the SAP account's own authorisations, so
  // no namespace check can bound what it does once it runs. These share their toolsets
  // with tools that are needed (syntax check sits beside runSnippet), so they are named.
  {
    label: 'running ABAP it writes',
    tools: [
      { name: 'runSnippet', toolset: 'analysis' },
      { name: 'runClass', toolset: 'analysis' },
      { name: 'unitTestRun', toolset: 'tests' },
    ],
  },
];

/** The engine's glob: * for any run, ? for one character, case-insensitive. */
function globMatch(pattern, value) {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + source + '$', 'i').test(value);
}

/** The engine's tool-list test: a tool name, or toolset:<name> against the tool's toolset. */
function toolMatches(patterns, tool, toolset) {
  return (patterns || []).some(pattern => {
    const named = /^toolset:(.+)$/i.exec(pattern.trim());
    return named ? Boolean(toolset) && globMatch(named[1], toolset) : globMatch(pattern, tool);
  });
}

/** Would the tool lists let this tool through? The same two gates the engine applies. */
function toolPermitted(policy, tool, toolset) {
  if ((policy.allowedTools || []).length && !toolMatches(policy.allowedTools, tool, toolset)) return false;
  return !toolMatches(policy.deniedTools, tool, toolset);
}

/**
 * The ungated groups that this policy's tool lists still let through. Without a
 * catalogue the tool names are unknown, so a group only counts as closed when it is
 * denied as a whole: over-warning is the safe mistake here, under-warning is not.
 */
function reachableUngated(policy, catalogue) {
  const tools = catalogue?.tools || [];
  const open = [];
  for (const group of UNGATED_GROUPS) {
    if (group.tools) {
      // Named tools: what closes them is the names still let through.
      const still = group.tools.filter(tool => toolPermitted(policy, tool.name, tool.toolset));
      if (still.length) open.push({ label: group.label, close: still.map(tool => tool.name) });
      continue;
    }
    const members = tools.filter(tool => tool.toolset === group.toolset && tool.writes);
    const reachable = members.length
      ? members.some(tool => toolPermitted(policy, tool.name, group.toolset))
      : !toolMatches(policy.deniedTools, '', group.toolset);
    if (reachable) open.push({ label: group.label, close: ['toolset:' + group.toolset] });
  }
  return open;
}

/**
 * Limitations of the policy as configured. These are real gaps, not style notes: the
 * manager shows them next to the form and records them in Logs, because a control the
 * user believes in but that does not hold is worse than no control at all.
 */
function warnings(policy = {}, catalogue = require('./tool-catalogue').catalogue()) {
  const out = [];
  const scoped = policy.customOnly || (policy.allowedPackages || []).length;
  const restricted = policy.readOnly || scoped || (policy.allowedTools || []).length ||
    (policy.deniedTools || []).length || (policy.allowedTables || []).length ||
    (policy.deniedTables || []).length || (policy.allowedTransports || []).length ||
    policy.allowFreeSql === false;

  if (!restricted) {
    out.push('No safety policy is set for this connection. An MCP client can change anything this SAP account is allowed to change, in any package.');
  }
  if (!policy.readOnly && scoped) {
    out.push('Package limits apply to changes, not to reading. Everything this SAP account can see can still be read, including standard objects and their source.');
    // Measured against the shipped engine rather than assumed: the package gate decides
    // on the package of a target object, so tools that act on something other than an
    // object are never weighed against it. Naming them is the difference between a limit
    // the user understands and one they only believe in. Only the groups the tool lists
    // still let through are named, so closing them makes the warning go away.
    const open = reachableUngated(policy, catalogue);
    if (open.length) {
      const names = open.map(group => group.label);
      const spoken = names.length > 1 ? names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1] : names[0];
      out.push(`The namespace limit covers objects: source, classes, tables and packages. It does not cover ${spoken}, which ${open.length > 1 ? 'stay' : 'stays'} available whatever namespace ${open.length > 1 ? 'they touch' : 'it touches'}. Add ${open.flatMap(group => group.close).join(', ')} to Denied tools to close ${open.length > 1 ? 'them' : 'it'}.`);
    }
  }
  if ((policy.deniedTables || []).length && policy.allowFreeSql !== false) {
    out.push('Because this connection may write its own SQL, denied tables are matched by reading the query text. SQL built at runtime inside ABAP source may not be recognised. Letting it read named tables only closes that path.');
  }
  if ((policy.allowedTables || []).length && policy.readOnly !== true && policy.allowFreeSql !== false) {
    out.push('Allowed tables covers table reads and queries. Code that a write tool sends to SAP is scanned on a best-effort basis only.');
  }
  if (policy.customOnly && (policy.allowedPackages || []).length) {
    out.push('Custom-only and allowed packages are both applied: a package has to satisfy both before a change is permitted.');
  }
  // Nothing is added unconditionally: a warning that always shows is wallpaper, and this
  // one duplicated the note printed under the form.
  return out;
}

module.exports = { LEVELS, READ_LEVELS, RISKS, RISK_MAX, UNGATED_GROUPS, toolPermitted, reachableUngated, RISK_WEIGHTS, LIST_FIELDS, LABELS, parseList, isOpenList, restrictsToCustom, normalise, describe, warnings, levelOf, riskOf, riskParts, ratingOf };
