import { z } from "zod";
import { execFileSync } from "node:child_process";
export const resourceBudgetSchema = z.strictObject({
  cpuPercent: z.number().int().min(1).max(10000).default(100),
  memoryMiB: z.number().int().min(64).max(1048576).default(1024),
});
export type ResourceBudget = z.infer<typeof resourceBudgetSchema>;
export const defaultResourceBudget: ResourceBudget = {
  cpuPercent: 100,
  memoryMiB: 1024,
};
export function requireResourceEnforcement(): void {
  if (process.platform !== "linux")
    throw Error(
      "Resource enforcement requires Linux cgroups and a user systemd manager",
    );
  try {
    execFileSync("systemctl", ["--user", "show-environment"], {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {
    throw Error(
      "Resource enforcement unavailable: no reachable user systemd manager; experiment was not launched",
    );
  }
}
