# Offline POS architecture — Phase 2B2B

## Browser boundary

- The service worker caches only the POS application shell and versioned static assets. API, authentication, and customer/financial responses are network-only.
- Versioned IndexedDB stores the minimum server-authorized bootstrap snapshot, durable queue records, and provisional KOT/order-summary documents. It never stores credentials, tokens, cookies, secrets, or internal audit metadata.
- A snapshot is scoped to user and branch and contains the selected register, confirmed active shift, role permissions, menu structure, stations, tables, and printing preferences. It has a revision, creation/stale timestamps, and a hard expiry.
- Queue records have stable client operation IDs and idempotency keys, explicit dependencies, retry metadata, acknowledgement mappings, and retained Failed/Needs Review states.
- Web Locks elect one synchronization leader across tabs; a short local-storage lease is the compatibility fallback.

## Server authority and recovery

- Every synchronization call revalidates user/branch/role, shift/register, table, menu/variant/modifier/station availability and recalculates all prices, payments, and change.
- Order creation, cash checkout, payment, transaction, status history, audits, KOT jobs, receipt job, and offline acknowledgement are committed atomically where financial integrity requires it.
- Offline KOTs are deterministic per local order and station and contain no financial fields. The only offline customer document is explicitly an unpaid provisional summary. A paid receipt exists only after authoritative checkout acceptance.
- Financial conflicts are durable `offline_sync_records` in Needs Review. Manager or Owner/Admin resolution requires an audit reason and triggers full server revalidation; it never deletes the local cash record.
- Logout is blocked while unsynchronized financial operations remain. Connected POS behavior continues through the existing online order and checkout APIs.

## Supported boundary

Offline creation covers dine-in, takeaway, and delivery orders, variants, modifiers, quantities, kitchen notes, station KOT previews, and cash-only checkout with estimated change. Card, InstaPay, split payments, discounts, shift changes, drawer adjustments, cancellation, refunds/reversals, reprints, and configuration changes remain online-only and are explained bilingually in the POS.
