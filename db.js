const mysql = require("mysql2/promise");
require("dotenv").config();

const url =
  process.env.DATABASE_URL ||
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL;

console.log("DB URL exists?", !!url);

const pool = url
  ? mysql.createPool(url)
  : mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
    });

module.exports = pool;
