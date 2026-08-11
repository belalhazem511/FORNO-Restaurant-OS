# FORNO Restaurant OS

FORNO Restaurant OS is a full-stack restaurant operations platform for dine-in, takeaway, delivery, cashier workflows, kitchen production, offline POS continuity, and recipe-driven inventory foundations.

نظام FORNO Restaurant OS هو منصة تشغيل متكاملة للمطاعم تدعم الكاشير، الطلبات، المطبخ، الطباعة، العمل دون اتصال، وإدارة المخزون المعتمدة على الوصفات.

## Current Capabilities

- POS workflows for dine-in, takeaway, and delivery orders.
- Cashier shifts, cash payments, financial history, refunds, reversals, and audit records.
- Thermal receipt and station-routed KOT printing for Pizza, Doner, and Cafe stations.
- Offline POS mode with durable IndexedDB queueing, PWA shell, synchronization recovery, and offline cash receipts.
- Recipe-driven inventory foundations with ingredients, units, conversions, stock movements, balances, recipe versions, and theoretical COGS.
- Branch-scoped permissions, bilingual Arabic RTL and English UI, and Egyptian pound pricing.
- Local PGLite development database with a production path toward PostgreSQL.

## Technology

- Next.js 16, React 19, and TypeScript.
- Bun workspace tooling.
- tRPC-style application APIs.
- Drizzle ORM with PGLite for local development and PostgreSQL-compatible schema design.
- Better Auth authentication.
- IndexedDB and service worker support for offline POS operation.

## Local Development

Prerequisites:

- Bun 1.3.5 or newer.

Setup:

```bash
bun install
cp apps/web/.env.example apps/web/.env
bun run db:push
bun run db:seed
bun run dev:web
```

Open:

```text
http://127.0.0.1:3001
```

Default seeded account:

```text
Email: admin@forno.local
Password: Forno123!
```

Change seeded credentials and secrets before any real deployment.

## Useful Commands

```bash
bun run dev:web       # Start the web application
bun run check-types   # TypeScript validation
bun run build         # Production build
bun run db:push       # Explicit schema application
bun run db:seed       # Idempotent FORNO seed data
cd apps/web && bun test
```

Database schema application and seed commands are explicit operational steps. Builds and server startup must not migrate, seed, reset, delete, or recreate runtime databases automatically. See [Database Safety](docs/04-database-safety.md) before changing database workflows.

## Project Structure

```text
apps/web       Web application, POS UI, APIs, database runtime, tests
packages/api   Shared API contracts
packages/auth  Authentication helpers
packages/db    Database schema exports
packages/env   Environment configuration
packages/ui    Shared UI primitives
docs           Product scope, architecture, roadmap, and safety notes
```

## Documentation

- [Product Scope](docs/01-product-scope.md)
- [Roadmap](docs/02-roadmap.md)
- [Architecture](docs/03-architecture.md)
- [Database Safety](docs/04-database-safety.md)
- [Offline POS Architecture](docs/05-offline-pos.md)

## Arabic Summary

يوفر النظام حالياً نقطة بيع للمطاعم، إدارة الطلبات، الورديات، المدفوعات النقدية، الطباعة الحرارية، العمل دون اتصال، إيصالات نقدية مؤقتة عند انقطاع الإنترنت، ومخزوناً أولياً يعتمد على الوصفات وتكلفة المنتج النظرية.

يجب تنفيذ أوامر قاعدة البيانات مثل `db:push` و `db:seed` بشكل صريح فقط. لا يقوم البناء أو تشغيل الخادم بتعديل قاعدة بيانات التشغيل تلقائياً.

## Origin and License

This project is based on [FinOpenPOS](https://github.com/JoaoHenriqueBarbosa/FinOpenPOS), licensed under MIT. The repository keeps the original license notice in [LICENSE](LICENSE).
