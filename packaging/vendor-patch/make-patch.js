'use strict';
// Builds packaging/vendor-patch/... from the pinned upstream policy.js.
// Three functions are replaced: parsePolicy (new fields), tablesInSql (quoted identifiers)
// and evaluatePolicy (allowedTools, allowedTables, customOnly, runClass, activation cap).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPSTREAM = 'build/base-payload/app/vendor/node_modules/abap-adt-mcp/dist/lib/policy.js';
const OUT_DIR = 'packaging/vendor-patch/node_modules/abap-adt-mcp/dist/lib';
const REL = 'node_modules/abap-adt-mcp/dist/lib/policy.js';

const source = fs.readFileSync(UPSTREAM, 'utf8');
const upstreamHash = crypto.createHash('sha256').update(fs.readFileSync(UPSTREAM)).digest('hex');
let text = source;

function replace(from, to, label) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(label + ': matched ' + n + ' times, expected 1');
  text = text.replace(from, to);
  console.log('  patched: ' + label);
}

// ---------------------------------------------------------------- parsePolicy
replace(
  `        allowedTransports: list(raw.allowedTransports),
    };`,
  `        allowedTransports: list(raw.allowedTransports),
        allowedTables: list(raw.allowedTables),
        allowedTools: list(raw.allowedTools),
        customOnly: bool(raw.customOnly),
    };`,
  'parsePolicy accepts allowedTables, allowedTools, customOnly',
);

// ---------------------------------------------------------------- tablesInSql
replace(
  `function tablesInSql(sql) {
    const names = new Set();
    const re = /\\b(?:from|join)\\s+([A-Za-z_/][\\w/]*)/gi;
    let m;
    while ((m = re.exec(String(sql || ''))))
        names.add(m[1].toUpperCase());
    return [...names];
}`,
  `function tablesInSql(sql) {
    const names = new Set();
    // Bridge patch: the upstream pattern only matched a bare identifier, so a quoted
    // name such as SELECT * FROM "USR02" referenced no table at all and slipped past
    // deniedTables. Quoted, bracketed and backquoted forms are all recognised now.
    const re = /\\b(?:from|join)\\s+(?:"([^"]+)"|'([^']+)'|\`([^\`]+)\`|\\[([^\\]]+)\\]|([A-Za-z_/][\\w/]*))/gi;
    let m;
    while ((m = re.exec(String(sql || '')))) {
        const name = m[1] || m[2] || m[3] || m[4] || m[5];
        if (name)
            names.add(String(name).trim().toUpperCase());
    }
    return [...names];
}`,
  'tablesInSql understands quoted identifiers',
);

// ------------------------------------------------------------- evaluatePolicy
const marker = '\nconst REFACTORING_EXECUTE_TOOLS';
const start = text.indexOf('/**\n * Decide whether `toolName(args)` may run');
const end = text.indexOf(marker);
if (start < 0 || end < 0 || end < start) throw new Error('could not locate evaluatePolicy');

