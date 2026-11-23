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
 * allowDataPreview, deniedTables, allowedTables, package gates (allowedPackages
 * and customOnly, both closed: unknown package => denied), allowedTransports.
 * Since upstream 2.6.0 a destination without a policy passes every gate except
 * the two data gates, which stay closed until the policy opens them.
 */
async function evaluatePolicy(policy, toolName, args, ctx) {
    if (!policy)
        policy = {};
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
    // Upstream 2.6.0 data gates, kept as upstream wrote them: reading table data is
    // off unless the policy opens it, and allowFreeSql implies allowDataPreview.
    if (DATA_TOOLS.has(toolName)) {
        const access = dataAccess(policy);
        const how = (key, env) => policy.allowDataPreview === false && key === 'allowFreeSql'
            ? 'its policy states "allowDataPreview": false, which closes SQL as well'
            : policy[key] === false
                ? \`its policy states "\${key}": false\`
                : \`nothing allows it yet. To allow it, set "\${key}": true in the policy of this destination in systems.json (\${env}=1 sets the default for destinations that do not state it) and restart the server\`;
        if ((toolName === 'runQuery' || a.sqlQuery) && !access.allowFreeSql) {
            const what = toolName === 'runQuery' ? 'free SQL (runQuery) is off on this destination' : 'tableContents with sqlQuery counts as free SQL, which is off on this destination';
            const alternative = access.allowDataPreview ? '; tableContents without sqlQuery still reads a table by name' : '';
            return deny('allowFreeSql', \`\${what}: \${how('allowFreeSql', 'MCP_ALLOW_FREE_SQL')}\${alternative}\`);
        }
        if (!access.allowDataPreview) {
            return deny('allowDataPreview', \`reading table data (\${toolName}) is off on this destination: \${how('allowDataPreview', 'MCP_ALLOW_DATA_PREVIEW')}\`);
        }
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
const policyBytes = fs.statSync(path.join(OUT_DIR, 'policy.js')).size;

// ------------------------------------------------------- transportRelease body
// abap-adt-api, not abap-adt-mcp: the release re-posts went out without a body.
const TR_UPSTREAM = 'build/base-payload/app/vendor/node_modules/abap-adt-api/build/api/transports.js';
const TR_OUT_DIR = 'packaging/vendor-patch/node_modules/abap-adt-api/build/api';
const TR_REL = 'node_modules/abap-adt-api/build/api/transports.js';
const trHash = crypto.createHash('sha256').update(fs.readFileSync(TR_UPSTREAM)).digest('hex');
text = fs.readFileSync(TR_UPSTREAM, 'utf8');

replace(
  `    const response = await h.request(\`/sap/bc/adt/cts/transportrequests/\${transportNumber}/\${action}\`, {
        method: "POST",
        headers: { Accept: "application/*" }
    });`,
  `    // Bridge patch: relwithignlock and relObjigchkatc are the "release anyway" re-posts, and
    // SAP (CL_CTS_ADT_TM_REST_RES_CONT->POST) reads them from a tm:root body. Upstream sent
    // none, so SAP answered 400 "System expected the element '{http://www.sap.com/cts/adt/tm}root'".
    // The body replaces SAP's request data wholesale, so it must carry the number (which SAP
    // does not upper-case there), and releaseobjlock keeps ignoreLocks when ATC is ignored too.
    const options = { method: "POST", headers: { Accept: "application/*" } };
    if (action !== "newreleasejobs") {
        const lock = IgnoreATC && ignoreLocks ? ' tm:releaseobjlock="yes"' : "";
        options.headers["Content-Type"] = "application/vnd.sap.adt.transportorganizer.v1+xml";
        options.body = \`<?xml version="1.0" encoding="ASCII"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:useraction="\${action}" tm:number="\${transportNumber.toUpperCase()}"\${lock}/>\`;
    }
    const response = await h.request(\`/sap/bc/adt/cts/transportrequests/\${transportNumber}/\${action}\`, options);`,
  'transportRelease sends a tm:root body on the release-anyway actions',
);

fs.mkdirSync(TR_OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(TR_OUT_DIR, 'transports.js'), Buffer.from(text, 'utf8'));

// ------------------------------------------------------- resolvePackage fallback
// abap-adt-mcp/dist/index.js. Package gates (customOnly, allowedPackages) learn an
// existing object's package from the CTS check (transportInfo). A client closed for
// repository changes, such as a test client, refuses that check, so every package-gated
// call was denied. The package is now also read from ADT quick search, which needs no
// change authorization. The policy stays closed: no answer still means denied.
const IDX_UPSTREAM = 'build/base-payload/app/vendor/node_modules/abap-adt-mcp/dist/index.js';
const IDX_OUT_DIR = 'packaging/vendor-patch/node_modules/abap-adt-mcp/dist';
const IDX_REL = 'node_modules/abap-adt-mcp/dist/index.js';
const idxHash = crypto.createHash('sha256').update(fs.readFileSync(IDX_UPSTREAM)).digest('hex');
text = fs.readFileSync(IDX_UPSTREAM, 'utf8');

// Since 2.8.0 upstream asks the repository node path when the transport check answers
// with a body it cannot parse (SAP_BASIS 7.40). That path is not taken on an HTTP or
// CTS error, which is what a client closed for repository changes returns, so the
// quick-search fallback is still needed. It runs after upstream's own fallback.
replace(
  `                catch (_b) {
                    pkg = undefined;
                }
            }
            if (pkg)
                dest.packageCache.set(key, pkg);
            return pkg;
        });
    }
    /** Build (once) the capability profile`,
  `                catch (_b) {
                    pkg = undefined;
                }
            }
            if (!pkg) {
                // Bridge patch: the CTS check fails on a client closed for repository
                // changes. Quick search returns the package without any change
                // authorization. Only a hit whose URI is exactly this object counts, so
                // a prefix match on another object can never supply its package.
                try {
                    const norm = (u) => { try { return decodeURIComponent(String(u || '')).toLowerCase(); } catch (_c) { return String(u || '').toLowerCase(); } };
                    const want = norm(key);
                    const hits = yield dest.adtClient.searchObject(norm(key.split('/').pop()), undefined, 100);
                    const hit = (hits || []).find((h) => norm((0, policy_js_1.objectUrlOf)(h['adtcore:uri'])) === want);
                    const found = hit && hit['adtcore:packageName'];
                    pkg = found ? String(found).toUpperCase() : undefined;
                }
                catch (_d) {
                    pkg = undefined;
                }
            }
            if (pkg)
                dest.packageCache.set(key, pkg);
            return pkg;
        });
    }
    /** Build (once) the capability profile`,
  'resolvePackage falls back to ADT quick search when the CTS check gives no package',
);

fs.mkdirSync(IDX_OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(IDX_OUT_DIR, 'index.js'), Buffer.from(text, 'utf8'));

// ------------------------------------------------------- closed client is not a lock
// abap-adt-mcp/dist/lib/adtErrorHints.js. SAP reports TK730 ("changes to repository or
// cross-client customizing are not permitted" in this client) as ExceptionResourceNoAccess,
// the same exception it uses for locks, and the classifier called every one of those a lock.
// runSnippet on a test client then told the model to unlock and check SM12.
const HINT_UPSTREAM = 'build/base-payload/app/vendor/node_modules/abap-adt-mcp/dist/lib/adtErrorHints.js';
const HINT_REL = 'node_modules/abap-adt-mcp/dist/lib/adtErrorHints.js';
const hintHash = crypto.createHash('sha256').update(fs.readFileSync(HINT_UPSTREAM)).digest('hex');
text = fs.readFileSync(HINT_UPSTREAM, 'utf8');

replace(
  `    staleLockHandle: {`,
  `    // Bridge patch: a client closed for repository changes (SCC4), reported by SAP with
    // the same exception as a lock. Nothing is locked there, so the lock advice misled.
    repositoryClosed: {
        hint: 'This SAP client does not allow changes to repository objects or cross-client customizing (SAP message TK730, set per client in SCC4). Nothing is locked and retrying will not help. Anything that creates or changes an object cannot work here, runSnippet included, because it creates a temporary class. Read data with runQuery or tableContents, run an existing class with runClass, and create or change objects on a development client.',
        nextTools: ['listSystems'],
    },
    staleLockHandle: {`,
  'adtErrorHints has a repositoryClosed kind',
);
replace(
  `    else if (has(/ExceptionResourceNoAccess|locked by|`,
  `    else if ((((_f = err.properties) === null || _f === void 0 ? void 0 : _f['T100KEY-ID']) === 'TK' && String(err.properties['T100KEY-NO']) === '730')
        || has(/T100KEY-ID:\\s*TK\\b[\\s,|]*T100KEY-NO:\\s*730\\b|changes to (the )?repository (or|and) (to )?cross-client customizing( objects)? are (not permitted|prohibited)/i)) {
        // Bridge patch: checked before the lock rule, which matches the same exception type.
        kind = 'repositoryClosed';
    }
    else if (has(/ExceptionResourceNoAccess|locked by|`,
  'adtErrorHints tells a client closed for changes (TK730) from a lock',
);

fs.writeFileSync(path.join(OUT_DIR, 'adtErrorHints.js'), Buffer.from(text, 'utf8'));

// ------------------------------------------------------------ further files
// Each one is patched the same way: exact anchors from the pinned upstream file, written
// under the same relative path, its upstream digest recorded for the build to verify.
const MORE = {};
function patchFile(rel, edits) {
  const upstream = path.join('build/base-payload/app/vendor', rel);
  MORE[rel] = { upstreamSha256: crypto.createHash('sha256').update(fs.readFileSync(upstream)).digest('hex') };
  text = fs.readFileSync(upstream, 'utf8');
  for (const [from, to, label] of edits) replace(from, to, label);
  const out = path.join('packaging/vendor-patch', rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(text, 'utf8'));
}

// queryDecode.js: SAP leaves a blank where a minus would go ("100000.00 "). Upstream
// moved a trailing minus to the front but returned other values untrimmed, so with
// decode=true a positive amount stayed a string while a negative one became a number.
patchFile('node_modules/abap-adt-mcp/dist/lib/queryDecode.js', [
  [
    `        const signed = signToFront(raw);`,
    `        // Bridge patch: the blank sign position of a positive number is trimmed too.
        const signed = signToFront(raw.trim());`,
    'queryDecode trims the blank sign position of positive numbers',
  ],
]);

// QueryHandlers.js: every data preview ran in the destination's stateful session, and
// SAP generates a subroutine pool per query in that session. After about 36 queries
// the session dumps (GENERATE_SUBPOOL_DIR_FULL) and the destination keeps failing.
// Queries need no lock, so they now run on the stateless clone the class runner already
// uses, where each request ends with its own session. SSO and RFC destinations, which
// cannot use the clone, keep the stateful session as before.
patchFile('node_modules/abap-adt-mcp/dist/handlers/QueryHandlers.js', [
  [
    `    handleTableContents(args) {`,
    `    /** Bridge patch: the client a data preview runs on (stateless clone where possible). */
    previewClient() {
        var _a, _b;
        const client = this.adtclient;
        const rfc = (_b = (_a = client === null || client === void 0 ? void 0 : client.httpClient) === null || _a === void 0 ? void 0 : _a.httpclient) === null || _b === void 0 ? void 0 : _b.endStatefulSession;
        if (typeof rfc === 'function')
            return client;
        try {
            const clone = client.statelessClone;
            return clone && clone !== client ? clone : client;
        }
        catch (_c) {
            return client;
        }
    }
    handleTableContents(args) {`,
    'QueryHandlers gains previewClient',
  ],
  [
    `const raw = yield this.adtclient.tableContents(`,
    `const raw = yield this.previewClient().tableContents(`,
    'tableContents runs on the stateless clone',
  ],
  [
    `const raw = yield this.adtclient.runQuery(`,
    `const raw = yield this.previewClient().runQuery(`,
    'runQuery runs on the stateless clone',
  ],
]);

// SnippetHandlers.js: (1) WRITE output never reaches the class runner's console, so a
// snippet using WRITE returned empty output with no explanation. (2) An oversized output
// was cut mid-JSON. The output string itself is now shortened, so the result stays
// valid JSON and says how much was left out.
patchFile('node_modules/abap-adt-mcp/dist/handlers/SnippetHandlers.js', [
  [
    `                if (run.locksInvalidated.length)
                    payload.locksInvalidated = run.locksInvalidated;
                const text = JSON.stringify(payload);`,
    `                if (run.locksInvalidated.length)
                    payload.locksInvalidated = run.locksInvalidated;
                // Bridge patch: WRITE statements print to a classic list the class runner never shows.
                if (/(?:^|[.\\n])\\s*WRITE\\s*[:/'\`|a-z0-9_]/i.test(String(args.code)) && !/out\\s*->\\s*write/i.test(String(args.code)))
                    payload.warning = 'The code uses WRITE, which prints to a classic list that the class runner does not show. Use out->write( ... ) instead.';
                // Bridge patch: shorten the output itself, so the result stays valid JSON.
                const budget = 36000;
                if (typeof payload.output === 'string' && JSON.stringify(payload).length > budget) {
                    const total = payload.output.length;
                    payload.output = payload.output.slice(0, Math.max(1000, budget - (JSON.stringify(payload).length - total) - 400));
                    payload.outputTruncated = true;
                    payload.outputChars = total;
                    payload.note = \`Output shortened to its first \${payload.output.length} of \${total} characters. Running the snippet again repeats its effects, so print less, or print a later part with an offset in the ABAP itself.\`;
                }
                const text = JSON.stringify(payload);`,
    'runSnippet warns about WRITE and shortens oversized output',
  ],
]);

// FeedHandlers.js: dumps returns a summary with the top of the call stack per dump, which
// is large when many dumps are listed. brief=true gives one short line per dump.
patchFile('node_modules/abap-adt-mcp/dist/handlers/FeedHandlers.js', [
  [
    `                        startIndex: {
                            type: 'number',
                            description: '0-based index of the dump to start from (default 0). Use with maxItems to page through a large dump list.',`,
    `                        brief: {
                            type: 'boolean',
                            description: 'One short entry per dump (id, time, user, runtime error, program, short text) instead of the full summary. Use it to scan a list, then dumpDetails for one dump.',
                            optional: true
                        },
                        startIndex: {
                            type: 'number',
                            description: '0-based index of the dump to start from (default 0). Use with maxItems to page through a large dump list.',`,
    'dumps accepts brief',
  ],
  [
    `                const items = filtered.map(({ summary, raw }) => args.includeHtml === true ? Object.assign(Object.assign({}, summary), { html: raw.text }) : summary);`,
    `                const items = filtered.map(({ summary, raw }) => args.brief === true
                    ? { dumpId: summary.dumpId, timestamp: summary.timestamp, user: summary.user, runtimeError: summary.runtimeError, program: summary.program, shortText: summary.shortText }
                    : args.includeHtml === true ? Object.assign(Object.assign({}, summary), { html: raw.text }) : summary);`,
    'dumps returns one short entry per dump when brief',
  ],
]);

// SearchHandlers.js: without a text search index the tool fell back to grepPackage only
// when packages were given. With an exact objectName it now finds that object's package
// and greps there, keeping only matches in that object.
patchFile('node_modules/abap-adt-mcp/dist/handlers/SearchHandlers.js', [
  [
    `                if (response.status === 404 || response.status === 405 || response.status === 501) {
                    if (packages.length) {`,
    `                if (response.status === 404 || response.status === 405 || response.status === 501) {
                    // Bridge patch: an exact object name supplies its own package for the fallback.
                    let onlyObject;
                    if (!packages.length && args.objectName && !/[*?]/.test(String(args.objectName))) {
                        try {
                            const want = String(args.objectName).toUpperCase();
                            const hits = yield this.adtclient.searchObject(want, undefined, 50);
                            const hit = (hits || []).find((h) => String(h['adtcore:name'] || '').toUpperCase() === want && h['adtcore:packageName']);
                            if (hit) {
                                packages.push(String(hit['adtcore:packageName']));
                                onlyObject = want;
                            }
                        }
                        catch (_x) { /* no package found: the refusal below stands */ }
                    }
                    if (packages.length) {`,
    'sourceTextSearch finds the package of an exact objectName for the fallback',
  ],
  [
    `                        merged.returnedMatches = merged.matches.length;`,
    `                        if (onlyObject)
                            merged.matches = merged.matches.filter((m) => String(m.name || '').toUpperCase() === onlyObject);
                        merged.returnedMatches = merged.matches.length;`,
    'sourceTextSearch keeps only the named object in that fallback',
  ],
]);

fs.writeFileSync(
  'packaging/vendor-patch/upstream.json',
  Buffer.from(JSON.stringify({
    package: 'abap-adt-mcp',
    note: 'Patched vendor files overlaid onto the base payload by build-desktop.py. The build verifies the upstream digest first and refuses to build if the base package ships a different file, so a future abap-adt-mcp or abap-adt-api will never be patched blindly.',
    files: {
      [REL]: { upstreamSha256: upstreamHash },
      [TR_REL]: { upstreamSha256: trHash },
      [IDX_REL]: { upstreamSha256: idxHash },
      [HINT_REL]: { upstreamSha256: hintHash },
      ...MORE,
    },
  }, null, 2) + '\n', 'utf8'),
);
console.log('\nupstream sha256: ' + upstreamHash + '  (policy.js)');
console.log('upstream sha256: ' + trHash + '  (transports.js)');
console.log('upstream sha256: ' + idxHash + '  (index.js)');
console.log('upstream sha256: ' + hintHash + '  (adtErrorHints.js)');
console.log('patched bytes  : ' + policyBytes + ' / ' + fs.statSync(path.join(TR_OUT_DIR, 'transports.js')).size + ' / ' + fs.statSync(path.join(IDX_OUT_DIR, 'index.js')).size);
