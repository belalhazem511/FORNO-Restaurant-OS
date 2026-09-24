# Phase 4A — Codebase Simplification Audit

Audit date: 2026-09-24
Audited baseline: `58cb3cca3c792425e36893b712dc615a3f113e5f` (`feat: add full stock counts`)
Audit branch: `refactor/codebase-simplification`

This is a read-only source audit. No product behavior, dependencies, runtime data, or application files were changed. The only intended repository change for Phase 4A is this document. The preserved PGLite runtime directory `apps/web/data/pglite` was not opened or inspected.

## A. Executive summary

FORNO is a single-deployment TypeScript monorepo: a Next.js App Router application owns the user interface, tRPC endpoints, PGLite connection, and seed orchestration; workspace packages provide tRPC initialization, Better Auth construction, the Drizzle schema, shared UI primitives, TypeScript configuration, and environment parsing. This is an appropriate small-team modular-monolith direction. A replacement architecture is not needed.

The largest cost is that feature boundaries are implicit rather than structural. Screens live directly under `app/admin`; most are client components that combine queries, mutation state, exact-input parsing, permissions-as-display-state, and rendering. Server routers contain both API validation and substantial transactional business workflows. The database schema, seed orchestrator, POS screen, offline sync router, and several inventory/procurement routers have accumulated multiple responsibilities. Refactoring these blindly would put inventory, financial, offline, print, and history invariants at risk.

Recommended strategy: characterize the behavior first, then make one small seam change per commit. Keep Next.js and tRPC as adapters; keep transaction boundaries and exact calculations in named feature workflows; retain existing public API and schema exports; split the Drizzle definitions with a single acyclic relation assembly point; separate deterministic seed steps while preserving their order; and move presentation only after route behavior has characterization coverage. Measure before performance changes. Do not redesign the UI or introduce a framework of abstractions during this work.

Highest-priority safeguards:

- Do not run `apps/web/schema.sql`: it is a legacy destructive SQL sample, not the current schema. It contains `DROP TABLE` and sample inserts, is only 64 lines/2.1 KiB, and no in-repository reference to it was found.
- Do not run `apps/web/scripts/prepare-prod.ts` as an upgrade shortcut. Its documented behavior installs/removes packages, rewrites database and package files, removes scripts, and edits configuration.
- Keep all mutations, locking order, status guards, audit writes, idempotency keys, and fixed-point arithmetic in the same transaction while extracting workflows.
- Treat the runtime database, all historical rows, financial records, stock movements, and offline queues as immutable during refactoring. Use only newly created isolated PGLite test/build databases.

## B. Current architecture map

```text
FORNO workspace (Bun 1.3.5 / Turbo)
├─ apps/web — Next.js 16 App Router application
│  ├─ src/app — route files, layouts, API handlers, global styles
│  ├─ src/components — admin shell, inventory navigation, offline and print UI
│  ├─ src/lib/trpc — root router, context, OpenAPI, feature routers and tests
│  ├─ src/lib/inventory, finance, orders, offline, printing — mixed pure and DB-aware code
│  ├─ src/lib/db — PGLite connection/config, schema facade, seeds and safety tests
│  ├─ src/messages + src/i18n — English/Arabic messages and locale selection
│  ├─ public/sw.js — service-worker cache boundary
│  └─ scripts — build isolation, schema application, database checks and production prep
├─ packages/api — tRPC base context, procedure and router constructors
├─ packages/auth — Better Auth factory plus client setup
├─ packages/db — Drizzle schema/auth-schema and workspace exports
├─ packages/ui — reusable Radix/Tailwind components and global CSS
├─ packages/env — server/client environment parsing and URL helpers
└─ packages/config — shared TypeScript configuration
```

Routes currently cover admin dashboard, POS/cashier, products/customers/orders, payment-method configuration, sync center, inventory overview, ingredients/recipes/movements, suppliers/purchase orders, receiving, supplier returns, internal transfers, and stock counts. API routes expose Better Auth, tRPC, OpenAPI JSON, API docs, offline health, online print, and offline print. There is no separate `features/` or `server/` tree yet; the domain seams are primarily the route tree and `src/lib` files.

The configured database is PGLite (`drizzle-orm/pglite`) with an explicit runtime/test/build role guard. The existing architecture notes describe PostgreSQL as the central database, while current application startup and `drizzle.config.ts` use PGLite. The production-preparation script describes a future move to PostgreSQL but performs source mutation itself. Documentation and executable deployment architecture should be reconciled in a separately approved infrastructure change, not in a feature refactor.

## C. Complexity hotspots

Sizes below are source sizes on the audited checkout; line counts are approximate maintainability indicators only, not split criteria. Consumers are identified from imports and route composition. The largest source files are not automatically the first files to split.

