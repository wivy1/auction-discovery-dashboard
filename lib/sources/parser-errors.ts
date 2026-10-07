import { SourceAdapterError, type SourceId } from "./types";

/** The same synchronous parser boundary is used by discovery and native replay. */
export function invokeSourceParser<Result>(sourceId: SourceId, parse: () => Result): Result {
  try {
    return parse();
  } catch (error) {
    if (error instanceof SourceAdapterError) throw error;
    if (error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError) {
      throw new SourceAdapterError(sourceId, error.message, { cause: error });
    }
    throw error;
  }
}
