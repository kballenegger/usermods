// Traffic report over the request log.
// Usage: node site/bin/traffic.ts [--days 7] [--json] [--host usermods.kennethballenegger.com]
// Reads DATA_DIR/site.db (DATA_DIR default site/.data; /data in the container).

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDb, renderReport, trafficReport } from "../src/traffic.ts";

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "7" },
    json: { type: "boolean", default: false },
    host: { type: "string", default: "usermods.kennethballenegger.com" },
  },
});
const days = Number(values.days);
if (!Number.isFinite(days) || days <= 0) throw new Error(`--days must be a positive number, got ${values.days}`);

const db = openDb(resolve(process.env.DATA_DIR || "site/.data"));
const report = trafficReport(db, days, values.host);
console.log(values.json ? JSON.stringify(report, null, 2) : renderReport(report));
db.close();
