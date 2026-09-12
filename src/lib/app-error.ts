export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly headers?: Readonly<Record<string, string>>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

