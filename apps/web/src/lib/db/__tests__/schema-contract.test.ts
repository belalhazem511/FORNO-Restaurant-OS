import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { runSchemaPush } from "../../../../scripts/push-schema";
import { DATABASE_DIR_ENV, DATABASE_ROLE_ENV } from "../config";

const temporaryDirectories: string[] = [];

async function createIsolatedSchema() {
  const directory = await mkdtemp(join(tmpdir(), "forno-schema-contract-"));
  temporaryDirectories.push(directory);
  console.log(`Applying schema to isolated characterization database: ${directory}`);
  const env = {
    ...process.env,
    [DATABASE_ROLE_ENV]: "test",
    [DATABASE_DIR_ENV]: directory,
  };

  await runSchemaPush(undefined, env);
  return new PGlite(directory);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("isolated database schema contract", () => {
  it("preserves the normalized PostgreSQL-visible tables, columns, constraints, indexes, and enum values", async () => {
    const database = await createIsolatedSchema();
    try {
      const result = await database.query<{ contract: unknown }>(`
        select json_build_object(
          'tables', (
            select json_agg(table_name order by table_name)
            from information_schema.tables
            where table_schema = 'public' and table_type = 'BASE TABLE'
          ),
          'columns', (
            select json_agg(json_build_object(
              'table', table_name,
              'name', column_name,
              'type', data_type,
              'udt', udt_name,
              'length', character_maximum_length,
              'precision', numeric_precision,
              'scale', numeric_scale,
              'nullable', is_nullable,
              'default', column_default,
              'ordinal', ordinal_position
            ) order by table_name, ordinal_position)
            from information_schema.columns
            where table_schema = 'public'
          ),
          'constraints', (
            select json_agg(json_build_object(
              'table', rel.relname,
              'type', con.contype,
              'definition', pg_get_constraintdef(con.oid, true),
              'deleteRule', case con.confdeltype
                when 'a' then 'NO ACTION'
                when 'r' then 'RESTRICT'
                when 'c' then 'CASCADE'
                when 'n' then 'SET NULL'
                when 'd' then 'SET DEFAULT'
                else null
              end
            ) order by rel.relname, con.contype, pg_get_constraintdef(con.oid, true))
            from pg_constraint con
            join pg_class rel on rel.oid = con.conrelid
            join pg_namespace ns on ns.oid = rel.relnamespace
            where ns.nspname = 'public'
          ),
          'indexes', (
            select json_agg(json_build_object(
              'table', tablename,
              'name', indexname,
              'definition', indexdef
            ) order by tablename, indexname)
            from pg_indexes
            where schemaname = 'public'
          ),
          'enums', (
            select json_agg(json_build_object(
              'name', typ.typname,
              'values', (
                select json_agg(enum.enumlabel order by enum.enumsortorder)
                from pg_enum enum
                where enum.enumtypid = typ.oid
              )
            ) order by typ.typname)
            from pg_type typ
            join pg_namespace ns on ns.oid = typ.typnamespace
            where ns.nspname = 'public' and typ.typtype = 'e'
          )
        ) as contract
      `);

      const digest = createHash("sha256").update(JSON.stringify(result.rows[0]?.contract)).digest("hex");
      expect(digest).toBe("c8f1601def0eb8f87b50469ec4e8e334ed3735f0d0718d6e2114874dbe822a75");
    } finally {
      await database.close();
    }
  }, 30_000);
});
