interface RuntimeReadinessStatement {
  first(): Promise<Record<string, unknown> | null>;
  run(): Promise<{ readonly meta?: { readonly changes?: number } }>;
}

export interface RuntimeReadinessDatabase {
  prepare(sql: string): RuntimeReadinessStatement;
}

export interface RuntimeDatabaseReadiness {
  readonly readable: true;
  readonly writable: true;
}

export type RuntimeDatabaseReadinessStage = "read" | "write";

export class RuntimeDatabaseReadinessError extends Error {
  readonly stage: RuntimeDatabaseReadinessStage;

  constructor(
    stage: RuntimeDatabaseReadinessStage,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeDatabaseReadinessError";
    this.stage = stage;
  }
}

/**
 * Reads on every health check, but exercises the bound database's write path
 * only once for the lifetime of the Worker instance.
 */
export function createRuntimeDatabaseReadiness(): (
  database: RuntimeReadinessDatabase,
) => Promise<RuntimeDatabaseReadiness> {
  let writeProof: Promise<true> | null = null;
  return async (database) => {
    let readable: Record<string, unknown> | null;
    try {
      readable = await database.prepare("SELECT 1 AS ok").first();
    } catch (cause) {
      throw new RuntimeDatabaseReadinessError(
        "read",
        "D1 read probe unavailable",
        { cause },
      );
    }
    if (Number(readable?.ok) !== 1) {
      throw new RuntimeDatabaseReadinessError("read", "D1 read probe failed");
    }

    const currentWriteProof = writeProof ??= proveWritable(database);
    try {
      await currentWriteProof;
    } catch (error) {
      if (writeProof === currentWriteProof) writeProof = null;
      throw error;
    }
    return { readable: true, writable: true };
  };
}

async function proveWritable(database: RuntimeReadinessDatabase): Promise<true> {
  let result: Awaited<ReturnType<RuntimeReadinessStatement["run"]>>;
  try {
    result = await database.prepare(`
      UPDATE pipeline_run_lease
      SET expires_at = expires_at
      WHERE singleton = 0
    `).run();
  } catch (cause) {
    throw new RuntimeDatabaseReadinessError(
      "write",
      "D1 write probe unavailable",
      { cause },
    );
  }
  if (Number(result.meta?.changes ?? -1) !== 0) {
    throw new RuntimeDatabaseReadinessError(
      "write",
      "D1 write probe changed a row",
    );
  }
  return true;
}
