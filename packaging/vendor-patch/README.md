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

One file from `abap-adt-api` is patched as well, `build/api/transports.js`:

| Change | Why |
| --- | --- |
| `transportRelease` sends a `tm:root` body | With `ignoreLocks` or `IgnoreATC` upstream POSTed `relwithignlock` / `relObjigchkatc` without a body, and SAP answered 400 "System expected the element '{http://www.sap.com/cts/adt/tm}root'". SAP reads those actions from a `tm:root` document (`ST_CTS_ADT_TM_MAIN`) and takes the request number from it, so a Transport of Copies whose objects stay locked in their original request could not be released. |

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
   replacements to `policy.js` — `parsePolicy`, `tablesInSql` and `evaluatePolicy` — and one
   to `transports.js`, and fails loudly if any anchor no longer matches, which is the signal
   to review the change by hand.
3. It also rewrites `upstream.json` with both upstream files' digests; check that diff.
4. Run `npm test`. `test/policy-engine-test.js` asserts 110 decisions and
   `test/transport-release-test.js` the release request bodies; both fail against an
   unpatched engine, so they will tell you if a patch did not take.
