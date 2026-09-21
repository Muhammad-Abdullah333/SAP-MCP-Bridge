# Vendored policy-engine patch

`abap-adt-mcp` enforces the per-destination safety policy before a tool call reaches SAP.
Bridge ships a patched copy of one file from it, `dist/lib/policy.js`, because the upstream
version could not express or enforce what the manager offers:

| Change | Why |
| --- | --- |
| `allowedTables`, `allowedTools` | Upstream had deny-lists only. Passing an allow-list did nothing, silently. |
| `customOnly` | No notion of the customer namespace, so "only change custom objects" was not expressible. |
| `runClass` gated by package | Upstream did not check it at all: a closed `allowedPackages` still permitted executing an arbitrary standard class. |
| Whole activation batch checked | Upstream checked `objects.slice(0, 50)` and allowed the rest. An oversized batch is now refused rather than partly checked. |
| Quoted identifiers in SQL | `SELECT * FROM "USR02"` referenced no table as far as the parser was concerned, so `deniedTables` did not see it. |
| No target, no pass | A write tool called without its target object skipped the package check entirely. It is now refused on a closed package policy. |

## How it is applied

`packaging/build-desktop.py` overlays every file under `node_modules/` here onto the vendor
tree that `packaging/fetch-base.py` installs from npm. Before substituting, it compares that file against
the `upstreamSha256` recorded in `upstream.json` and **aborts the build on a mismatch**, so
a future `abap-adt-mcp` is never patched blindly. It then asserts every patch actually
landed, so a renamed or removed file fails the build rather than silently shipping
unpatched.

## Re-deriving after an upstream update

1. Update `abap-adt-mcp` in `packaging/vendor/package.json` and `package-lock.json`, then run
   `python packaging/fetch-base.py`. `UPSTREAM` in `make-patch.js` already points at the fetched `policy.js`.
2. Run `node packaging/vendor-patch/make-patch.js` from the project root. It applies three
   replacements — `parsePolicy`, `tablesInSql` and `evaluatePolicy` — and fails loudly if
   any anchor no longer matches, which is the signal to review the change by hand.
3. Update `upstreamSha256` in `upstream.json` to the new upstream file's digest.
4. Run `npm test`. `test/policy-engine-test.js` asserts 110 decisions and fails against
   an unpatched engine, so it will tell you if the patch did not take.
