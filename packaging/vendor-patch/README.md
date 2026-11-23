# Vendored policy-engine patch

`abap-adt-mcp` enforces the per-destination safety policy before a tool call reaches SAP.
Bridge ships a patched copy of `dist/lib/policy.js` from it, because the upstream
version could not express or enforce what the manager offers:

| Change | Why |
| --- | --- |
| `allowedTables`, `allowedTools` | Upstream had deny-lists only. Passing an allow-list did nothing, silently. |
| `customOnly` | No notion of the customer namespace, so "only change custom objects" was not expressible. |
| `runClass` gated by package | Upstream did not check it at all: a closed `allowedPackages` still permitted executing an arbitrary standard class. |
| Whole activation batch checked | Upstream checked `objects.slice(0, 50)` and allowed the rest. An oversized batch is now refused rather than partly checked. |
| Quoted identifiers in SQL | `SELECT * FROM "USR02"` referenced no table as far as the parser was concerned, so `deniedTables` did not see it. |
| No target, no pass | A write tool called without its target object skipped the package check entirely. It is now refused on a closed package policy. |

Upstream 2.6.0 closed table data by default (`allowDataPreview`, `allowFreeSql`, both off unless stated, also on a destination without a policy). `evaluatePolicy` keeps those two gates exactly as upstream wrote them. The manager states both keys on every destination (`src/system-config.js`), so Bridge's two read levels behave as before: a named table can always be read, and its own SQL only at the second level.

A second file from `abap-adt-mcp` is patched, `dist/index.js`:

| Change | Why |
| --- | --- |
| `resolvePackage` falls back to ADT quick search | The package of an existing object came only from the CTS check (`transportInfo`). A client closed for repository changes, such as a test client, refuses that check, so `customOnly` and `allowedPackages` denied every call, even `runClass` on a `$TMP` class. When the CTS check fails or returns no package, quick search supplies it, which needs no change authorization. Only a hit whose URI is exactly the object counts, and no answer still means denied. Since 2.8.0 upstream has its own fallback, the repository node path, but only for a transport-check answer it cannot parse (SAP_BASIS 7.40), not for the error a closed client returns; quick search runs after it. |

And `dist/lib/adtErrorHints.js`:

| Change | Why |
| --- | --- |
| A client closed for changes is not a lock | SAP reports TK730 ("changes to repository or cross-client customizing are not permitted", set per client in SCC4) with `ExceptionResourceNoAccess`, the exception it also uses for locks, and every one of those was classified as `locked`. `runSnippet` on a test client then advised unlocking and SM12. It is now `repositoryClosed`, with a hint that says what the client allows instead. |

One file from `abap-adt-api` is patched as well, `build/api/transports.js`:

| Change | Why |
| --- | --- |
| `transportRelease` sends a `tm:root` body | With `ignoreLocks` or `IgnoreATC` upstream POSTed `relwithignlock` / `relObjigchkatc` without a body, and SAP answered 400 "System expected the element '{http://www.sap.com/cts/adt/tm}root'". SAP reads those actions from a `tm:root` document (`ST_CTS_ADT_TM_MAIN`) and takes the request number from it, so a Transport of Copies whose objects stay locked in their original request could not be released. |

Further `abap-adt-mcp` files, patched through `patchFile` in `make-patch.js`:

| File | Change | Why |
| --- | --- | --- |
| `dist/handlers/QueryHandlers.js` | `runQuery` and `tableContents` run on the stateless clone | Every data preview ran in the destination's stateful session, where SAP generates a subroutine pool per query; after about 36 the session dumped (`GENERATE_SUBPOOL_DIR_FULL`) and the destination kept failing. Queries hold no lock, so they now use the stateless clone the class runner already uses. SSO and RFC destinations, which cannot use it, keep the stateful session. |
| `dist/lib/queryDecode.js` | The blank sign position is trimmed | SAP sends `100000.00 ` (a blank where a minus would go). With `decode=true` a negative amount became a number and a positive one stayed a string. |
| `dist/handlers/SnippetHandlers.js` | A warning for `WRITE`; oversized output shortened inside the JSON | `WRITE` prints to a classic list the class runner never shows, so the output was empty with no explanation. An oversized output was cut mid-JSON; now the output string is shortened and the result says how much was left out. |
| `dist/handlers/FeedHandlers.js` | `dumps` accepts `brief` | One short entry per dump, for scanning a list before `dumpDetails`. |
| `dist/handlers/SearchHandlers.js` | Fallback with an exact `objectName` | Without a text search index the fallback to `grepPackage` needed `packages`. An exact object name now supplies its own package, and only matches in that object are kept. |

## How it is applied

`packaging/build-desktop.py` overlays every file under `node_modules/` here onto the vendor
tree that `packaging/fetch-base.py` installs from npm. Before substituting, it compares that file against
the `upstreamSha256` recorded in `upstream.json` and **aborts the build on a mismatch**, so
a future `abap-adt-mcp` is never patched blindly. It then asserts every patch actually
landed, so a renamed or removed file fails the build rather than silently shipping
unpatched.

## Re-deriving after an upstream update

1. Update `abap-adt-mcp` (or `abap-adt-api`) in `packaging/vendor/package.json` and `package-lock.json`, then run
   `python packaging/fetch-base.py`. `UPSTREAM` and `TR_UPSTREAM` in `make-patch.js` already point at the fetched files.
2. Run `node packaging/vendor-patch/make-patch.js` from the project root. It applies three
   replacements to `policy.js` — `parsePolicy`, `tablesInSql` and `evaluatePolicy` — one
   to `index.js` (`resolvePackage`), two to `adtErrorHints.js` and one to `transports.js`, and fails loudly if any anchor no longer matches, which is the signal
   to review the change by hand.
3. It also rewrites `upstream.json` with every upstream file's digest; check that diff.
4. Run `npm test`. `test/policy-engine-test.js` asserts 110 decisions and
   `test/transport-release-test.js` the release request bodies; both fail against an
   unpatched engine, so they will tell you if a patch did not take.
