/**
 * Registered query templates.
 *
 * The runtime agent NEVER supplies GraphQL. It names a template and supplies typed variables, which
 * are bound as GraphQL variables rather than interpolated into the query string.
 *
 * Two reasons, and the second is the one that matters.
 *
 * The obvious one is injection: string-built queries let an agent that has been prompt-injected
 * reshape a query into one that reads whatever it likes.
 *
 * The subtler one is that a query IS the data contract. If the agent writes the query, the shape of
 * the response is whatever the agent asked for, and `normalize()` has nothing stable to normalize.
 * Provenance, units and freshness all depend on knowing what was requested — so the query is part of
 * the adapter, not part of the agent's input.
 */

export interface QueryTemplate {
  id: string;
  description: string;
  /** The data kind the normalized observation carries. */
  dataKind: string;
  unit: string;
  decimals: number;
  /** GraphQL document. Variables are bound, never interpolated. */
  document: string;
  /** Declared variables and their primitive types, validated before the request is sent. */
  variables: Record<string, "address" | "string" | "int" | "bigint">;
  /** JSON path to the value in the response, as path segments. */
  valuePath: string[];
}

/** Every subgraph query asks for `_meta` so block lag is always measurable. */
const META = `_meta { deployment block { number hash timestamp } hasIndexingErrors }`;

export const QUERY_TEMPLATES: Record<string, QueryTemplate> = {
  "account-token-balance": {
    id: "account-token-balance",
    description: "Current indexed token balance for an account.",
    dataKind: "indexed_token_balance",
    unit: "base-units",
    decimals: 0,
    document: `query AccountTokenBalance($account: String!, $token: String!) {
  ${META}
  accountBalances(where: { account: $account, token: $token }, first: 1) {
    id
    amount
  }
}`,
    variables: { account: "address", token: "address" },
    valuePath: ["accountBalances", "0", "amount"],
  },

  "historical-swap-volume": {
    id: "historical-swap-volume",
    description: "Aggregate swap volume for an account over a window of days.",
    dataKind: "historical_swap_volume",
    unit: "USD",
    decimals: 6,
    document: `query HistoricalSwapVolume($account: String!, $since: Int!) {
  ${META}
  swaps(where: { origin: $account, timestamp_gte: $since }, first: 1000, orderBy: timestamp, orderDirection: desc) {
    id
    amountUSD
  }
}`,
    variables: { account: "address", since: "int" },
    valuePath: ["swaps"],
  },

  "pool-liquidity": {
    id: "pool-liquidity",
    description: "Current indexed liquidity for a pool.",
    dataKind: "indexed_pool_liquidity",
    unit: "base-units",
    decimals: 0,
    document: `query PoolLiquidity($pool: String!) {
  ${META}
  pool(id: $pool) {
    id
    liquidity
  }
}`,
    variables: { pool: "address" },
    valuePath: ["pool", "liquidity"],
  },

  "pool-liquidity-at-block": {
    id: "pool-liquidity-at-block",
    description: "Indexed liquidity for a pool as it stood at a given block, for a snapshot anchored there.",
    dataKind: "indexed_pool_liquidity",
    unit: "base-units",
    decimals: 0,
    // `_meta(block:)` answers with the number only; the gateway transport fills the hash and
    // timestamp in from the caller's RPC so the observation is still dated by its source.
    document: `query PoolLiquidityAtBlock($pool: String!, $block: Int!) {
  _meta(block: { number: $block }) { deployment block { number hash timestamp } hasIndexingErrors }
  pool(id: $pool, block: { number: $block }) {
    id
    liquidity
  }
}`,
    variables: { pool: "address", block: "int" },
    valuePath: ["pool", "liquidity"],
  },

  "historical-portfolio-activity": {
    id: "historical-portfolio-activity",
    description: "Count of an account's transfers over a window, for portfolio activity analysis.",
    dataKind: "historical_portfolio_activity",
    unit: "count",
    decimals: 0,
    document: `query HistoricalPortfolioActivity($account: String!, $since: Int!) {
  ${META}
  transfers(where: { from: $account, timestamp_gte: $since }, first: 1000) {
    id
    value
  }
}`,
    variables: { account: "address", since: "int" },
    valuePath: ["transfers"],
  },
};

export class QueryTemplateError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "QueryTemplateError";
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Validate variables against a template.
 *
 * Rejects anything that is not the declared primitive type, and rejects unexpected variables
 * outright rather than dropping them — an unexpected variable means the caller believes it is
 * asking for something this query does not do.
 */
export function bindVariables(
  template: QueryTemplate,
  variables: Record<string, unknown>,
): Record<string, string | number> {
  const bound: Record<string, string | number> = {};
  for (const [name, type] of Object.entries(template.variables)) {
    const v = variables[name];
    if (v === undefined || v === null) {
      throw new QueryTemplateError("GRAPH-VAR-MISSING", `template "${template.id}" requires variable "${name}"`);
    }
    switch (type) {
      case "address": {
        if (typeof v !== "string" || !ADDRESS.test(v)) {
          throw new QueryTemplateError("GRAPH-VAR-TYPE", `"${name}" must be a 20-byte address`);
        }
        // Subgraphs index addresses lowercased. Passing a checksummed address silently matches
        // nothing, which reads as "no activity" rather than as an error.
        bound[name] = v.toLowerCase();
        break;
      }
      case "int": {
        if (typeof v !== "number" || !Number.isInteger(v)) {
          throw new QueryTemplateError("GRAPH-VAR-TYPE", `"${name}" must be an integer`);
        }
        bound[name] = v;
        break;
      }
      case "bigint": {
        if (typeof v !== "string" || !/^\d+$/.test(v)) {
          throw new QueryTemplateError("GRAPH-VAR-TYPE", `"${name}" must be an integer string`);
        }
        bound[name] = v;
        break;
      }
      case "string": {
        if (typeof v !== "string") {
          throw new QueryTemplateError("GRAPH-VAR-TYPE", `"${name}" must be a string`);
        }
        /*
         * Even though this is bound as a GraphQL variable and cannot escape into the document, a
         * string carrying GraphQL syntax means the caller believes it is composing a query. Refusing
         * it surfaces that misunderstanding instead of silently searching for a literal brace.
         */
        if (/[{}]|\.\.\.|__schema/.test(v)) {
          throw new QueryTemplateError("GRAPH-VAR-SUSPECT", `"${name}" contains GraphQL syntax`);
        }
        bound[name] = v;
        break;
      }
    }
  }

  const unexpected = Object.keys(variables).filter((k) => !(k in template.variables));
  if (unexpected.length > 0) {
    throw new QueryTemplateError(
      "GRAPH-VAR-UNEXPECTED",
      `template "${template.id}" does not accept ${unexpected.join(", ")}`,
    );
  }
  return bound;
}

export function templateById(id: string): QueryTemplate {
  const t = QUERY_TEMPLATES[id];
  if (!t) {
    throw new QueryTemplateError(
      "GRAPH-TEMPLATE-UNKNOWN",
      `no registered query template "${id}"; arbitrary GraphQL is not accepted`,
    );
  }
  return t;
}
