
import "dotenv/config";
import { Pool } from "pg";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not defined");
}

pg.types.setTypeParser(20, (value) => Number(value));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});