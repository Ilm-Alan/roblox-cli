export type CliOutcome = 'success' | 'error' | 'not_executed' | 'unknown';

export class CliCommandError extends Error {
  readonly statusCode: number;
  readonly outcome: CliOutcome;
  readonly details?: Record<string, unknown>;

  constructor(
    readonly code: string,
    message: string,
    options: {
      statusCode?: number;
      outcome?: CliOutcome;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'CliCommandError';
    this.statusCode = options.statusCode ?? 400;
    this.outcome = options.outcome ?? 'not_executed';
    this.details = options.details;
  }
}
