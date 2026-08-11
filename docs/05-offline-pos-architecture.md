# Offline POS architecture — Phase 2B2B

## Browser boundary

- The service worker caches only the POS application shell and versioned static assets. API, authentication, and customer/financial responses are network-only.
- Versioned IndexedDB stores the minimum server-authorized bootstrap snapshot, durable queue records, and provisional KOT/order-summary documents. It never stores credentials, tokens, cookies, secrets, or internal audit metadata.
- A snapshot is scoped to user and branch and contains the selected register, confirmed active shift, role permissions, menu structure, stations, tables, and printing preferences. It has a revision, creation/stale timestamps, and a hard expiry.
- Queue records have stable client operation IDs and idempotency keys, explicit dependencies, retry metadata, acknowledgement mappings, and retained Failed/Needs Review states.
- Web Locks elect one synchronization leader across tabs; a short local-storage lease is the compatibility fallback.

## Server authority and recovery

- Every synchronization call revalidates user/branch/role, shift/register, table, menu/variant/modifier/station availability. Non-cash orders use current server prices; offline cash sales use the immutable, unexpired server-issued price snapshot so the authoritative total exactly matches the cash receipt handed to the customer.
- Order creation, cash checkout, payment, transaction, status history, audits, KOT jobs, receipt job, and offline acknowledgement are committed atomically where financial integrity requires it.
- Offline KOTs are deterministic per local order and station and contain no financial fields. Before cash acceptance the customer document is an unpaid provisional summary. Cash acceptance atomically freezes a separate immutable Offline Cash Receipt with tendered cash, change, items, prices, checkout time, and a collision-resistant external reference. It states that cash was received offline and that server synchronization is pending; it never claims an authoritative server receipt number.
- Financial conflicts are durable `offline_sync_records` in Needs Review. Manager or Owner/Admin resolution requires an audit reason and triggers full server revalidation; it never deletes the local cash record.
- Logout is blocked while unsynchronized financial operations remain. Connected POS behavior continues through the existing online order and checkout APIs.

## Supported boundary

Offline creation covers dine-in, takeaway, and delivery orders, variants, modifiers, quantities, kitchen notes, station KOT previews, and cash-only checkout with estimated change. Card, InstaPay, split payments, discounts, shift changes, drawer adjustments, cancellation, refunds/reversals, reprints, and configuration changes remain online-only and are explained bilingually in the POS.

## Offline cash receipt integrity

- Bootstrap issues a random opaque price-snapshot reference backed by the immutable `offline_price_snapshots` ledger. The configurable `FORNO_OFFLINE_PRICE_SNAPSHOT_TTL_MS` is clamped between five minutes and seven days, and its expiry is visible before checkout.
- The browser stores a device instance identifier in IndexedDB and derives the human receipt reference from branch, register, device, checkout idempotency key, and local checkout date using SHA-256. Reloads and retries reuse the stored reference and immutable document.
- Cash checkout replaces the still-pending local order operation with one atomic financial operation. Synchronization validates the receipt identity, snapshot scope/revision/expiry, totals, tendered cash, and change before creating any server row.
- `offline_sync_records` retains the printed receipt values and review reason. Missing, expired, foreign, or tampered snapshots/receipts enter Needs Review and are never silently removed.
- Opening the offline preview records only a deterministic preview state for later audit. It never asserts that paper was physically produced and never triggers an automatic second print after synchronization.
- The final paid receipt and Order Details show the offline receipt reference, while the Sync Center clearly separates the local offline receipt from the authoritative final receipt.

## Phase 3A availability and stock issue

- The authorized bootstrap snapshot carries a branch-scoped availability revision and cached per-menu/variant state (`in_stock`, `low_stock`, `out_of_stock`, `recipe_missing`, or `stock_unavailable`) with maximum producible quantity. Snapshot age remains visible offline; cached availability is advisory and contains no ingredient cost for cashiers.
- Synchronization re-resolves the active immutable recipe and selected modifier deltas, locks current balances, and issues all stations' ingredients in the same transaction as the authoritative order and cash checkout. Operation, order, issue, payment, KOT, and receipt idempotency keys prevent duplicate consumption after interruption or retry.
- Insufficient stock, missing recipes, or unavailable stock data never discard an offline cash receipt. They create a financial Needs Review record. A Manager or Owner/Admin may resolve it with a mandatory audit reason; revalidation can then honor the sale through the configured negative-stock override, preserving exactly one issue and the original printed cash values.