| Full path | Approx. size | Responsibilities / dependencies / consumers | Maintenance difficulty and business risk | Recommended destination |
|---|---:|---|---|---|
| `packages/db/src/schema.ts` | 123.2 KiB / 1,551 lines | Table/enum/check/index definitions and relation declarations for auth, restaurant, menu, orders, finance, printing, offline, inventory, procurement, receiving, returns, transfers, and counts. Consumed by the DB package, app schema facade, Drizzle config, seed, routers, and tests. | One edit has a very large review surface; cross-domain relations encourage cycles or broad imports. A mistaken type/default/index changes SQL and can invalidate all history. | Split table declarations by domain under `packages/db/src/schema/`; keep a small compatibility export and a separate relation assembly module. Compare generated schema before/after. |
| `apps/web/src/app/admin/pos/page.tsx` | 53.9 KiB / 677 lines | POS UI, menu and cart state, pricing/discount presentation, online ordering, offline bootstrap/queue/document preview paths, and UI actions. Imports tRPC types, offline queue/storage/documents, exact/finance helpers, and many UI components. | A visual edit can accidentally change checkout or offline semantics; unrelated concerns are tested in one component. It is the largest route source file. | `features/pos/PosScreen.tsx` plus small feature-local cart/presentation pieces; leave `app/admin/pos/page.tsx` as a route composition. Do not split the offline engine into UI components. |
| `apps/web/src/lib/trpc/routers/offline.ts` | 39.9 KiB / 667 lines | Bootstrap, server-issued price snapshots, sync input validation, conflict/review handling, transactional order/checkout/payment/print/inventory writes, permissions, idempotency, and audit. Depends on Drizzle, auth/permissions, inventory, order, finance, and print code. Consumed by root router, POS and sync UI. | This is a high-consequence transaction path with many side effects and compatibility fields. Reordering or extracting a statement can create partial money, stock, or print results or break old queued operations. | Keep an `offline` API adapter and separate named `createBootstrapSnapshot` / `synchronizeOperation` workflows. Split only after offline request/response and failure-state characterization. |
| `apps/web/src/lib/db/seed.ts` | 28.6 KiB / 485 lines | Auth demo users, branch and role assignments, restaurant/menu configuration, purchasing examples, transfer/count examples, and orchestration of inventory seed. Imports auth, PGLite, many schema tables, and inventory seed. | Ordering and `onConflictDoNothing`/upsert choices determine reproducibility and stock movement effects. Repeated seed idempotence is a data invariant, not cosmetic setup. | Keep `seed.ts` as a short, explicitly ordered orchestrator; move domain data/functions to a few `seed/` modules. Preserve dependencies and repeat-seed assertions. |
| `apps/web/src/lib/db/inventory-seed.ts` | 17.1 KiB / 145 lines | Units, locations, categories, tracked ingredients, package conversions, recipes and opening balances; calls exact conversion and stock posting. | Combines catalog setup and movement-producing operations. Reordering can change weighted-average cost or duplicate opening stock. | `seed/inventory-catalog.ts` and `seed/inventory-opening-stock.ts` only if tests prove the split; call in explicit order from the orchestrator. |
| `apps/web/src/lib/inventory/service.ts` | 18.7 KiB / 221 lines | Recipe resolution, order inventory issue, stock locking/availability, movements, balance/WAC updates, reversal, and producible availability. Directly depends on Drizzle and exact helpers; used by checkout/order and seed workflows. | Domain rules and persistence are intertwined. Multiple per-item/component reads occur inside transaction loops. Incorrect batching or lock ordering risks overselling and COGS divergence. | Keep transaction-owning inventory workflows together initially; later introduce named functions by operation (`issueOrderInventory`, adjustment, reversal, availability) without a generic service framework. |
| `apps/web/src/lib/trpc/routers/procurement.ts` | 22.9 KiB / 512 lines | Supplier CRUD/archive, purchase order drafting/transitions, line validation, permissions, branch scope, totals, snapshots, and audit. Imports Drizzle and exact math. Consumed by root router and procurement screens. | More than one resource/workflow in one router; UI/API changes touch the same large module. Existing PO immutable snapshot and no-stock-effect rules are critical. | Keep supplier and PO router surfaces; extract their workflows into feature-specific files only after current public outputs and transition tests are frozen. |
| `apps/web/src/lib/trpc/routers/receiving.ts` | 35.5 KiB / 359 lines | GRN draft/post/reversal, PO progress, over-receive and price variance checks, source snapshots, balance locks, WAC, movements, audit. Consumers: receiving UI and procurement detail. | Large atomic operation with special handling for exact conversions and Needs Review. A “cleanup” can produce partial receipts or duplicate stock. | `receiving/router.ts` and `receiving/workflows/{draft,post,reversal}.ts`, with each transaction kept intact. |
| `apps/web/src/lib/trpc/routers/supplier-returns.ts` | 43.5 KiB / 443 lines | Receipt-linked RTV creation, returnable quantities, approvals/dispatch, stock removal, costing, reversals, permission and audit rules. Consumers: returns UI, receiving/procurement history. | Highly coupled to receipt-line accepted quantity, available balance, and append-only movement history. `getBundle` performs multiple reads per return line. | Feature-local reader and transaction workflows after tests assert source linkage, exact return caps, and no partial dispatch. |
| `apps/web/src/lib/trpc/routers/stock-transfers.ts` | 43.0 KiB / 328 lines | In-branch draft/approval, dispatch, partial/final receipt, in-transit amount, WAC, reversal, audit and history. Consumers: transfer UI and inventory ledger. | Multiple transactions and locations with concurrent stock activity. Reversal correctness must not be diluted by a broad extraction. A reversal path currently loads all transfer receipt lines before filtering to one transfer. | `transfers/router.ts` plus dispatch/receive/reversal workflows. Replace the whole-table read with a scoped query only as a measured, separately tested change. |
| `apps/web/src/lib/trpc/routers/stock-counts.ts` | 35.7 KiB / 257 lines | Snapshot/start, blind input, immutable entry history, submission, approval, watermark validation, atomic adjustment post, idempotency, cancellation/reversal and audit. Consumers: count UI and root API router. | Iterates ingredients for locked balance, unit and movement-watermark reads. Its Needs Review behavior is intentionally conservative; simplification must retain all-or-nothing status and movements. | `stock-counts/router.ts` + named count workflows, after transition/concurrency/stale-ledger tests. |
| `apps/web/src/lib/trpc/routers/printing.ts` | 21.7 KiB / 312 lines | Trusted receipt/order-summary/KOT/reversal document loading, status checks, permissions, snapshots, jobs, preview acknowledgement, reprint and audit. Consumers: online print UI and POS/offline document concepts. | Document classification and authorization can drift from offline print snapshots; source order objects include many nested relations. | Keep `printing` as a feature boundary; separate document read/model from job transitions only after byte/field-level print fixtures exist. |
| `apps/web/src/lib/trpc/routers/checkout.ts` and `orders.ts` | 17.3 KiB / 330 lines; 18.7 KiB / 392 lines | Order/checkout lifecycle, trusted price calculation, payment, inventory issue, COGS and transaction/audit writes, with shared transition dependencies. | Financial status and inventory trigger semantics are distinct but meet at a transaction boundary. Moving one call can change payment/stock ordering. | Keep API adapters small and preserve one explicit checkout transaction workflow; do not merge money and stock into a generic “order service.” |
| `apps/web/src/lib/trpc/routers/__tests__/helpers.ts` | 11.6 KiB / 181 lines | PGLite test setup, test schema/index setup, role callers and fixtures shared across router tests. | Test-only schema/bootstrap can diverge from production Drizzle schema; many tests depend on common mutable setup. | Separate only stable fixture builders from DB lifecycle/schema setup; make tests use the same schema exports and verify constraints. |
| `apps/web/src/lib/trpc/routers/__tests__/offline.test.ts` | 20.8 KiB / 272 lines | Offline protocol, accepted/review flow, payments, inventory, prints, permissions and idempotency integration tests. | Valuable broad invariant coverage but multiple scenarios make failures hard to localize. Do not weaken or delete it while splitting offline code. | Retain integration coverage and add named scenario helpers or test files by transaction boundary. |
| `apps/web/src/messages/en.ts`, `ar.ts` | 16.0 KiB / 437 lines; 20.4 KiB / 432 lines | Central nested message catalogs consumed by all client routes. | Wide catalog changes and parallel duplicate keys can make visual redesign/translations uneven. Key/type parity should stay checked. | Preserve stable namespaces; split only into domain dictionaries if next-intl loading and typed message parity remain unchanged. |

