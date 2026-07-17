import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = fs.readFileSync(path.join(
  root,
  "supabase/migrations/20260717050000_pipeline_operations.sql",
), "utf8");
const schedule = fs.readFileSync(path.join(
  root,
  "supabase/templates/pipeline-operations-cron.sql",
), "utf8");

describe("pipeline operations database contract", () => {
  it("keeps retention, health, and Storage cleanup behind fixed service RPCs", () => {
    expect(migration).toMatch(/create table private\.pipeline_storage_cleanup_jobs/i);
    expect(migration).toMatch(/create table private\.pipeline_cleanup_runs/i);
    expect(migration).toMatch(/create or replace function public\.prepare_pipeline_retention/i);
    expect(migration).toMatch(/create or replace function public\.claim_pipeline_storage_cleanup/i);
    expect(migration).toMatch(/create or replace function public\.pipeline_operations_health/i);
    expect(migration).toMatch(/for update skip locked/i);
    expect(migration).toMatch(/pgmq\.metrics\('pipeline_jobs'\)/i);
    expect(migration).toMatch(/status in \('succeeded', 'failed', 'canceled'\)/i);
    expect(migration).toMatch(/not exists[\s\S]+public\.listings/i);
    expect(migration).toMatch(/create or replace function public\.retry_pipeline_run/i);
    expect(migration).toMatch(/v_run\.retention_cleaned_at is not null/i);
    expect(migration).toMatch(/This saved run has expired\. Start a new capture\./i);
    expect(migration).toMatch(
      /for v_item in[\s\S]*?for update of item skip locked[\s\S]*?loop[\s\S]*?perform run\.id[\s\S]*?order by run\.id[\s\S]*?for update;[\s\S]*?status in \('queued', 'running', 'retrying', 'succeeded'\)[\s\S]*?continue;[\s\S]*?update public\.pipeline_runs[\s\S]*?retention_cleaned_at = statement_timestamp\(\)[\s\S]*?update public\.items/i,
    );
  });

  it("ships only an inactive Vault + Cron + pg_net activation template", () => {
    expect(schedule).toMatch(/vault\.create_secret/i);
    expect(schedule).toMatch(/vault\.decrypted_secrets/i);
    expect(schedule).toMatch(/cron\.schedule/i);
    expect(schedule).toMatch(/net\.http_post/i);
    expect(schedule).toMatch(/\/api\/internal\/pipeline-worker/i);
    expect(schedule).toMatch(/\/api\/internal\/pipeline-maintenance/i);
    expect(schedule).toMatch(/OWNER MUST REPLACE/i);
    expect(schedule).not.toMatch(/[a-f0-9]{64}/i);
    expect(migration).not.toMatch(/cron\.schedule/i);
    expect(migration).not.toMatch(/net\.http_post/i);
  });
});
