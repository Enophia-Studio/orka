---
name: database-migrations
description: Changing a database schema or moving data with migrations (plain SQL, or tools such as Prisma, Django, Rails, EF Core, Alembic, Flyway). Use when adding, renaming or removing tables, columns or indexes, or when backfilling data.
license: MIT
---

# Database migrations

## Before writing one
- Find the project's migration tool and how migrations run (a CLI command, on app start, in CI), and read the last few migrations to match their style and naming.
- Let the tool generate the migration when it can (`prisma migrate dev`, `makemigrations`, `alembic revision --autogenerate`, `dotnet ef migrations add`), then read and fix what it wrote. Never edit a migration that has already run in a shared environment; add a new one.
- Ask how large the affected tables are in production when it matters. A change that is instant on a dev database can lock a big table for minutes.

## Safe changes on a live system
- Expand, migrate, contract: add the new structure, deploy code that writes both and reads the new one, backfill, then remove the old structure in a later release. Old and new versions of the app run side by side during a deploy.
- Adding a column: nullable or with a constant default; make it NOT NULL only after the backfill.
- Renaming a column or table: add, copy, switch readers, then drop, unless every reader deploys at the same moment.
- Removing: stop using it in code, release, then drop it.
- Indexes on big tables: create them concurrently or online where the database supports it (`CREATE INDEX CONCURRENTLY` in PostgreSQL, `ONLINE = ON` in SQL Server), outside a transaction if required.
- Backfills: in batches with a limit, idempotent so they can resume, and separate from the schema migration when they are slow.
- New constraints on existing data: add them unvalidated first, then validate, where the database allows it.

## Reversibility and data
- Write the down migration when the tool supports it, and say plainly when a step cannot be undone (dropping a column loses its data).
- Never put real personal data or secrets in migrations or seed files.

## Check
- Run the migration up (and down, if supported) on a fresh database and on one at the previous version, then run the tests against the result.
- Show the user the SQL that will run, and call out locks, long steps, irreversible steps and the deploy order the change needs.
