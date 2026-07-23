#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runFastCli } from "./cli-fast.js";
import { configureSqliteNativeBinding } from "./sqlite.js";

const require = createRequire(import.meta.url);
const sqlitePackage = require.resolve("better-sqlite3/package.json");
configureSqliteNativeBinding(resolve(dirname(sqlitePackage), "build", "Release", "better_sqlite3.node"));

await runFastCli(process.argv.slice(2));