Other files with meaningful responsibility overlap include the admin dashboard (`src/app/admin/page.tsx`, 12.9 KiB/411 lines), inventory UI routes (purchase orders 18.2 KiB/389 lines; ingredients, receiving, returns, transfers), and the status-specific test files. The POS page is the largest route; the inventory router implementations are the largest server feature set.

## D. Dependency and coupling findings

### Observed direction

- `apps/web` composes `@forno/api`, `@forno/auth`, `@forno/db`, `@forno/ui`, and `@forno/env`. `packages/api` currently owns tRPC constructors and an authentication-only `protectedProcedure`; branch and business authorization live in `apps/web/src/lib/permissions.ts` and routers. `packages/db` owns the current schema definitions. This means `packages/api` is not yet an independently deployable domain API, which is fine for the current monolith.
- Server feature routers import `@/lib/db`, Drizzle, permissions, and exact math. Transactional domain rules therefore depend directly on Next-app infrastructure/Drizzle. `src/lib/inventory/exact.ts` is comparatively pure and is imported directly by some client screens for decimal parsing and display-side conversion; server mutations must continue recalculating authoritative values.
- Client screens import the tRPC client and sometimes `import type` router outputs. Keep router type imports type-only; importing the runtime root router into a client bundle would drag server implementation edges into the UI graph.
- No direct `db`, `@forno/db`, `drizzle-orm`, or `node:` imports were found in client components/pages during the import scan. Three server route layouts (`inventory/receiving/layout.tsx`, `returns/layout.tsx`, and `transfers/layout.tsx`) directly query `staffAssignments` and check permissions. Those are server-side page guards; the API must remain independently guarded. Prefer a named server authorization function over route-local copies after tests cover redirects and denied page/API behavior.
- `packages/db/src/index.ts`, `packages/db/src/schema.ts`, and `apps/web/src/lib/db/schema.ts` re-export broad schema surfaces; `packages/db/package.json` also exposes a wildcard `./*` export. These stabilize existing imports but make it easy to depend on implementation files. Preserve the current export contract during splitting, then narrow exports only with a complete import search and package typecheck.
- `apps/web/src/lib/trpc/router.ts` is the explicit API composition point. `src/lib/trpc/openapi.ts` describes the API but its current description/tags mention only products/customers/orders/transactions/payment methods; the router now includes inventory/procurement/offline/printing workflows. This is documentation drift, not a reason to change API behavior in this audit.
- `apps/web/src/lib/utils.ts` contains date/currency formatters, while `packages/ui/src/lib/utils.ts` contains Tailwind class merging. The generic names are ambiguous, but they are not the same behavior and should not be combined.
- `apps/web/src/app/admin/pos/page.tsx` imports offline queue, storage, document generation, and types; offline is product-coupled to POS by design. Printing also shares trusted document data with online/offline paths. Removing either feature requires explicit adapter and history boundaries, not a broad import cleanup.

No complete automated import-cycle report was available in the existing repository tools, and no cycle is asserted by this source inspection. Establish a static import graph/cycle check in Batch 1 or use an already-approved local tool; do not install a dependency for the audit. Pay particular attention to schema relation imports, `seed.ts` → `inventory-seed.ts` → inventory service → DB, and client type references to the composed router.

### Target import direction

```text
Next route/layout (thin adapter)
  → feature screen (client presentation) and server route guard (server only)
  → feature API/router adapter (validation, auth, output mapping)
  → named feature workflow (transaction, audit, idempotency, branch scope)
  → shared domain primitives (exact quantity/money, permission policy)
  → database adapter/schema
```

Shared UI may be imported by feature screens, never the reverse. Pure quantity/money modules may be used for input parsing/formatting client-side, but persisted calculations and authorization remain server-authoritative. Feature workflows must not import route components, Next navigation, React, tRPC clients, or browser storage. Avoid cross-feature imports into another router; expose a narrow workflow function only where behavior is truly shared.

## E. Database and seed findings

