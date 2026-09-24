import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_DIR_ENV, DATABASE_ROLE_ENV, defaultRuntimeDatabaseDir } from "../src/lib/db/config";

export type BuildRunner = (env: NodeJS.ProcessEnv) => Promise<number>;

const runNextBuild: BuildRunner = async (env) => {
  const child = Bun.spawn([process.execPath, "x", "next", "build"], {
    cwd: join(import.meta.dir, ".."),
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
};

export async function runIsolatedBuild(
  runner: BuildRunner = runNextBuild,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  const buildDatabaseDir = await mkdtemp(join(tmpdir(), "forno-build-pglite-"));
  const buildMediaDir = await mkdtemp(join(tmpdir(), "forno-build-media-"));
  if (buildDatabaseDir === defaultRuntimeDatabaseDir || buildMediaDir === defaultRuntimeDatabaseDir || buildMediaDir.startsWith(`${defaultRuntimeDatabaseDir}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("Build database/media isolation failed.");
  const env = {
    ...baseEnv,
    [DATABASE_ROLE_ENV]: "build",
    [DATABASE_DIR_ENV]: buildDatabaseDir,
    FORNO_MEDIA_DIR: buildMediaDir,
  };
  try {
    console.log(`Building with isolated temporary PGLite database: ${buildDatabaseDir}`);
    console.log(`Building with isolated temporary product media directory: ${buildMediaDir}`);
    const exitCode = await runner(env);
    if (exitCode !== 0) throw new Error(`Next.js production build failed with exit code ${exitCode}.`);
    return { buildDatabaseDir, buildMediaDir };
  } finally {
    await rm(buildDatabaseDir, { recursive: true, force: true });
    await rm(buildMediaDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runIsolatedBuild().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exit(1);
  });
}
