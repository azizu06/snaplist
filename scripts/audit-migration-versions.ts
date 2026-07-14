import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migrationsDirectory = fileURLToPath(
  new URL("../supabase/migrations/", import.meta.url),
);
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const migrationsByVersion = new Map<string, string[]>();
const invalidFilenames: string[] = [];

for (const file of migrationFiles) {
  const match = /^(\d{14})_.+\.sql$/.exec(file);
  if (!match) {
    invalidFilenames.push(file);
    continue;
  }

  const [version] = match.slice(1);
  migrationsByVersion.set(version, [
    ...(migrationsByVersion.get(version) ?? []),
    file,
  ]);
}

const duplicateVersions = [...migrationsByVersion.entries()].filter(
  ([, files]) => files.length > 1,
);

if (invalidFilenames.length > 0 || duplicateVersions.length > 0) {
  console.error("Supabase migration version audit failed.");

  if (invalidFilenames.length > 0) {
    console.error("Invalid migration filename(s):");
    for (const file of invalidFilenames) console.error(`  ${file}`);
  }

  if (duplicateVersions.length > 0) {
    console.error("Duplicate migration version(s):");
    for (const [version, files] of duplicateVersions) {
      console.error(`  ${version}: ${files.join(", ")}`);
    }
  }

  process.exitCode = 1;
} else {
  console.log(
    `Supabase migration version audit passed: ${migrationFiles.length} files, ${migrationsByVersion.size} unique versions.`,
  );
}