- Drizzle’s current schema source is `packages/db/src/schema.ts`, reached via `apps/web/src/lib/db/schema.ts` and used by the app’s `drizzle.config.ts`. The schema file includes tables, constraints, indexes, enums/types, and all Drizzle relations in one module. `packages/db/src/auth-schema.ts` contains Better Auth tables and relations; the business schema imports/re-exports `user`.
- `apps/web/src/lib/db/index.ts` applies role-based database isolation. It refuses to create a missing DB automatically and forbids production-build DB calls. `scripts/build.ts` creates a fresh temporary `forno-build-pglite-*` directory and removes it after the build. `scripts/push-schema.ts` validates an existing directory before explicit Drizzle push. These safety boundaries are high-value code and must not be simplified away.
- Router tests use `src/lib/trpc/routers/__tests__/helpers.ts` to build PGLite fixtures and explicit indexes. Keep that setup aligned with production constraints and branches; schema decomposition must prove test and production schema equivalence, not merely compile.
- Seed ordering is currently split only partly: `seed.ts` is a 485-line orchestrator and imports a separate 145-line `inventory-seed.ts`. Repeated seed calls are expected and are tested by database-safety tests. Seeded opening balances/movements, active demo records, PO/transfer/count drafts, and audit rows need stable idempotency keys and an explicit dependency order.
- `apps/web/schema.sql` is not the current Drizzle schema. It contains legacy `products/customers/orders/transactions` definitions, decimal money, `DROP TABLE IF EXISTS`, and sample payment-method inserts; repository search found no consumer. Treat it as a dangerous stale artifact. Do not execute it or delete it during this audit. A later commit should establish whether it is externally consumed before retiring it.
- `apps/web/scripts/reset-db.ts` is a destructive development script guarded by the conspicuous `--confirm-delete-runtime-database` flag. Preserve that explicit friction; do not refactor the safeguard or run it.
- `apps/web/scripts/prepare-prod.ts` documents package installation/removal and direct rewrites/deletions to database code, `package.json`, config, and scripts. It is a migration utility with a much larger blast radius than its name suggests. It must never be run as part of codebase simplification. Replace its behavior only under a separately approved deployment/migration design.

Safe schema split: table-definition modules should not import feature workflows; relations should be assembled in one relation module or another acyclic place. Preserve the public schema export surface and Drizzle config resolution. Compare all table/column names, SQL types/defaults, indexes, checks, unique/partial indexes, FKs, delete rules, enums and relations before/after using newly created isolated PGLite databases. Require no generated SQL change and no migration against the preserved runtime DB. Seed split must keep ordering legible and prove first-run effects plus second-run zero duplicates.

## F. Server and API findings

- The root tRPC router is explicit and feature routers are registered centrally. Each router generally owns Zod input validation, permission checks, branch/location validation, transaction, status transitions, audit, and serialization. This is auditable but makes the router file a large mixed-responsibility module.
- `protectedProcedure` establishes only authenticated user context. `requireStaff`/`hasPermission` and resource-specific queries must remain on every protected operation. A route-level guard is not a substitute for an API guard. Branch and location filters must remain in the transaction/query predicate, not be inferred from client IDs.
- `permissions.ts` contains the role-to-permission sets, while some feature authorization helpers wrap `requireStaff` to audit denials. The stock-count role lists are separately declared in `hasPermission` and `permissionsForRole`, creating a drift risk. Consolidate representation only after parity tests for Owner/Admin/Manager/Cashier and denial-audit semantics.
- Audit inserts are repeated in feature routers, with event names and metadata deliberately domain-specific. Idempotency keys and history are similarly operation-specific. A small typed audit writer may be shared only if it retains actor, branch, entity, reason, and details and does not silently swallow errors. Do not create a generic workflow/idempotency/transaction framework.
- Exact conversion and integer cost primitives already live in `inventory/exact.ts`; inventory posting is in `inventory/service.ts`. PO/receiving/returns/transfers/counts each have domain transaction code because their sources, immutability, movement directions, and reversal rules differ. Centralize mathematical invariants, not lifecycle policy.
- Important transaction contracts that must be frozen: checkout-to-stock issuance trigger and atomicity; receipt posting/variance; RTV dispatch and reversal; transfer in-transit/reversal; count snapshot watermark and all-or-nothing post; online/offline checkout reconciliation; trusted receipt/KOT documents. Keep tests that assert effects on movements, balances, COGS, money, history and audit.
- OpenAPI generation currently composes the whole router but carries stale summary metadata. Correcting metadata is a separate docs-only change after contract characterization; it must not alter route names or procedure schemas.

## G. UI redesign-readiness report

### Current state

- App Router files commonly declare `"use client"` and contain TanStack/tRPC queries, mutation handlers, local form state, decimal conversion, toast/dialog flow, permission-gated actions, and large JSX blocks. Examples include POS, purchase orders, receiving, returns, transfers, and counts. The route itself is often the screen and data adapter.
- The admin shell (`components/admin-layout.tsx`) is client-side and reads offline context. `OfflineProvider` is mounted in the root layout, so IndexedDB recovery, service-worker registration, online health polling, and sync-engine setup are not scoped only to the POS/admin experience. This is a directly visible boundary; measure effects and preserve offline reload behavior before moving it.
- `packages/ui` already contains Button/Card/Input/Label, dialog/select, table/data-table, pagination, search/filter, combobox, and other primitives. Feature screens use some primitives but also repeat Tailwind layouts, labels, inline selects, cards, status badges, empty states, and `window.confirm`/`window.alert` flows. Do not replace the library or build a universal component with a large prop surface.
- `apps/web/src/app/globals.css` and `packages/ui/src/styles/globals.css` both define similar CSS color/radius/chart tokens and Tailwind theme mappings. This is a direct token-drift risk. The app’s root global stylesheet also supplies the UI package scan source. Choose one token contract and one import point after screenshot/RTL regression coverage.
- Locale and `dir` are established at the root via next-intl. Components still choose Arabic/English inline, and responsive/RTL classes are feature-local. Keep locale-independent domain values and messages separate from layout; verify logical-direction CSS, Arabic text shaping, keyboard focus and narrow viewport after every UI move.
- Server-only DB checks occur in the receiving/returns/transfers route layouts; that is acceptable in server components but duplicates query/guard code. Keep server and client module boundaries explicit. The rest of API permission enforcement remains server-side.

### Redesign boundary