const replacement = `/** Customer namespace: Z*, Y*, $* (local) and /NAMESPACE/ packages. */
const CUSTOM_PACKAGE_PATTERNS = ['Z*', 'Y*', '$*', '/*/*'];
/** Session and health tools that must stay reachable, or nothing can connect at all. */
const SESSION_ALWAYS = new Set(['login', 'logout', 'dropSession', 'listSystems', 'healthcheck', 'systemProfile']);
/** Tools whose whole purpose is reading table data: closed allowedTables applies to them. */
const TABLE_ACCESS_TOOLS = new Set(['tableContents', 'runQuery']);
/** Upstream checked only the first 50 objects of an activation and allowed the rest.
 *  Bridge patch: every object is checked, and an oversized batch is refused rather
 *  than partially checked. */
const MAX_ACTIVATION_OBJECTS = 200;

/**
 * Decide whether \`toolName(args)\` may run on a destination with \`policy\`.
 * Gates run in order: readOnly, allowedTools, deniedTools, allowFreeSql,
 * deniedTables, allowedTables, package gates (allowedPackages and customOnly,
 * both closed: unknown package => denied), allowedTransports.
 */
async function evaluatePolicy(policy, toolName, args, ctx) {
    if (!policy)
        return { allowed: true };
    const a = args || {};
    const deny = (gate, reason) => ({ allowed: false, gate, reason });

    if (policy.readOnly && !toolManifest_js_1.READ_ONLY_TOOLS.has(toolName) && !ALWAYS_ALLOWED.has(toolName)) {
        return deny('readOnly', \`\${toolName} is a write tool and the destination is readOnly\`);
    }
    // Closed allow-list of tools. Session and health tools stay reachable so the
    // connection can still be established and diagnosed.
    if (policy.allowedTools && policy.allowedTools.length && !SESSION_ALWAYS.has(toolName)
        && !deniedToolMatches(policy.allowedTools, toolName)) {
        return deny('allowedTools', \`\${toolName} is not in allowedTools (\${policy.allowedTools.join(', ')})\`);
    }
    if (deniedToolMatches(policy.deniedTools, toolName)) {
        return deny('deniedTools', \`\${toolName} is listed in deniedTools\`);
    }
    if (policy.allowFreeSql === false) {
        if (toolName === 'runQuery')
            return deny('allowFreeSql', 'free SQL (runQuery) is disabled; use tableContents on an allowed table');
        if (toolName === 'tableContents' && a.sqlQuery)
            return deny('allowFreeSql', 'tableContents with sqlQuery counts as free SQL, which is disabled');
    }

    const referencedTables = () => {
        const tables = [];
        if (toolName === 'tableContents' && a.ddicEntityName)
            tables.push(String(a.ddicEntityName).toUpperCase());
        if (a.sqlQuery)
            tables.push(...tablesInSql(String(a.sqlQuery)));
        // Best effort on code about to run or be written: SELECT/JOIN targets in the ABAP text.
        if (toolName === 'runSnippet' && a.code)
            tables.push(...tablesInSql(String(a.code)));
        if ((toolName === 'setObjectSource' || toolName === 'setMethodSource') && a.source)
            tables.push(...tablesInSql(String(a.source)));
        return tables;
    };

    if (policy.deniedTables && policy.deniedTables.length) {
        const hit = referencedTables().find(t => matchesAny(policy.deniedTables, t));
        if (hit)
            return deny('deniedTables', \`table \${hit} is in deniedTables\`);
    }
    if (policy.allowedTables && policy.allowedTables.length) {
        const tables = referencedTables();
        // For the data-access tools the list is closed: an undeterminable target is refused.
        if (TABLE_ACCESS_TOOLS.has(toolName) && !tables.length) {
            return deny('allowedTables', \`\${toolName}: the table it would read could not be determined, and allowedTables is closed\`);
        }
        const bad = tables.find(t => !matchesAny(policy.allowedTables, t));
        if (bad)
            return deny('allowedTables', \`table \${bad} is not in allowedTables (\${policy.allowedTables.join(', ')})\`);
    }

    // Package gates. allowedPackages and customOnly are independent and both must pass.
    const packageGates = [];
    if (policy.allowedPackages && policy.allowedPackages.length)
        packageGates.push({ label: 'allowedPackages', patterns: policy.allowedPackages });
    if (policy.customOnly)
        packageGates.push({ label: 'customOnly', patterns: CUSTOM_PACKAGE_PATTERNS });
    const failingGate = value => packageGates.find(g => !matchesAny(g.patterns, String(value)));
    const refuse = (gate, value, what) => deny(gate.label, gate.label === 'customOnly'
        ? \`\${what} \${String(value).toUpperCase()} is outside the customer namespace, and this destination may only change custom objects\`
        : \`\${what} \${String(value).toUpperCase()} is not in allowedPackages (\${gate.patterns.join(', ')})\`);

    if (packageGates.length) {
        let pkg;
        let where = '';
        if (toolName === 'createObject') {
            pkg = a.parentName || String(a.parentPath || '').match(/\\/packages\\/([^/?#]+)/)?.[1];
            where = 'parentName';
        }
        else if (toolName === 'runSnippet') {
            pkg = a.packageName || '$TMP';
            where = 'packageName';
        }
        else if (toolName === 'activatePackage') {
            pkg = a.packageName;
            where = 'packageName';
        }
        else if (toolName === 'runClass') {
            // Bridge patch: upstream did not gate runClass at all, so a closed
            // allowedPackages still allowed executing an arbitrary standard class.
            const name = a.className || a.clas || a.name;
            if (!name)
                return deny(packageGates[0].label, 'runClass: the class could not be determined, and the package policy is closed');
            pkg = await ctx.resolvePackage(\`/sap/bc/adt/oo/classes/\${encodeURIComponent(String(name).toLowerCase())}\`);
            where = 'class package';
        }
        else if (toolName === 'activateObjects') {
            let objects = [];
            try {
                objects = typeof a.objects === 'string' ? JSON.parse(a.objects) : (a.objects || []);
            }
            catch (_a) {
                objects = [];
            }
            if (objects.length > MAX_ACTIVATION_OBJECTS)
                return deny(packageGates[0].label, \`activateObjects: \${objects.length} objects exceeds the \${MAX_ACTIVATION_OBJECTS} that can be checked against a closed package policy; activate them in smaller batches\`);
            for (const o of objects) {
                const uri = o?.['adtcore:uri'] || o?.uri;
                const p = uri ? await ctx.resolvePackage(objectUrlOf(String(uri))) : undefined;
                if (!p)
                    return deny(packageGates[0].label, \`could not determine the package of \${uri || 'an object'} in activateObjects, and the package policy is closed\`);
                const bad = failingGate(p);
                if (bad)
                    return refuse(bad, p, \`package of \${uri}\`);
            }
        }
        else if (toolName === 'renameExecute' || toolName === 'extractMethodExecute') {
            let r = a.refactoring;
            try {
                r = typeof r === 'string' ? JSON.parse(r) : r;
            }
            catch (_b) {
                r = undefined;
            }
            const uri = r?.adtObjectUri?.uri || r?.adtObjectUri || r?.uri || (Array.isArray(r?.affectedObjects) ? r.affectedObjects[0]?.uri : r?.affectedObjects?.uri);
            pkg = uri ? await ctx.resolvePackage(objectUrlOf(String(uri))) : undefined;
            where = 'refactored object package';
        }
        else if (UNRESOLVABLE_WRITES.has(toolName)) {
            return deny(packageGates[0].label, \`\${toolName} cannot be checked against the package policy (target package not derivable from its arguments); allow it explicitly by clearing the package policy or use a destination without it\`);
        }
        else if (toolName === 'gitCreateRepo') {
            pkg = a.packageName;
            where = 'packageName';
        }
        else if (toolName === 'createTestInclude') {
            // Bridge patch: a missing class used to fall out of the chain with where
            // unset, so no package check ran at all. Setting where without pkg makes the
            // check below refuse instead of waving the call through.
            if (a.clas)
                pkg = await ctx.resolvePackage(\`/sap/bc/adt/oo/classes/\${encodeURIComponent(String(a.clas).toLowerCase())}\`);
            where = 'class package';
        }
        else if (OBJECT_URL_ARGS[toolName]) {
            // Bridge patch: this branch used to require the target argument to be present.
            // A write tool called without it left where empty and skipped the package gate
            // entirely, so setObjectSource, deleteObject and nine others were allowed on a
            // closed policy. The handlers read exactly these argument names, so a genuine
            // call always carries one; an absent target is now refused, not assumed safe.
            const raw = String(a[OBJECT_URL_ARGS[toolName]] || '');
            if (raw) {
                const url = raw.startsWith('/') ? objectUrlOf(raw) : \`/sap/bc/adt/oo/classes/\${encodeURIComponent(raw.toLowerCase())}\`;
                pkg = await ctx.resolvePackage(url);
            }
            where = 'object package';
        }
        else if (toolName === 'changePackageExecute' || toolName === 'changePackagePreview') {
            const target = a.newPackage || (typeof a.refactoring === 'string' ? (() => { try {
                return JSON.parse(a.refactoring).newPackage;
            }
            catch (_c) {
                return undefined;
            } })() : a.refactoring?.newPackage);
            // Bridge patch: a target package that cannot be determined is refused rather
            // than skipped, matching how every other closed-policy check behaves.
            if (!target)
                return deny(packageGates[0].label, 'changePackage: the target package could not be determined, and the package policy is closed');
            const bad = failingGate(String(target));
            if (bad)
                return refuse(bad, target, 'target package');
        }
        if (where) {
            if (!pkg)
                return deny(packageGates[0].label, \`could not determine the \${where} of the object, and the package policy is closed\`);
            const bad = failingGate(pkg);
            if (bad)
                return refuse(bad, pkg, 'package');
        }
    }

    if (policy.allowedTransports && policy.allowedTransports.length) {
        if (toolName === 'createTransport' || (toolName === 'resolveTransport' && a.createIfMissing === true)) {
            return deny('allowedTransports', 'creating transports is not allowed when allowedTransports is set; use one of the listed transports');
        }
        const argName = TRANSPORT_ARGS[toolName];
        const tr = argName ? a[argName] : undefined;
        if (tr && !matchesAny(policy.allowedTransports, String(tr))) {
            return deny('allowedTransports', \`transport \${String(tr).toUpperCase()} is not in allowedTransports (\${policy.allowedTransports.join(', ')})\`);
        }
        // The refactoring execute tools carry the transport inside the proposal
        // returned by their preview step, not as a top-level argument. Closed mode:
        // a proposal without a transport is refused, like an unresolvable package.
        if (REFACTORING_EXECUTE_TOOLS.has(toolName)) {
            const found = refactoringTransports(a.refactoring);
            if (found.length === 0) {
                return deny('allowedTransports', \`\${toolName}: the refactoring proposal carries no transport and allowedTransports is set; run the preview with a transport from the list (\${policy.allowedTransports.join(', ')})\`);
            }
            const bad = found.find(t => !matchesAny(policy.allowedTransports, t));
            if (bad)
                return deny('allowedTransports', \`transport \${bad.toUpperCase()} in the refactoring proposal is not in allowedTransports (\${policy.allowedTransports.join(', ')})\`);
        }
    }
    return { allowed: true };
}
`;

text = text.slice(0, start) + replacement + text.slice(end);
console.log('  patched: evaluatePolicy rewritten');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'policy.js'), Buffer.from(text, 'utf8'));
fs.writeFileSync(
  'packaging/vendor-patch/upstream.json',
  Buffer.from(JSON.stringify({
    package: 'abap-adt-mcp',
    note: 'Patched vendor files overlaid onto the base payload by build-desktop.py. The build verifies the upstream digest first and refuses to build if the base package ships a different policy.js, so a future abap-adt-mcp will never be patched blindly.',
    files: { [REL]: { upstreamSha256: upstreamHash } },
  }, null, 2) + '\n', 'utf8'),
);
console.log('\nupstream sha256: ' + upstreamHash);
console.log('patched bytes  : ' + fs.statSync(path.join(OUT_DIR, 'policy.js')).size);
