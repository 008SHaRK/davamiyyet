const { Pool } = require("pg");
require("dotenv").config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.log("❌ DATABASE_URL yoxdur. Render Environment-də DATABASE_URL yazmalısan.");
}

const pool = new Pool({
  connectionString,
  ssl: connectionString?.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

module.exports = pool;
