import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";

/**
 * The slice of the Drizzle Effect database the SQL helpers actually use.
 *
 * A transaction handle satisfies this type too — `EffectPgTransaction` extends
 * `EffectPgDatabase` — which is what lets a repository be rebound to a running
 * transaction with `withTx`, and what lets `paginate` be handed either one.
 */
export type SqlExecutor = Pick<
  EffectPgDatabase<any, any>,
  "select" | "insert" | "update" | "delete"
>;