Use route files to compose screens, not own domain workflows. A feature screen can consume typed feature queries/actions or a feature-local view-model hook; the workflow/API remains independent of markup. Put stable tokens in one `packages/ui` token stylesheet imported once by the web app; centralize typography, colors, spacing, radius, shadows, and breakpoints there. Keep `packages/ui` primitives focused: form fields, table building blocks, dialogs, page headers, and status badges with accessible defaults. Feature-specific tables/forms remain feature-owned. RTL should derive from locale and use logical properties; avoid a parallel mirrored component tree.

Do not redesign visual hierarchy, colors, spacing, typography, or interaction behavior in structural UI commits. Use browser screenshots at desktop/mobile and Arabic/English as a visual equivalence check. A later redesign requires its own explicit approval after the screen/data boundary is stable.

## H. Performance findings and evidence levels

### Directly evidenced from source/build artifacts

1. **Inventory issue query amplification —** `src/lib/inventory/service.ts` resolves recipes inside an order-item loop, reads balances inside requirement loops, and issues reads per recipe/component. Query count therefore grows with order items and ingredients. This is structural evidence of N+1-style behavior; it is not proof of user-visible latency. Batch reads only after measuring and retain deterministic balance lock order.
2. **Stock-count snapshot/post loops —** `stock-counts.ts` loops over tracked ingredients and performs balance lock/read, unit read, and movement watermark read per line; post repeats lock/current-balance/later-movement checks. Counts with more tracked ingredients necessarily issue more statements. Any batched query must preserve the exact movement watermark and lock semantics.
3. **Transfer reversal scans unrelated rows —** `stock-transfers.ts` reads all `stockTransferReceiptLines` with receipt relations and then filters for the current transfer. Replace with a scoped query only after regression tests and query-plan/latency evidence.
4. **Supplier-return bundle amplification —** return details load associated supplier/PO/receipt/location and query receipt-line, ingredient, unit, and balance data per return line. Batch/join is a candidate, but exact source lineage and branch filters must be retained.
5. **Broad client/runtime scope —** the root layout mounts `OfflineProvider`, which runs recovery, health checks, periodic polling (15 seconds in the component), and service-worker setup for all routes. This can add work and client code outside POS; measure route traffic and bundle effects before moving the provider.
6. **Full-list reads —** several list endpoints load complete branch collections and screens render the results; counts, receipts, returns, transfers, ingredients, and history should be checked for pagination/search requirements as data grows. Do not add pagination that hides unresolved exceptions or changes operational sorting.
7. **Available baseline (one existing production build):** Next 16.1.6 build completed in approximately 26.5 seconds; the latest full Bun test run completed 169 tests / 739 expectations in approximately 47.2 seconds. Timings are machine/cache-specific, not SLOs.
8. **Source sizes:** largest route `admin/pos/page.tsx` is 53.9 KiB/677 lines; largest tested router modules include offline 39.9 KiB/667 lines, supplier returns 43.5 KiB/443 lines, and transfers 43.0 KiB/328 lines. Database schema is 123.2 KiB/1,551 lines; seed is 28.6 KiB/485 lines.
9. **Existing Next client-reference manifest estimate:** unique raw JS chunks associated with `/admin` total about 776.6 KiB, `/admin/pos` about 417.7 KiB, `/admin/inventory/receiving` about 374.1 KiB, and `/admin/inventory/counts` about 365.9 KiB. These sums include shared chunks and are uncompressed build artifact sizes—not transfer sizes, parsed cost, or route-specific marginal bundle. Capture gzip/Brotli, cold cache, and runtime measurements before treating them as performance regressions.

### Requires measurement before changing

- Browser Core Web Vitals, time-to-interactive, hydration cost, re-render counts, long tasks, and query request waterfalls.
- Real branch data volumes, query plans, lock wait time, PGLite-vs-Postgres performance, list pagination thresholds, and offline polling cost on low-power cashier hardware.
- Actual client bundle marginal sizes after tree-shaking/code splitting and whether chart/table packages materially affect a route.
- Serial work in a transaction cannot automatically be parallelized; measure and prove independent lock/write order before changing it.

### Speculative; do not change without evidence

- Caching inventory balance, permission, price, cost, offline bootstrap, or payment data. These values are time-sensitive authorities; stale caches can violate correctness or security.
- Introducing Redis, a query/event bus, worker, microservice, or generic data cache.
- Replacing PGLite, TanStack Query, tRPC, Next.js, React, or the service worker for speed without a repeatable benchmark.

## I. Tests and characterization gaps

The existing suite is unusually strong for business invariants: 169 tests and 739 `expect` calls span 23 files at the audited baseline. Dedicated suites cover POS/order/checkout, finance, inventory issue/COGS, offline client/server sync, printing, procurement, receiving, returns, transfers, and stock counts. Database-safety tests cover isolated build, runtime sentinels, failure behavior, and repeated seed. Preserve all of them.

Before moving code, strengthen these seams:

- **Schema equivalence:** characterize the full table/column/type/default/check/index/unique/FK/relation set from a fresh isolated DB. Assert schema split emits no SQL change. Current test fixture helpers carry explicit index/bootstrap setup and can diverge.
- **Workflow/API contract:** snapshot procedure input/output shapes and status/error behavior for all stock/procurement/offline/print critical operations. Keep real transaction integration tests; do not replace them with mocked database tests.
- **Branch and role matrix:** systematic Owner/Admin/Manager/Cashier and cross-branch/location tests for every endpoint and route guard, including audit-on-denial where required.
- **Failure atomicity:** inject failing later-line, audit insert, movement insert, and balance overflow for checkout/receipt/return/transfer/count/financial workflows; assert zero partial writes and idempotent retry.
- **Historical immutability:** verify posted line and movement snapshots survive master-data edits, repeated seed, reversal and screen reorganization.
- **UI characterization:** establish browser coverage for critical entry and review flows across English LTR/Arabic RTL, keyboard/focus, narrow layout, confirmations, permission-hidden actions, loading/empty/error states and navigation. Keep screenshots/logs outside the repository until a test-artifact policy exists; do not add Playwright dependency without approval.
- **Offline protocol compatibility:** retain fixtures for older queued payload versions, dependency ordering, duplicate retries, Needs Review and mappings. Existing `offline-client.test.ts` includes source-text assertions; these are implementation-coupled and should be replaced only by equivalent public behavior tests, never simply deleted.
- **Printing bytes/layout:** preserve trusted document fields, 58/80mm, Arabic/English/bilingual output, KOT station scoping, retry/reprint classification, and acknowledgement semantics with fixtures and browser print preview checks.
- **Localization and accessibility:** message key parity, form labels/errors, table semantics, focus order, dialogs, RTL direction and keyboard-only completion.

