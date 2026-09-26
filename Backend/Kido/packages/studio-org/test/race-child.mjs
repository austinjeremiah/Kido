// One competing process. Opens the shared database, waits on a barrier file so every sibling
// starts inside the same instant, then attempts exactly one reservation and reports the outcome.
import DatabaseCtor from "better-sqlite3";
import { existsSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("ts-node-less", { parentURL: import.meta.url }); // placeholder, replaced below
