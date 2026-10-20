import pg from "pg";

pg.types.setTypeParser(20, (value) => Number(value));

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env, or run the stack " +
      "with docker compose."
  );
}

export const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.DB_POOL_MAX ?? 10),
});