Do not move offline sync, payment/checkout, inventory ledger/costing, schema, printing, or test DB setup until the corresponding characterization items above pass. Avoid test helpers that assert current private function call sequences; assert DB/API-visible invariants instead.

## J. Proposed minimal target structure

This is a destination for gradual moves, not a mandate to populate every directory now:

```text
apps/web/src/
  app/                         # small Next route/layout composition
  features/
    auth/ dashboard/ menu/ orders/ pos/
    finance/ printing/ offline/
    inventory/                 # ingredients, recipes, ledger, counts, transfers
    procurement/ receiving/ supplier-returns/
  server/
    auth/ database/ trpc/      # server-only adapters and router composition
  shared/
    ui/ styles/ i18n/          # real cross-feature presentation only
    quantity/ money/           # pure tested integer/rational primitives
    permissions/ audit/        # explicit server policy/write helpers
packages/db/src/
  schema/
    auth.ts branches.ts menu.ts orders.ts finance.ts printing.ts
    offline.ts inventory.ts procurement.ts relations.ts index.ts
```

Keep the current workspace packages and import aliases during migration. Use fewer modules if a domain has only one small responsibility; no module is required just to satisfy this sketch. Do not create a generic `common`, `misc`, `utils`, or all-purpose “services” folder. `receiving`, `returns`, `transfers`, and `counts` can remain feature subfolders under inventory/procurement if their ownership is explicit.

## K. Import-direction rules

1. Route files may import a feature screen and a server-only guard. They must not contain inventory/finance transactions.
2. Feature screens may import shared UI, typed feature API hooks, pure format/quantity input functions, and feature-local components. They must not import Drizzle, server DB, server auth, Node APIs, or feature router runtime implementations.
3. Router adapters validate transport input, authenticate/authorize, call a named workflow, and map output. They should not import React or route modules.
4. Feature workflows own transaction boundaries and domain sequencing. They may use shared exact math, audit/permission primitives, and DB adapters; they must not depend on Next.js routing, client storage, or UI.
5. Shared domain primitives stay pure where possible. No generic abstractions without multiple genuinely identical use cases and behavior tests.
6. Database table modules depend only on schema/domain references, never routers or workflows. Relations are assembled acyclically.
7. Offline storage/queue and trusted print-document types remain explicit adapters. They must not import mutable UI state or bypass server revalidation.
8. Keep all router output type imports in client code `import type`; avoid broad runtime exports.

## L. Staged, rollback-safe refactor plan

Every future batch is a separate commit. Land only when its listed tests pass; do not stack a structural batch on an unverified predecessor. Do not alter SQL schema or product behavior. `git revert <batch-commit>` must be a safe rollback for each batch.

## M. Exact batch scopes, risks, tests, and commit names

