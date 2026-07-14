import dotenv from "dotenv";
dotenv.config();

export function loadEnv(query: string): string {
  return process.env[query] ?? '';
}