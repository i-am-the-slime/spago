import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const connectImpl = (databasePath, logger) => {
  return Promise.resolve().then(() => {
    logger("Connecting to database at " + databasePath);

    // Ensure directory exists
    try {
      const dir = path.dirname(databasePath);
      if (dir) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      // ignore - will fail later if needed
    }

    const db = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
    });

    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");

    db.prepare(`CREATE TABLE IF NOT EXISTS package_sets
      ( version TEXT PRIMARY KEY NOT NULL
      , compiler TEXT NOT NULL
      , date TEXT NOT NULL
      )`).run();
    db.prepare(`CREATE TABLE IF NOT EXISTS package_set_entries
      ( packageSetVersion TEXT NOT NULL
      , packageName TEXT NOT NULL
      , packageVersion TEXT NOT NULL
      , PRIMARY KEY (packageSetVersion, packageName, packageVersion)
      , FOREIGN KEY (packageSetVersion) REFERENCES package_sets(version)
      )`).run();
    db.prepare(`CREATE TABLE IF NOT EXISTS last_git_pull
      ( key TEXT PRIMARY KEY NOT NULL
      , date TEXT NOT NULL
      )`).run();
    db.prepare(`CREATE TABLE IF NOT EXISTS package_metadata
      ( name TEXT PRIMARY KEY NOT NULL
      , metadata TEXT NOT NULL
      , last_fetched TEXT NOT NULL
      )`).run();
    // it would be lovely if we'd have a foreign key on package_metadata, but that would
    // require reading metadata before manifests, which we can't always guarantee
    db.prepare(`CREATE TABLE IF NOT EXISTS package_manifests
      ( name TEXT NOT NULL
      , version TEXT NOT NULL
      , manifest TEXT NOT NULL
      , PRIMARY KEY (name, version)
      )`).run();
    return db;
  });
};

export const insertPackageSetImpl = (db, packageSet) => {
  return Promise.resolve().then(() => {
    db.prepare(
      "INSERT INTO package_sets (version, compiler, date) VALUES (@version, @compiler, @date)"
    ).run(packageSet);
  });
};

export const insertPackageSetEntryImpl = (db, packageSetEntry) => {
  return Promise.resolve().then(() => {
    db.prepare(
      "INSERT INTO package_set_entries (packageSetVersion, packageName, packageVersion) VALUES (@packageSetVersion, @packageName, @packageVersion)"
    ).run(packageSetEntry);
  });
};

export const selectLatestPackageSetByCompilerImpl = (db, compiler) => {
  return Promise.resolve().then(() => {
    const row = db
      .prepare("SELECT * FROM package_sets WHERE compiler = ? ORDER BY date DESC LIMIT 1")
      .get(compiler);
    return row;
  });
};

export const selectPackageSetsImpl = (db) => {
  return Promise.resolve().then(() => {
    const rows = db.prepare("SELECT * FROM package_sets ORDER BY date ASC").all();
    return rows;
  });
};

export const selectPackageSetEntriesBySetImpl = (db, packageSetVersion) => {
  return Promise.resolve().then(() => {
    const rows = db
      .prepare("SELECT * FROM package_set_entries WHERE packageSetVersion = ?")
      .all(packageSetVersion);
    return rows;
  });
};

export const selectPackageSetEntriesByPackageImpl = (db, packageName, packageVersion) => {
  return Promise.resolve().then(() => {
    const rows = db
      .prepare("SELECT * FROM package_set_entries WHERE packageName = ? AND packageVersion = ?")
      .all(packageName, packageVersion);
    return rows;
  });
};

export const getLastPullImpl = (db, key) => {
  return Promise.resolve().then(() => {
    const row = db
      .prepare("SELECT * FROM last_git_pull WHERE key = ? LIMIT 1")
      .get(key);
    return row?.date;
  });
};

export const updateLastPullImpl = (db, key, date) => {
  return Promise.resolve().then(() => {
    db.prepare("INSERT OR REPLACE INTO last_git_pull (key, date) VALUES (?, ?)").run(key, date);
  });
};

export const getManifestImpl = (db, name, version) => {
  return Promise.resolve().then(() => {
    const row = db
      .prepare("SELECT * FROM package_manifests WHERE name = ? AND version = ? LIMIT 1")
      .get(name, version);
    return row?.manifest;
  });
};

export const insertManifestImpl = (db, name, version, manifest) => {
  return Promise.resolve().then(() => {
    db.prepare("INSERT OR IGNORE INTO package_manifests (name, version, manifest) VALUES (?, ?, ?)").run(
      name,
      version,
      manifest
    );
  });
};

export const removeManifestImpl = (db, name, version) => {
  return Promise.resolve().then(() => {
    db.prepare("DELETE FROM package_manifests WHERE name = ? AND version = ?").run(name, version);
  });
};

export const insertMetadataImpl = (db, name, metadata, last_fetched) => {
  return Promise.resolve().then(() => {
    db.prepare(
      "INSERT OR REPLACE INTO package_metadata (name, metadata, last_fetched) VALUES (@name, @metadata, @last_fetched)"
    ).run({ name, metadata, last_fetched });
  });
};

export const getMetadataForPackagesImpl = (db, names) => {
  return Promise.resolve().then(() => {
    // There can be a lot of package names here, potentially hitting the max number of sqlite parameters, so we use json to bypass this
    const query = db.prepare("SELECT * FROM package_metadata WHERE name IN (SELECT value FROM json_each(?));");
    return query.all(JSON.stringify(names));
  });
};