| Batch / exact commit message | Candidate file scope | Principal risk | Required verification before push |
|---|---|---|---|
| **1 — `test(architecture): characterize critical workflow invariants`** | Add/update only `apps/web/src/lib/trpc/routers/__tests__/{offline,financial,inventory,printing,receiving,supplier-returns,stock-transfers,stock-counts}.test.ts`, `apps/web/src/lib/trpc/routers/__tests__/offline-client.test.ts`, `apps/web/src/lib/trpc/routers/__tests__/helpers.ts`, `apps/web/src/lib/db/__tests__/{database-safety,inventory-exact}.test.ts`; add narrowly scoped tests only where a real gap is confirmed. | Test changes can accidentally weaken current expectations or encode implementation details. | Full `cd apps/web && bun test`; root `bun run check-types`; fresh isolated PGLite tests; review assertion count and prove no deleted/skip/weakened passing tests. |
| **2 — `refactor(db): split schema definitions by domain`** | New `packages/db/src/schema/{branches,menu,orders,finance,printing,offline,inventory,procurement,relations,index}.ts`; reduce `packages/db/src/schema.ts` to compatibility exports; preserve `packages/db/src/auth-schema.ts`, `packages/db/src/index.ts`, `apps/web/src/lib/db/schema.ts`, and `apps/web/drizzle.config.ts` public path. Remove a domain module from the list if it would be empty or cause a cycle. | Relation/import cycles, inadvertent SQL/index/FK change, Drizzle config selecting the wrong schema. | Batch 1 schema characterization; full typecheck/tests; compare fresh isolated pre/post table/column/type/default/check/index/FK/relations; Drizzle schema push must report no change; never use runtime DB. |
| **3 — `refactor(seed): separate deterministic domain seed steps`** | `apps/web/src/lib/db/seed.ts`, `apps/web/src/lib/db/inventory-seed.ts`, new `apps/web/src/lib/db/seed/{identity,restaurant,inventory,procurement,operations}.ts` as justified, and `apps/web/src/lib/db/__tests__/database-safety.test.ts`. Keep an explicit ordered orchestrator. | Duplicate users, branches, recipes, balances, movements, operations or audit rows; changed demo credentials or lifecycle state. | Fresh isolated schema; run seed twice on same DB; assert exact counts and unchanged stock movement/balance/financial sentinels; rerun all database-safety and domain tests. |
| **4 — `refactor(inventory): isolate exact stock ledger workflows`** | `apps/web/src/lib/inventory/{exact,service}.ts`; `apps/web/src/lib/trpc/routers/{inventory,checkout}.ts`; corresponding `inventory.test.ts`, `inventory-exact.test.ts`, `financial.test.ts`, `offline.test.ts`, and seed tests. Extract named ledger operations only; retain one transaction per current operation. | Lock order, WAC, rounding, overflow, COGS, POS trigger and offline retry behavior. | Exact conversion/rounding/WAC tests; concurrent insufficient-stock and negative-stock tests; POS COGS/history; offline sync stock tests; all financial/inventory tests; no float-based persisted math. |
| **5 — `refactor(auth): centralize branch permission checks`** | `apps/web/src/lib/permissions.ts`; `apps/web/src/lib/auth-guard.ts`; server guards in `apps/web/src/app/admin/inventory/{receiving,returns,transfers}/layout.tsx`; router permission tests in `apps/web/src/lib/trpc/routers/__tests__/{auth,procurement,receiving,supplier-returns,stock-transfers,stock-counts}.test.ts`. Add named authorization/audit helper only if event semantics remain explicit. | Permission widening, leaking costs/expected count values, cross-branch access, missing denial audits. | Role matrix for each endpoint/page; Owner/Admin/Manager/Cashier and inactive/cross-branch assignments; expected cost/variance visibility; audit rows/reasons unchanged; full suite. |
| **6 — `refactor(offline): separate bootstrap and synchronization workflows`** | `apps/web/src/lib/trpc/routers/offline.ts`; new offline router/workflow files under `apps/web/src/lib/trpc/routers/offline/`; `apps/web/src/lib/offline/{queue,storage,types,documents}.ts`; `apps/web/src/components/offline/{offline-provider,offline-receipt-action}.tsx`; POS/sync route adapters; `offline.test.ts` and `offline-client.test.ts`. | Highest blast radius: offline queue compatibility, payment idempotency, immutable Needs Review, service-worker shell boundary, print snapshots. | Old/new payload fixtures; duplicate/concurrent sync; permission change, mapping, review, payments and stock assertions; browser offline/online resumption; storage upgrade tests; full POS/printing/finance regression. |
| **7 — `refactor(api): extract purchasing and stock workflows`** | In isolated follow-up commits, split `procurement.ts`, `receiving.ts`, `supplier-returns.ts`, `stock-transfers.ts`, `stock-counts.ts` into a router adapter and named workflow modules; update only their test files and `router.ts` registration as required. Keep each feature in a separate commit with the exact message `refactor(api): extract <feature> workflows` (`purchasing`, `receiving`, `supplier-returns`, `stock-transfers`, `stock-counts`). | Immutable snapshots, API schemas, transaction atomicity, idempotency, movement lineage, concurrency/watermarks, branch scopes. | Per-feature full direct-caller suite; concurrent retries; failure injection with zero partial rows; schema/API shape snapshots; movement/balance/WAC/audit comparisons; build and all regressions after each feature. |
| **8 — `refactor(api): isolate financial and print workflows`** | `apps/web/src/lib/trpc/routers/{checkout,orders,shifts,transactions,printing}.ts`; `apps/web/src/lib/{finance,orders/lifecycle,printing/documents}.ts`; `apps/web/src/app/print/[jobId]/page.tsx`, `offline-print/[documentId]/page.tsx`; associated financial/printing/order tests. Split by explicit transaction/document responsibility, not class hierarchy. | Payment and refund ledger immutability, drawer math, document authenticity, KOT station privacy and print status transitions. | Existing finance/POS/print tests plus immutable document field fixtures, retries/reprints, 58/80mm Arabic/bilingual rendering and browser print preview. |
| **9 — `refactor(ui): extract POS screen from route component`** | `apps/web/src/app/admin/pos/page.tsx`; new `apps/web/src/features/pos/{PosScreen,components,hooks}.tsx` limited to real seams; existing cart/offline pure modules stay where they are until later approved moves. | Checkout totals, discount reason, stock availability, online/offline paths, touch/keyboard behavior. | Desktop/touch browser flows; online checkout and offline queued cash sales; sync retry/review; printing/KOT; Arabic RTL/English LTR; screenshot comparison; no new client server imports. |
| **10 — `refactor(ui): compose inventory routes from feature screens`** | `apps/web/src/app/admin/inventory/**/page.tsx`, relevant route layouts, `apps/web/src/components/inventory/inventory-nav.tsx`; new feature-local screens/components under `apps/web/src/features/{inventory,procurement,receiving,supplier-returns,transfers,stock-counts}/`. Keep API and exact functions untouched. | Screen auth/action visibility, snapshots and monetary display, history access, search/filter, responsive/RTL flow. | Existing inventory/procurement/receiving/returns/transfers/count tests; route permissions; English/Arabic browser workflows, keyboard/focus, mobile widths, visual comparison; all APIs unchanged. |
| **11 — `refactor(ui): centralize design tokens and form primitives`** | `apps/web/src/app/globals.css`, `packages/ui/src/styles/globals.css`, `packages/ui/src/components/{button,input,label,form-text-field,table,data-table,dialog,badge,search-filter}.tsx`, `apps/web/components.json`, affected feature screens only to adopt current-equivalent primitives. | Accidental visual redesign, Tailwind scanning/build changes, RTL geometry, form accessibility regressions. | Before/after desktop/mobile screenshot comparison for high-use routes, contrast/focus/keyboard checks, both locales, route build output and no behavior/API/database diff. |
| **12 — `refactor(imports): remove confirmed obsolete exports`** | Candidate-only, after usage search: `apps/web/src/lib/db/schema.ts`, `packages/db/src/index.ts`, `packages/db/package.json`, `apps/web/src/lib/trpc/router.ts`, and any specific export proven unused. Investigate `apps/web/schema.sql` separately; do not delete it until external use is ruled out. | Consumers outside repository, generated API/schema compatibility, type-only dependencies. | `rg` import audit; workspace typecheck/build; package export smoke test; tests and SQL equivalence; no public route/schema changes. |
| **13 — `perf(inventory): batch evidenced ledger reads safely`** | Only measured query paths in `apps/web/src/lib/inventory/service.ts`, `apps/web/src/lib/trpc/routers/{stock-counts,supplier-returns,stock-transfers}.ts` and focused tests/bench scripts outside runtime data. | Lock ordering, stale snapshot detection, branch-scope leakage, out-of-order WAC, hidden full-list data. | Before/after SQL statement counts, representative isolated data load/query plan, concurrent stock tests, exact movement/balance/audit snapshot equality, PGLite and (if later authorized) PostgreSQL integration tests. |
| **14 — `test(architecture): verify refactor compatibility boundaries`** | Test-only updates under `apps/web/src/lib/{db,trpc/routers}/__tests__/**` plus approved browser-test documentation/artifacts policy; no app behavior changes. | False confidence from only unit tests or changed baselines. | Full typecheck, test suite, fresh schema/seed twice, production build, all critical browser journeys, offline resumption and print checks; manual branch/diff/clean-worktree review before push. |

