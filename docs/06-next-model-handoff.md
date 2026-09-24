# FORNO Restaurant OS Next-Model Handoff

This file is a compact but complete handoff for continuing FORNO Restaurant OS with another model or agent. It records the current repository state, what has already been implemented, verification results, known operational warnings, and the working approach that was used.

## Repository State

```text
Project: FORNO Restaurant OS
Local path: B:\downloads\FORNO-Restaurant-System-v0.1 (1)
GitHub: https://github.com/belalhazem511/FORNO-Restaurant-OS
Branch: main
Current HEAD: 14d15b6b5a2c4baef8ec36f713e54725f82026c4
Latest commit: docs: add real project screenshots
Remote: origin/main
Working tree at handoff time: clean
```

FORNO Restaurant OS is a bilingual Arabic RTL and English restaurant operating system. It started from the MIT-licensed FinOpenPOS base and has been refocused for Egyptian restaurant operations.

## Stack

- Next.js 16
- React 19
- TypeScript
- Bun workspaces
- Better Auth
- Drizzle ORM
- PGLite for local development and isolated tests
- PostgreSQL-compatible schema direction
- IndexedDB and service worker for offline POS
- tRPC-style application routers

## Main Structure

```text
apps/web       Web app, POS UI, admin pages, APIs, DB runtime, tests
packages/api   Shared API contracts
packages/auth  Auth helpers
packages/db    DB schema exports
packages/env   Environment config
packages/ui    Shared UI components
docs           Product docs, roadmap, architecture, database safety, handoff
```

## Existing Product Scope

The system currently includes:

- Authentication with seeded admin login.
- Admin layout and navigation.
- Arabic RTL and English UI.
- Branch-scoped restaurant setup.
- User roles and permission checks.
- POS menu categories, items, variants, and modifiers.
- Dine-in, takeaway, and delivery orders.
- Customer, dining area, and table support.
- Orders list and order details.
- Cashier shifts.
- Cash checkout.
- Financial records.
- Refunds and reversals.
- Paid and unpaid cancellation controls.
- Audit trail.
- Database-safety implementation around PGLite.
- Seed data for FORNO demo operation.
- Thermal receipt and KOT printing.
- Offline POS and synchronization.
- Immediate offline cash receipt printing.
- Recipe-driven inventory foundations.

Seeded admin account:

```text
Email: admin@forno.local
Password: Forno123!
```

Change seeded credentials and secrets before real deployment.

## Important Runtime Database Warning

The original runtime PGLite database at this path showed corruption or validation failures:

```text
apps/web/data/pglite
```

Do not delete, reset, or recreate it automatically. It was intentionally preserved.

When development needed a working database, an isolated test/development database was used:

```powershell
$env:FORNO_DATABASE_DIR = Join-Path $env:TEMP "forno-dev-runtime-20260811"
$env:FORNO_DATABASE_ROLE = "test"
bun run db:push
bun run db:seed
bun run dev
```

The app was reachable at:

```text
http://127.0.0.1:3001/login
```

## Database-Safety Guarantees

Preserve these rules:

- Builds must not open, migrate, seed, reset, or modify runtime databases.
- Server startup must not auto-migrate or auto-seed.
- Schema application is explicit through `bun run db:push`.
- Seed is explicit through `bun run db:seed`.
- Tests and builds use isolated PGLite paths.
- Runtime databases are never automatically deleted or recreated.
- Existing PGLite data is preserved on errors.
- Financial, audit, and inventory history must remain immutable or append-only.
- Corrections use explicit reversal or adjustment records.

## Major Commits

```text
d5af49e fix: prevent automatic PGLite data loss
6ccd823 feat: add thermal receipt and kot printing
1b5741e fix: print offline cash receipts
9db8118 feat: add recipe-driven inventory
cc90a6e docs: expand github project overview
14d15b6 docs: add real project screenshots
```

## Completed Phase 2B2A: Thermal Receipt And KOT Printing

Commit:

```text
6ccd823e74c387deda7143d4a27d857f9f80607
feat: add thermal receipt and kot printing
```

Implemented:

- Customer thermal receipts.
- Kitchen order tickets.
- Station-specific KOT routing.
- Pizza, Doner, and Cafe station separation.
- No financial information on KOTs.
- Print job handling and idempotency.
- Receipt and KOT print preview behavior.
- Bilingual receipt and KOT support.
- Audit-safe print job behavior.

## Completed Phase 2B2B: Offline POS Synchronization

Commit:

```text
392e4e2bd6db7c7703f1e7e8e106b05490f305ec
feat: add offline pos synchronization
```

Implemented:

- PWA application shell.
- Service worker app shell and asset caching.
- Versioned IndexedDB offline database.
- Cached server-authorized POS bootstrap snapshot.
- Snapshot age and revision warnings.
- Real server health check in addition to `navigator.onLine`.
- Online, Offline, Syncing, Synced, Failed, and Needs Review states.
- Durable offline queue.
- Dependency ordering between order creation, cash checkout, KOT acknowledgement, and receipt/print acknowledgement.
- Idempotent retry keys.
- Exponential backoff with jitter.
- Manual retry.
- Retry classification.
- Server acknowledgement before archive or cleanup.
- Local ID to authoritative server ID mapping.
- Single synchronization leader across tabs.
- Multi-tab duplicate sync protection.
- Safe recovery after interrupted synchronization.
- Sync Center UI.
- Conflict and Needs Review UI.
- Branch, user, and permission isolation.
- Offline order summary.
- Offline KOT previews.
- Offline cash checkout support.
- Unsupported offline actions blocked with bilingual explanation.

Supported offline operations:

- Create Dine-in, Takeaway, and Delivery orders.
- Use quantities, variants, modifiers, and kitchen notes.
- Generate local client request IDs and idempotency keys.
- Cash-only checkout.
- Cash received and estimated change.
- Station-routed offline KOT previews.
- Offline order summary.

Blocked while offline:

- Card payments.
- InstaPay.
- Split payments.
- Opening or closing shifts.
- Cash drawer adjustments.
- Discounts.
- Refunds and reversals.
- Paid or unpaid cancellation.
- Receipt or KOT reprints.
- Permission or configuration changes.

Server authority:

- Server reprices all orders.
- Server revalidates branch, user, role, shift, register, table, menu availability, variants, modifiers, and stations.
- Server never trusts cached client totals or cached permissions.
- Duplicate retries must not create duplicate orders, payments, receipts, KOT jobs, stock movements, or audit records.
- Unresolved financial conflicts move to Needs Review.

## Offline Cash Receipt Follow-Up

Commit:

```text
1b5741ee41b97a16e0bdf95f9cc8c85f81ec4482
fix: print offline cash receipts
```

Implemented:

- Immediate `Print Offline Cash Receipt` action after offline cash checkout.
- Browser print preview while offline.
- 80 mm thermal layout by default.
- Optional 58 mm layout.
- Arabic, English, and bilingual output.
- Register copy count support.
- Popup-blocked and printer guidance.
- Immutable local receipt snapshot created when cash is accepted.
- Snapshot survives refresh, browser restart, POS navigation, and interrupted sync.
- Deterministic human-readable offline receipt number.
- Offline receipt external reference preserved through sync.
- Final receipt maps back to offline receipt reference.
- No automatic second receipt print after sync.
- Offline initial print acknowledgement queued for later audit sync.
- No secrets, DB IDs, tokens, audit metadata, or unnecessary customer data exposed.

Offline receipt status:

```text
CASH RECEIVED - OFFLINE
PENDING SERVER SYNCHRONIZATION
```

Important behavior:

- Offline cash receipt is not labelled unpaid.
- It is not labelled final, server-synchronized, or fiscal before server acknowledgement.
- Printed local values remain immutable.
- Tampered, expired, or missing snapshot references are rejected or moved to Needs Review.
- Needs Review preserves original printed values and requires a manager or admin reason.

## Completed Phase 3A: Recipe-Driven Inventory

Commit:

```text
9db8118853b48f5de18949b7776451ea924ef6cd
feat: add recipe-driven inventory
```

Implemented inventory domain:

- Inventory locations:
  - Main Store
  - Pizza Kitchen
  - Doner Kitchen
  - Cafe Bar
