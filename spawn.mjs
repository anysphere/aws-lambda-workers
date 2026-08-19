#!/usr/bin/env node
/** CLI spawn hook: submit one RunMicrovm and exit. Does not wait for the agent. */
import { spawnSync } from "node:child_process";

function req(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const payload = JSON.stringify({
  CURSOR_WORKER_NAME: req("CURSOR_WORKER_NAME"),
  CURSOR_POOL: process.env.CURSOR_POOL || process.env.POOL_NAME || "default",
  CURSOR_REPO_URL: process.env.CURSOR_REPO_URL || "",
  CURSOR_REPO_OWNER: process.env.CURSOR_REPO_OWNER || "",
  CURSOR_REPO_NAME: process.env.CURSOR_REPO_NAME || "",
  CURSOR_REQUEST_ID: process.env.CURSOR_REQUEST_ID || "",
  CURSOR_API_KEY_PARAM_NAME: process.env.CURSOR_API_KEY_PARAM_NAME || "",
});

const result = spawnSync(
  "aws",
  [
    "lambda-microvms",
    "run-microvm",
    "--region",
    region,
    "--image-identifier",
    req("MICROVM_IMAGE_IDENTIFIER"),
    "--execution-role-arn",
    req("MICROVM_EXECUTION_ROLE_ARN"),
    "--run-hook-payload",
    payload,
    "--maximum-duration-in-seconds",
    "28800",
    "--ingress-network-connectors",
    `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
    "--egress-network-connectors",
    `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
  ],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status === 0 ? 0 : 1);
