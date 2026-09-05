export class DomainValidationError extends Error {
  readonly field?: string;

  constructor(message: string, field?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DomainValidationError";
    this.field = field;
  }
}

