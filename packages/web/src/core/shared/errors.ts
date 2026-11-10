import { ApiError } from '../../kernel/api';

export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Every problem the server listed for a rejected write, or the error's own message. */
export function problemsOf(error: unknown): string[] {
  if (error instanceof ApiError) {
    return error.problems;
  }
  return [messageOf(error)];
}
