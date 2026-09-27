/** An error meant for the user: printed without a stack trace. */
export class LrError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "LrError";
  }
}
