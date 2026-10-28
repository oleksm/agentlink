import {z} from "zod";
const text = z.string().trim().min(1);
export const configSchema = z.strictObject({
  version: z.literal(1),
  name: text,
  port: z.number().int().min(0).max(65535),
  headless: z.boolean().default(false),
  tickSeconds: z.number().int().min(1).max(3600),
});
export type Config = z.infer<typeof configSchema>;
