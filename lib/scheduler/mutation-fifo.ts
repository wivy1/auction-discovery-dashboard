export interface MutationFifoReceipt<T> {
  readonly sequence: number;
  readonly label: string;
  readonly value: T;
}

/** Serializes only canonical mutation boundaries while external work overlaps. */
export class MutationFifo {
  #tail: Promise<void> = Promise.resolve();
  #sequence = 0;
  #order: string[] = [];

  get order(): readonly string[] {
    return Object.freeze([...this.#order]);
  }

  run<T>(label: string, operation: () => Promise<T>): Promise<MutationFifoReceipt<T>> {
    const sequence = ++this.#sequence;
    const execute = async (): Promise<MutationFifoReceipt<T>> => {
      const value = await operation();
      this.#order.push(label);
      return Object.freeze({ sequence, label, value });
    };
    const result = this.#tail.then(execute, execute);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async idle(): Promise<void> {
    await this.#tail;
  }
}