- Ingredient categories.
- Ingredients.
- Units of measure.
- Ingredient package conversions.
- Opening balances.
- Immutable stock movements.
- Current stock balances.
- Low-stock and out-of-stock thresholds.
- Moving weighted-average cost.
- Recipe versions and components.
- Order-level consumption snapshots.
- Order-item COGS snapshots.

Exact quantity model:

- Persisted stock math does not use JavaScript floating point.
- Quantities use fixed-point integers.
- Conversions use exact rational factors:
  - numerator
  - denominator
- Rounding is deterministic.
- Conversion factors must be positive.
- Incompatible dimensions are rejected.
- Money remains integer minor units.

Supported dimensions:

```text
Mass: milligram, gram, kilogram
Volume: millilitre, litre
Count: piece
Packages: bag, bottle, can, box, tray, carton, ingredient-specific
```

Ingredients support:

- Branch.
- Category.
- Arabic and English name.
- Unique branch SKU/code.
- Base unit and measurement dimension.
- Default inventory location.
- Active/inactive state.
- Tracked/untracked inventory.
- Reorder level.
- Low-stock threshold.
- Optional par level.
- Negative stock allowed flag.
- Moving weighted-average unit cost.
- Create/update metadata.
- Archive instead of delete when historical dependencies exist.

Recipes support:

- Menu item base components.
- Variant-specific components or deltas.
- Modifier option components or deltas.
- Size differences.
- Cheese and extras effects.
- Quantities and units.
- Source location.
- Version number.
- Effective time.
- Draft and active states.
- Author and approval metadata.
- Yield or prep loss in basis points.
- Historical immutability.
- Recipe completeness reporting.
- Missing recipe warnings.

Stock movement ledger:

- Append-only.
- Opening balance.
- Manual positive adjustment.
- Manual negative adjustment.
- Sale consumption.
- Sale consumption reversal.
- Waste or discard.
- Manager-authorized negative-stock override.
- Idempotency key.
- Branch, location, ingredient, user, reason, source, order, order item, and recipe version fields.
- Current balance projection updated transactionally.

Order lifecycle integration:

- Pending carts do not consume stock.
- Payment alone does not consume stock.
- Stock deducts exactly once when order first enters kitchen/production.
- Dine-in orders paid later still consume when sent to kitchen.
- Takeaway and Delivery use the same production rule.
- Variants and modifiers affect consumption.
- Quantities multiply exactly.
- Retried APIs and offline sync do not duplicate consumption.
- Multi-station orders consume atomically.
- Recipe changes after an order do not affect historical consumption.
- Refunds and reversals do not automatically restore inventory.

Cancellation inventory behavior:

- Before stock issue: no inventory movement.
- After stock issue: explicit disposition required.
- Returned unused: exact reversal movement.
- Prepared or discarded: waste record with no stock restoration.
- Reason and authorized user required.
- Financial cancellation behavior remains separate.

Availability and overselling:

- Current on-hand calculation.
- Maximum producible quantity.
- In stock, Low stock, Out of stock, Recipe missing, and Stock data unavailable states.
- Online order confirmation blocks insufficient tracked stock by default.
- Manager or Owner override requires permission and reason.
- Cashier override denied.
- Offline snapshot includes availability revision.
- Offline sync revalidates stock.
- Insufficient stock during sync moves to Needs Review.
- Manager can honor with audited negative-stock override.
- Sync retries do not duplicate stock movements.

Costing:

- Moving weighted-average cost.
- Opening balance and positive adjustment require trusted unit cost.
- Ingredient on-hand value.
- Recipe theoretical cost.
- Menu item and variant COGS.
- Modifier incremental cost.
- Order item COGS snapshot.
- Order total COGS snapshot.
- Theoretical gross margin preview.
- Historical COGS remains immutable.

Permissions:

- Owner/Admin:
  - full inventory configuration
  - ingredient and recipe management
  - opening balances and adjustments
  - negative-stock override
  - cost and valuation visibility
- Manager:
  - operational inventory and recipe access
  - authorized adjustments with reasons
  - cancellation disposition
  - negative-stock override if granted