If Batch 7 is implemented, each feature extraction is its own commit; valid exact examples are `refactor(api): extract receiving workflows` and `refactor(api): extract stock-count workflows`. Do not combine multiple numbered batches into a “cleanup” commit.

## N. Areas that must not move before stronger tests exist

- Checkout/payment/discount/cancellation/refund transactions and expected-cash calculations.
- Recipe resolution, inventory issue timing, balance locks, negative-stock override, WAC and COGS snapshots.
- Offline persisted queue shape, IndexedDB versions, operation IDs/order, price snapshot validation, synchronization retries and Needs Review resolution.
- Trusted online/offline receipt and KOT data, station scoping, acknowledgement/reprint state.
- Receiving/return/transfer/count posting and reversal transaction bodies, movement type/source links, line snapshots, idempotency keys, lock order and audit.
- `packages/db` constraints/relations, status enums, delete rules, partial unique indexes, and any persisted integer scale.
- `scripts/build.ts`, database role/dir safety, seed ordering/idempotency, and `reset-db.ts` safety confirmations.
- Cashier/Manager/Owner/Admin permission matrices, cost/variance visibility, and branch/location filters.

Do not convert append-only history into updates/deletes, “simplify” test fixtures by removing constraints, introduce floating-point persisted quantities/money, or make a stale cache authoritative.

## O. Patterns and abstractions not to introduce

Do not add CQRS, event bus, DI containers, workflow/state-machine engines, microservices, plugin registries, abstract factories, repositories for every table, a universal form/table/dialog with dozens of unrelated props, arbitrary file-length limits, generic dumping-ground modules, new UI library, broad barrels, or framework replacement. Do not parallelize work inside protected transactions merely to reduce wall time. Do not cache money, permissions, stock, costs or offline state without a freshness/authority proof. Prefer direct functions and one feature-owned workflow per real transaction boundary.

## P. Upgrade/removal readiness, expected benefits, and remaining risks

### Upgrade and removal readiness

- **Next.js/React/TanStack/tRPC:** app-router/client-heavy screens create moderate-to-high upgrade effort. Root provider placement and large client components are the principal surface. Upgrade only with route/browser coverage and lockfile diff review.
- **Bun/Turbo:** scripts and `packageManager` are explicit and currently verified. Turbo passes database env variables through; preserve this and avoid package-script workarounds. Build isolation tests should run as release gates.
- **Drizzle/Better Auth:** single schema and auth schema couple generated types, adapter and PGLite tests. Schema compatibility and Better Auth table naming/relations need dedicated tests before package upgrades.
- **UI replacement/redesign:** possible after route/screen/data separation and a single design-token owner; currently many screens combine mutations/calculations with JSX and repeated inline classes.
- **Remove offline:** high difficulty. Root provider, POS page, service worker, queue/storage, sync router, server reconciliation, offline print, and test scenarios cross several modules. Introduce explicit interfaces only at current durable-storage/network boundaries; removal requires migration/queue-loss policy approval.
- **Remove procurement subfeature/counts:** high data risk. Supplier/PO/receipt/return/count history links into `stock_movements`, balances and audits. Hide/disable behavior is distinct from schema/history removal. Never drop historical tables without a separately approved archival/data migration.
- **Replace printing:** moderate-to-high coupling. Trusted document construction is shared by online and offline print; replace the transport/adapter, not document authority or KOT scoping.
- **PGLite to PostgreSQL:** moderate-to-high deployment/data risk despite PostgreSQL dialect. Current runtime adapter and safety/build scripts are PGLite-specific; `prepare-prod.ts` performs direct destructive source rewrites and is not an audited migration path. Require a separate design, real PostgreSQL integration/lock tests, backup/restore plan, schema parity, data migration, auth/session verification, offline/print smoke tests, and rollback rehearsal.

### Expected benefits

- New developers can locate a route, feature screen, API adapter, workflow, and schema without tracing one giant file.
- Schema and seed review becomes domain-scoped without changing persisted structure or deterministic data.
- High-risk transactions become smaller, named, and independently characterized while preserving one clear transaction boundary.
- Visual redesign can replace screen components and token values without touching stock, finance, offline or print calculations.
- Performance work can be directed by repeatable request/query/bundle measurements instead of speculative caching.
- Framework/library upgrades become bounded by explicit contracts and end-to-end tests.

### Remaining risks and release gates

Structural movement can still alter import evaluation, Drizzle relations, Next client/server boundaries, tree shaking, RSC behavior, seed order, or transaction lock order without obvious type errors. Require clean commits, no SQL diff, regression tests, isolated DB verification, screenshots and traces for critical UI, no direct runtime DB access, and no force push. Push each verified commit only to `refactor/codebase-simplification`; do not merge or open a PR without explicit approval. Phase 4A ends with this audit; Phase 4B implementation is not authorized by this document.
