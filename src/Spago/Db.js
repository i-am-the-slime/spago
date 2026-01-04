import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";

const createStatements = [
  `CREATE TABLE IF NOT EXISTS package_sets
    ( version TEXT PRIMARY KEY NOT NULL
    , compiler TEXT NOT NULL
    , date TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS package_set_entries
    ( packageSetVersion TEXT NOT NULL
    , packageName TEXT NOT NULL
    , packageVersion TEXT NOT NULL
    , PRIMARY KEY (packageSetVersion, packageName, packageVersion)
    , FOREIGN KEY (packageSetVersion) REFERENCES package_sets(version)
    )`,
  `CREATE TABLE IF NOT EXISTS last_git_pull
    ( key TEXT PRIMARY KEY NOT NULL
    , date TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS package_metadata
    ( name TEXT PRIMARY KEY NOT NULL
    , metadata TEXT NOT NULL
    , last_fetched TEXT NOT NULL
    )`,
  // it would be lovely if we'd have a foreign key on package_metadata, but that would
  // require reading metadata before manifests, which we can't always guarantee
  `CREATE TABLE IF NOT EXISTS package_manifests
    ( name TEXT NOT NULL
    , version TEXT NOT NULL
    , manifest TEXT NOT NULL
    , PRIMARY KEY (name, version)
    )`,
];

const ensureLocalDirectory = (filePath) => {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (err) {
    // ignore filesystem errors here; connect will fail and report later
  }
};

const toRows = (result) => result?.rows ?? [];

export const connectImpl = async (databasePath, logger) => {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoAuthToken = process.env.TURSO_AUTH_TOKEN;
  const url = tursoUrl ?? `file:${databasePath}`;

  if (!tursoUrl) {
    ensureLocalDirectory(databasePath);
    logger("Connecting to local libSQL file at " + databasePath);
  } else {
    logger("Connecting to Turso at " + tursoUrl);
  }

  const db = createClient({ url, authToken: tursoAuthToken });

  await db.execute("PRAGMA foreign_keys = ON");
  for (const statement of createStatements) {
    await db.execute(statement);
  }

  return db;
};

const executeStmt = async (db, sql, args = []) => {
  if (typeof db.prepare === "function") {
    const stmt = await db.prepare(sql);
    return stmt.execute(args);
  }
  // Fallback to execute for client implementations without prepare
  return db.execute({ sql, args });
};

const getRow = async (db, sql, args = []) => {
  const result = await executeStmt(db, sql, args);
  return toRows(result)[0];
};

const getRows = async (db, sql, args = []) => {
  const result = await executeStmt(db, sql, args);
  return toRows(result);
};

const run = (db, sql, args = []) => executeStmt(db, sql, args);

export const insertPackageSetImpl = (db, packageSet) =>
  run(db, "INSERT INTO package_sets (version, compiler, date) VALUES (?, ?, ?)", [
    packageSet.version,
    packageSet.compiler,
    packageSet.date,
  ]);

export const insertPackageSetEntryImpl = (db, packageSetEntry) =>
  run(
    db,
    "INSERT INTO package_set_entries (packageSetVersion, packageName, packageVersion) VALUES (?, ?, ?)",
    [packageSetEntry.packageSetVersion, packageSetEntry.packageName, packageSetEntry.packageVersion]
  );

export const selectLatestPackageSetByCompilerImpl = (db, compiler) =>
  getRow(
    db,
    "SELECT * FROM package_sets WHERE compiler = ? ORDER BY date DESC LIMIT 1",
    [compiler]
  );

export const selectPackageSetsImpl = (db) =>
  getRows(db, "SELECT * FROM package_sets ORDER BY date ASC");

export const selectPackageSetEntriesBySetImpl = (db, packageSetVersion) =>
  getRows(db, "SELECT * FROM package_set_entries WHERE packageSetVersion = ?", [packageSetVersion]);

export const selectPackageSetEntriesByPackageImpl = (db, packageName, packageVersion) =>
  getRows(
    db,
    "SELECT * FROM package_set_entries WHERE packageName = ? AND packageVersion = ?",
    [packageName, packageVersion]
  );

export const getLastPullImpl = async (db, key) => {
  const row = await getRow(db, "SELECT * FROM last_git_pull WHERE key = ? LIMIT 1", [key]);
  return row?.date ?? null;
};

export const updateLastPullImpl = (db, key, date) =>
  run(db, "INSERT OR REPLACE INTO last_git_pull (key, date) VALUES (?, ?)", [key, date]);

export const getManifestImpl = async (db, name, version) => {
  const row = await getRow(
    db,
    "SELECT * FROM package_manifests WHERE name = ? AND version = ? LIMIT 1",
    [name, version]
  );
  return row?.manifest ?? null;
};

export const insertManifestImpl = (db, name, version, manifest) =>
  run(db, "INSERT OR IGNORE INTO package_manifests (name, version, manifest) VALUES (?, ?, ?)", [
    name,
    version,
    manifest,
  ]);

export const removeManifestImpl = (db, name, version) =>
  run(db, "DELETE FROM package_manifests WHERE name = ? AND version = ?", [name, version]);

export const insertMetadataImpl = (db, name, metadata, last_fetched) =>
  run(db, "INSERT OR REPLACE INTO package_metadata (name, metadata, last_fetched) VALUES (?, ?, ?)", [
    name,
    metadata,
    last_fetched,
  ]);

export const getMetadataImpl = (db, name) =>
  getRow(db, "SELECT * FROM package_metadata WHERE name = ? LIMIT 1", [name]);

export const getMetadataForPackagesImpl = (db, names) =>
  getRows(db, "SELECT * FROM package_metadata WHERE name IN (SELECT value FROM json_each(?))", [
    JSON.stringify(names),
  ]);