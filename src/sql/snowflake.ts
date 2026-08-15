import { bigint } from "drizzle-orm/pg-core";
import { Snowyflake } from "snowyflake";

/**
 * The generator backing `snowflakeId()`.
 *
 * Built with snowyflake's defaults: the Unix epoch, worker id 0 and process id 0.
 * Those defaults assume a single writing process — see `snowflakeId` for what to
 * do when that stops being true.
 */
export const snowflake = new Snowyflake();

/**
 * A `bigint` primary key defaulted to a Snowflake, generated in the application.
 *
 * Nothing else in `/sql` depends on this: `buildRepository` reads the type of the
 * `id` column off the table, so a `uuid` or `text` key works just as well and an
 * app that wants one simply does not import this helper. It is a default, not a
 * requirement.
 *
 * Generating the id application-side rather than in the database means an insert
 * knows its own id before the round trip, and ids sort by creation time.
 *
 * @param generator - Overrides the id source. The shared `snowflake` instance
 *   uses worker id 0 and process id 0, which two processes writing in the same
 *   millisecond would eventually collide on: a deployment that writes from
 *   several processes must pass a generator per process, each with its own
 *   `workerId`/`processId`.
 * @returns The Drizzle column: `bigint` mode `bigint`, not null, primary key.
 *
 * @example
 * ```ts
 * export const users = pgTable("users", {
 *   id: snowflakeId(),
 *   name: text().notNull(),
 * });
 *
 * // one generator per writing process
 * const ids = new Snowyflake({ workerId: BigInt(process.env.WORKER_ID) });
 * export const events = pgTable("events", {
 *   id: snowflakeId(() => ids.nextId()),
 * });
 * ```
 */
export const snowflakeId = (
  generator: () => bigint = () => snowflake.nextId(),
) => bigint({ mode: "bigint" }).$defaultFn(generator).notNull().primaryKey();
