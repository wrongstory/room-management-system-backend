export function runBackupPlanCommand(
  argv: string[],
  io?: { stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown } },
): Promise<number>;
