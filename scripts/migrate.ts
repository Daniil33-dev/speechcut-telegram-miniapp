import { openDatabase } from "../src/server/db";
import { config } from "../src/server/config";
const db = openDatabase(config().dbPath);
console.log({ migrations: db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() }); db.close();
