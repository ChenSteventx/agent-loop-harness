import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

type Sqlite = InstanceType<typeof Database>;

let configuredNativeBinding: string | null = null;

// The bundled CLI resolves the already-installed native addon once so the
// module bundle need not re-run package discovery in every short-lived CLI
// process. Normal library and source callers leave this unset and retain
// better-sqlite3's standard resolution behavior.
export function configureSqliteNativeBinding(path: string): void {
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) {
    throw new Error("SQLite native binding must be an existing absolute file");
  }
  if (configuredNativeBinding !== null && configuredNativeBinding !== path) {
    throw new Error("SQLite native binding was already configured");
  }
  configuredNativeBinding = path;
}

export function openSqliteDatabase(path: string, options: { readOnly?: boolean } = {}): Sqlite {
  const databaseOptions = {
    ...(options.readOnly ? { readonly: true, fileMustExist: true } : {}),
    ...(configuredNativeBinding ? { nativeBinding: configuredNativeBinding } : {}),
  };
  return new Database(path, databaseOptions);
}