- Cashier:
  - POS availability only
  - no cost or valuation visibility
  - no recipe editing
  - no stock adjustments or overrides

Audit records were added for:

- Ingredient changes.
- Recipe creation, approval, activation, and retirement.
- Opening balances.
- Adjustments.
- Cancellation disposition.
- Negative-stock override.
- Sensitive cost correction.

Inventory UI pages:

- Inventory overview.
- Ingredients.
- Ingredient details.
- Opening balances and adjustments.
- Stock movement history.
- Low-stock and out-of-stock views.
- Recipe builder.
- Recipe version history.
- Menu recipe completeness.
- Theoretical menu cost and producible quantity.

Seed data:

- Ingredient categories.
- Locations.
- Units and conversions.
- Opening stock.
- Unit costs.
- Thresholds.
- Active recipes.
- Variant and modifier recipe effects.
- Pizza dough/flour, pizza sauce, mozzarella, toppings, extras.
- Doner meat, bread, vegetables, sauce.
- Coffee beans, milk, cafe extras.
- Packaging.

## Phase 3A Verification

Previously completed:

```text
bun run check-types: passed
cd apps/web && bun test: passed
bun run build: passed with isolated PGLite path
git diff --check: passed
Seed twice against isolated DB: passed and idempotent
```

Test result:

```text
140 tests passed
527 assertions
18 test files
```

Browser smoke tests passed using local Edge or Chromium fallback:

- Inventory dashboard with seeded stock.
- Ingredient creation and opening balance.
- Recipe creation and activation.
- Pizza exact ingredient deduction.
- Doner exact ingredient deduction.
- Cafe exact ingredient deduction.
- Variant and modifier consumption.
- Multi-station atomic consumption.
- Low-stock warning.
- Out-of-stock order blocking.
- Cashier override rejection.
- Manager override with reason and audit.
- Cancellation returned-unused reversal.
- Cancellation prepared/discarded waste.
- Ingredient cost.
- Recipe cost.
- Immutable order COGS.
- Offline cash synchronization consuming stock exactly once.
- Arabic RTL and English UI.

## Completed Phase 3B1: Suppliers And Purchase Orders

Phase 3B1 is implemented in the current working tree. It adds branch-scoped supplier master data, supplier archiving, exact-quantity purchase-order lines, server-calculated EGP totals, draft/submitted/approved/cancelled lifecycle controls, role permissions, audit records, bilingual inventory navigation and pages, seed examples, and isolated router tests.

Purchase orders are still inventory-neutral until a receipt is explicitly posted. Purchase-order authorization (`draft`, `submitted`, `approved`, `cancelled`) is separate from receiving progress (`not_received`, `partially_received`, `fully_received`).

## Completed Phase 3B2A: Purchase Order Receiving

Phase 3B2A adds branch-scoped goods receipt notes for approved purchase orders. `purchase_receipts`, `purchase_receipt_lines`, and append-only `purchase_receipt_reversals` retain supplier, PO, destination, delivery-note/invoice, user, quantity, price, ingredient, and rational package-conversion snapshots. Receipt numbers are unique per branch.

Drafts do not affect inventory. Posting locks the PO and inventory balances, validates remaining accepted quantities and any authorized overrides, then atomically writes accepted-quantity `purchase_receipt` movements and updates stock balances with the shared exact moving-weighted-average calculation. Rejected and damaged quantities remain recorded without increasing stock. Duplicate posting is idempotent. A later inventory movement or insufficient stock blocks automatic reversal and records `needs_review`; a safe reversal restores its captured prior balance/cost and appends reversal movements without editing the original receipt.

Owner/Admin can approve significant price variance, over-receiving, and reversal. Managers can perform operational receiving and the explicitly granted over-receiving override; Cashiers have neither receiving APIs nor receiving pages. English LTR and Arabic RTL receiving, receipt history, snapshots, and draft editing are available. Receiving is online-only and does not implement supplier returns.

Phase 3B2B supplier returns, transfers/counts/waste, reporting, and all later phases remain deferred.

## GitHub README And Assets

The README was rewritten into a professional project page. It now explains:

- Product purpose.
- Completed phases.
- POS and kitchen flow.
- Offline synchronization.
- Offline cash receipts.
- Inventory and recipe foundations.
- Quantity and cost model.
- Security and database safety.
- Setup.
- Useful commands.
- Documentation links.
- Verification snapshot.
- Deferred work.

SVG diagrams added:

```text
docs/assets/forno-platform-overview.svg
docs/assets/offline-sync-flow.svg
docs/assets/offline-cash-receipt.svg
docs/assets/inventory-recipe-flow.svg
```

Real screenshots captured from the running app and committed:

```text
docs/screenshots/01-login.png
docs/screenshots/02-admin-dashboard.png
docs/screenshots/03-pos.png
docs/screenshots/04-sync-center.png
docs/screenshots/05-inventory-overview.png
docs/screenshots/06-ingredients.png
docs/screenshots/07-recipes.png
docs/screenshots/08-stock-movements.png
docs/screenshots/09-orders.png
```

Latest documentation commits:

```text
cc90a6e docs: expand github project overview
14d15b6 docs: add real project screenshots
```

## Useful Commands For The Next Model

Check status:

```powershell
git status --short --branch
git log -1 --oneline
```

Run with an isolated database:

```powershell
$env:FORNO_DATABASE_DIR = Join-Path $env:TEMP "forno-dev-runtime-20260811"
$env:FORNO_DATABASE_ROLE = "test"
bun run db:push
bun run db:seed
bun run dev
```

Verification:

```bash
bun run check-types
cd apps/web && bun test
bun run build
git diff --check
```

## Explicitly Deferred Work

Do not implement these unless the user explicitly asks:

- Supplier returns (Phase 3B2B).
- Stock transfers.
- Full stock counts.
- Forecasting.
- Full profit and loss accounting.
- Public website.
- Delivery marketplace integrations.
- Later inventory/accounting/reporting phases.

## How I Worked

The working style used on this project:

- Inspect the repo state before editing:
  - `git status --short --branch`
  - `git log -1 --oneline`
  - relevant file reads/searches
- Preserve existing completed work.
- Do not reset, revert, delete, or recreate user data unless explicitly requested.
- Treat dirty worktree changes as user-owned unless they are clearly generated by the current task.
- Use focused commits with clear messages.
- Run verification proportional to the risk of the change.
- Use isolated PGLite database paths for builds, tests, and smoke checks.
- Never rely on runtime DB mutation during build/startup.
- When browser evidence is requested, use a real browser and do not claim tests passed unless actually performed.
- When local browser extension control fails, use Playwright or installed Edge/Chrome as the fallback.
- For documentation-only updates, verify with `git diff --check`, then commit and push.
- For product changes, run:
  - type checks
  - web tests
  - production build
  - seed idempotency
  - browser smoke tests when requested
- Report exact commit hashes and any limitations.

## How To Think About This Codebase

Key mental model:

- The server is authoritative.
- Offline client data is useful for continuity, but untrusted during synchronization.
- Financial records are immutable.
- Audit history is mandatory for sensitive operations.
- Inventory movements are append-only.
- Historical recipe, stock, and COGS snapshots must not be rewritten by later changes.
- PGLite runtime data must be protected from accidental automation.
- Branch isolation and permission checks belong on the server.
- Idempotency is required anywhere retries or offline synchronization can happen.

Important design boundaries:

- Payment is not the inventory trigger.
- Kitchen/production confirmation is the inventory trigger.
- Refunds do not automatically restore ingredients.
- Offline cash sales are never silently discarded.
- Offline receipts are not final server receipts.
- Offline KOTs must not show prices.
- Manager/Admin recovery workflows must preserve original financial facts.

When adding new features, first identify:

- Which branch owns the data.
- Which role can perform the action.
- Whether the action creates immutable history.
- Whether idempotency is required.
- Whether offline sync can retry it.
- Whether PGLite safety rules are affected.
- Whether seed/build/test paths remain isolated.

## Final Handoff State

```text
HEAD: 14d15b6b5a2c4baef8ec36f713e54725f82026c4
Branch: main
Remote: origin/main
Working tree before creating this handoff file: clean
GitHub before creating this handoff file: pushed
```
